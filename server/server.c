#include "file_utils.h"
#include "group.h"
#include "net_utils.h"
#include "protocol.h"
#include "user.h"

#include <arpa/inet.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define DEFAULT_TCP_PORT 9000
#define DEFAULT_UDP_PORT 9001
#define LISTEN_BACKLOG 32
#define MAX_ONLINE_SNAPSHOT 256

typedef struct ServerState {
    UserStore users;
    GroupStore groups;
    int listen_fd;
    int udp_fd;
    int udp_port;
    volatile sig_atomic_t running;
} ServerState;

typedef struct ClientContext {
    ServerState *state;
    int fd;
} ClientContext;

static ServerState g_state;

static void cleanup_offline_fd(ServerState *state, int fd);
static void push_group_event(ServerState *state, const char *event,
                             const GroupSnapshot *snapshot);

static int send_text_response(int fd, int type, const char *message) {
    Packet packet;
    return packet_set_text(&packet, type, "server", "", message) == 0
               ? send_packet(fd, &packet)
               : -1;
}

static void handle_register(ServerState *state, int fd, const Packet *packet) {
    int rc;
    const char *password = (const char *)packet->data;

    rc = user_store_register(&state->users, packet->sender, password);
    if (rc == USER_OK) {
        send_text_response(fd, MSG_OK, "注册成功");
    } else {
        send_text_response(fd, MSG_ERROR, user_result_message(rc));
    }
}

static void handle_login(ServerState *state, int fd, const Packet *packet) {
    int rc;
    const char *password = (const char *)packet->data;

    rc = user_store_login(&state->users, packet->sender, password, fd);
    if (rc == USER_OK) {
        send_text_response(fd, MSG_OK, "登录成功");
    } else {
        send_text_response(fd, MSG_ERROR, user_result_message(rc));
    }
}

static void handle_online_list(ServerState *state, int fd) {
    char list[PACKET_DATA_MAX];
    int rc = user_store_online_list(&state->users, list, sizeof(list));

    if (rc == USER_OK) {
        send_text_response(fd, MSG_ONLINE_LIST, list);
    } else {
        send_text_response(fd, MSG_ERROR, user_result_message(rc));
    }
}

static const char *packet_text_data(const Packet *packet) {
    if (packet == NULL || packet->length == 0 ||
        packet->length > PACKET_DATA_MAX ||
        packet->data[packet->length - 1] != '\0') {
        return NULL;
    }
    return (const char *)packet->data;
}

static void send_group_payload_to_fd(ServerState *state, int fd, int type,
                                     const char *sender,
                                     const char *receiver,
                                     const GroupPayload *payload) {
    Packet packet;

    if (payload == NULL ||
        packet_init(&packet, type, sender, receiver, payload->data,
                    payload->length) != 0 ||
        send_packet(fd, &packet) < 0) {
        cleanup_offline_fd(state, fd);
    }
}

static void push_group_event(ServerState *state, const char *event,
                             const GroupSnapshot *snapshot) {
    GroupPayload payload;

    if (group_payload_build_event(event, snapshot, &payload) != GROUP_OK) {
        return;
    }
    for (size_t i = 0; i < snapshot->member_count; ++i) {
        int member_fd;
        if (user_store_get_fd(&state->users, snapshot->members[i],
                              &member_fd) == USER_OK) {
            send_group_payload_to_fd(state, member_fd, MSG_GROUP_EVENT,
                                     "server", snapshot->id, &payload);
        }
    }
}

static void cleanup_offline_fd(ServerState *state, int fd) {
    char username[USERNAME_MAX_LEN];
    GroupChange changes[GROUP_EVENT_MAX_CHANGES];
    size_t change_count = 0;

    if (state == NULL) {
        return;
    }
    if (user_store_username_by_fd(&state->users, fd, username,
                                  sizeof(username)) != USER_OK) {
        user_store_logout_fd(&state->users, fd);
        return;
    }

    group_store_remove_member(&state->groups, username, changes,
                              GROUP_EVENT_MAX_CHANGES, &change_count);
    user_store_logout_fd(&state->users, fd);
    for (size_t i = 0; i < change_count; ++i) {
        push_group_event(state, changes[i].event, &changes[i].group);
    }
}

static void handle_private(ServerState *state, int fd, const Packet *packet) {
    int target_fd;
    int rc;
    Packet forward = *packet;

    rc = user_store_get_fd(&state->users, packet->receiver, &target_fd);
    if (rc != USER_OK) {
        send_text_response(fd, MSG_ERROR, user_result_message(rc));
        return;
    }
    if (send_packet(target_fd, &forward) < 0) {
        cleanup_offline_fd(state, target_fd);
        send_text_response(fd, MSG_ERROR, "目标用户连接已断开");
        return;
    }
    send_text_response(fd, MSG_OK, "私聊消息已发送");
}

static void handle_group(ServerState *state, int fd, const Packet *packet) {
    int fds[MAX_ONLINE_SNAPSHOT];
    size_t count = 0;

    if (user_store_snapshot_online_fds(&state->users, fd, fds,
                                       MAX_ONLINE_SNAPSHOT, &count) != USER_OK ||
        count == 0) {
        send_text_response(fd, MSG_ERROR, "当前没有其他在线用户");
        return;
    }

    for (size_t i = 0; i < count; ++i) {
        if (send_packet(fds[i], packet) < 0) {
            cleanup_offline_fd(state, fds[i]);
        }
    }
    send_text_response(fd, MSG_OK, "群聊消息已发送");
}

static void handle_group_create(ServerState *state, int fd,
                                const Packet *packet) {
    char username[USERNAME_MAX_LEN];
    GroupFields fields;
    GroupSnapshot snapshot;
    const char *members[GROUP_MAX_MEMBERS];
    size_t member_count;
    bool has_other_member = false;
    int rc;

    if (user_store_username_by_fd(&state->users, fd, username,
                                  sizeof(username)) != USER_OK) {
        send_text_response(fd, MSG_ERROR, "请先登录");
        return;
    }
    rc = group_payload_parse(packet->data, packet->length, &fields);
    if (rc != GROUP_OK || fields.count < 2 ||
        fields.count - 1 > GROUP_MAX_MEMBERS) {
        send_text_response(fd, MSG_ERROR, "群聊创建数据不合法");
        return;
    }

    member_count = fields.count - 1;
    for (size_t i = 0; i < member_count; ++i) {
        int member_fd;
        members[i] = fields.values[i + 1];
        if (strcmp(members[i], username) != 0) {
            has_other_member = true;
        }
        if (user_store_get_fd(&state->users, members[i], &member_fd) !=
            USER_OK) {
            send_text_response(fd, MSG_ERROR, "群成员必须是当前在线用户");
            return;
        }
    }
    if (!has_other_member) {
        send_text_response(fd, MSG_ERROR, "请至少选择一名在线成员");
        return;
    }

    rc = group_store_create(&state->groups, username, fields.values[0],
                            members, member_count, &snapshot);
    if (rc != GROUP_OK) {
        send_text_response(fd, MSG_ERROR, group_result_message(rc));
        return;
    }
    push_group_event(state, GROUP_EVENT_CREATED, &snapshot);
    send_text_response(fd, MSG_OK, "群聊已创建");
}

static void handle_group_list(ServerState *state, int fd) {
    char username[USERNAME_MAX_LEN];
    GroupPayload payload;
    Packet packet;
    int rc;

    if (user_store_username_by_fd(&state->users, fd, username,
                                  sizeof(username)) != USER_OK) {
        send_text_response(fd, MSG_ERROR, "请先登录");
        return;
    }
    rc = group_store_build_list_payload(&state->groups, username, &payload);
    if (rc != GROUP_OK) {
        send_text_response(fd, MSG_ERROR, group_result_message(rc));
        return;
    }
    if (packet_init(&packet, MSG_GROUP_LIST, "server", username, payload.data,
                    payload.length) != 0 ||
        send_packet(fd, &packet) < 0) {
        cleanup_offline_fd(state, fd);
    }
}

static void handle_group_message(ServerState *state, int fd,
                                 const Packet *packet) {
    char username[USERNAME_MAX_LEN];
    GroupSnapshot snapshot;
    GroupPayload payload;
    const char *text = packet_text_data(packet);
    int rc;

    if (user_store_username_by_fd(&state->users, fd, username,
                                  sizeof(username)) != USER_OK) {
        send_text_response(fd, MSG_ERROR, "请先登录");
        return;
    }
    if (packet->receiver[0] == '\0' || text == NULL || text[0] == '\0') {
        send_text_response(fd, MSG_ERROR, "群聊消息数据不合法");
        return;
    }
    rc = group_store_get_snapshot(&state->groups, packet->receiver, &snapshot);
    if (rc != GROUP_OK) {
        send_text_response(fd, MSG_ERROR, group_result_message(rc));
        return;
    }
    if (!group_snapshot_has_member(&snapshot, username)) {
        send_text_response(fd, MSG_ERROR,
                           group_result_message(GROUP_ERR_NOT_MEMBER));
        return;
    }
    rc = group_payload_build_message(&snapshot, text, &payload);
    if (rc != GROUP_OK) {
        send_text_response(fd, MSG_ERROR, group_result_message(rc));
        return;
    }

    for (size_t i = 0; i < snapshot.member_count; ++i) {
        int member_fd;
        if (user_store_get_fd(&state->users, snapshot.members[i],
                              &member_fd) == USER_OK) {
            send_group_payload_to_fd(state, member_fd, MSG_GROUP_MESSAGE,
                                     username, snapshot.id, &payload);
        }
    }
    send_text_response(fd, MSG_OK, "群聊消息已发送");
}

static bool packet_is_file_type(int type) {
    return type == MSG_FILE_BEGIN || type == MSG_FILE_CHUNK ||
           type == MSG_FILE_END;
}

static void handle_file_packet(ServerState *state, int fd,
                               const Packet *packet) {
    int target_fd;
    int rc = user_store_get_fd(&state->users, packet->receiver, &target_fd);

    if (rc != USER_OK) {
        send_text_response(fd, MSG_ERROR, user_result_message(rc));
        return;
    }
    if (send_packet(target_fd, packet) < 0) {
        cleanup_offline_fd(state, target_fd);
        send_text_response(fd, MSG_ERROR, "目标用户连接已断开");
        return;
    }
    if (packet->type == MSG_FILE_END) {
        send_text_response(fd, MSG_OK, "文件发送完成");
    }
}

static void process_packet(ServerState *state, int fd, const Packet *packet) {
    switch (packet->type) {
    case MSG_REGISTER:
        handle_register(state, fd, packet);
        break;
    case MSG_LOGIN:
        handle_login(state, fd, packet);
        break;
    case MSG_ONLINE_LIST:
        handle_online_list(state, fd);
        break;
    case MSG_PRIVATE:
        handle_private(state, fd, packet);
        break;
    case MSG_GROUP:
        handle_group(state, fd, packet);
        break;
    case MSG_GROUP_CREATE:
        handle_group_create(state, fd, packet);
        break;
    case MSG_GROUP_LIST:
        handle_group_list(state, fd);
        break;
    case MSG_GROUP_MESSAGE:
        handle_group_message(state, fd, packet);
        break;
    case MSG_FILE_BEGIN:
    case MSG_FILE_CHUNK:
    case MSG_FILE_END:
        handle_file_packet(state, fd, packet);
        break;
    case MSG_LOGOUT:
        cleanup_offline_fd(state, fd);
        send_text_response(fd, MSG_OK, "退出登录成功");
        break;
    case MSG_HEARTBEAT:
        send_text_response(fd, MSG_OK, "心跳正常");
        break;
    default:
        send_text_response(fd, MSG_ERROR, "非法消息类型");
        break;
    }

    if (packet_is_file_type(packet->type)) {
        fflush(stdout);
    }
}

static void *client_handler(void *arg) {
    ClientContext *ctx = (ClientContext *)arg;
    ServerState *state = ctx->state;
    int fd = ctx->fd;
    Packet packet;

    free(ctx);
    while (state->running && recv_packet(fd, &packet) == 0) {
        process_packet(state, fd, &packet);
    }
    cleanup_offline_fd(state, fd);
    close(fd);
    return NULL;
}

static void *console_handler(void *arg) {
    ServerState *state = (ServerState *)arg;
    char line[2048];

    while (state->running && fgets(line, sizeof(line), stdin) != NULL) {
        line[strcspn(line, "\r\n")] = '\0';
        if (strncmp(line, "/broadcast ", 11) == 0) {
            const char *message = line + 11;
            if (message[0] == '\0') {
                puts("广播内容不能为空");
                continue;
            }
            if (send_udp_broadcast(state->udp_fd, state->udp_port, message) == 0) {
                printf("UDP 广播已发送: %s\n", message);
                fflush(stdout);
            } else {
                perror("send_udp_broadcast");
            }
        } else if (strcmp(line, "/quit") == 0) {
            state->running = 0;
            shutdown(state->listen_fd, SHUT_RDWR);
            close(state->listen_fd);
            break;
        } else if (line[0] != '\0') {
            puts("可用命令: /broadcast 文本 或 /quit");
        }
    }
    return NULL;
}

static int parse_port(const char *text, int fallback) {
    char *end = NULL;
    long value;

    if (text == NULL) {
        return fallback;
    }
    value = strtol(text, &end, 10);
    if (end == text || *end != '\0' || value <= 0 || value > 65535) {
        return fallback;
    }
    return (int)value;
}

int main(int argc, char **argv) {
    int tcp_port = argc > 1 ? parse_port(argv[1], DEFAULT_TCP_PORT)
                            : DEFAULT_TCP_PORT;
    int udp_port = argc > 2 ? parse_port(argv[2], DEFAULT_UDP_PORT)
                            : DEFAULT_UDP_PORT;
    pthread_t console_tid;

    signal(SIGPIPE, SIG_IGN);
    memset(&g_state, 0, sizeof(g_state));
    g_state.running = 1;
    g_state.udp_port = udp_port;

    if (ensure_directory("data") < 0) {
        perror("ensure data directory");
        return 1;
    }
    if (user_store_init(&g_state.users, "data/users.db") != 0 ||
        user_store_load(&g_state.users) != USER_OK) {
        fprintf(stderr, "用户数据初始化失败\n");
        return 1;
    }
    if (group_store_init(&g_state.groups) != GROUP_OK) {
        fprintf(stderr, "群聊数据初始化失败\n");
        user_store_destroy(&g_state.users);
        return 1;
    }

    g_state.listen_fd = create_tcp_server_socket(tcp_port, LISTEN_BACKLOG);
    if (g_state.listen_fd < 0) {
        perror("create_tcp_server_socket");
        group_store_destroy(&g_state.groups);
        user_store_destroy(&g_state.users);
        return 1;
    }

    g_state.udp_fd = create_udp_broadcast_sender();
    if (g_state.udp_fd < 0) {
        perror("create_udp_broadcast_sender");
        close(g_state.listen_fd);
        group_store_destroy(&g_state.groups);
        user_store_destroy(&g_state.users);
        return 1;
    }

    if (pthread_create(&console_tid, NULL, console_handler, &g_state) == 0) {
        pthread_detach(console_tid);
    }

    printf("服务器已启动: TCP %d, UDP %d\n", tcp_port, udp_port);
    printf("控制命令: /broadcast 文本, /quit\n");
    fflush(stdout);

    while (g_state.running) {
        struct sockaddr_in client_addr;
        socklen_t addr_len = sizeof(client_addr);
        int client_fd =
            accept(g_state.listen_fd, (struct sockaddr *)&client_addr, &addr_len);
        ClientContext *ctx;
        pthread_t tid;

        if (client_fd < 0) {
            if (!g_state.running || errno == EBADF || errno == EINVAL) {
                break;
            }
            if (errno == EINTR) {
                continue;
            }
            perror("accept");
            continue;
        }

        ctx = (ClientContext *)calloc(1, sizeof(ClientContext));
        if (ctx == NULL) {
            close(client_fd);
            continue;
        }
        ctx->state = &g_state;
        ctx->fd = client_fd;
        if (pthread_create(&tid, NULL, client_handler, ctx) != 0) {
            close(client_fd);
            free(ctx);
            continue;
        }
        pthread_detach(tid);
    }

    close(g_state.udp_fd);
    group_store_destroy(&g_state.groups);
    user_store_destroy(&g_state.users);
    puts("服务器已退出");
    return 0;
}
