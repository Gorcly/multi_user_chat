#include "file_utils.h"
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
        user_store_logout_fd(&state->users, target_fd);
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
            user_store_logout_fd(&state->users, fds[i]);
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
        user_store_logout_fd(&state->users, target_fd);
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
    case MSG_FILE_BEGIN:
    case MSG_FILE_CHUNK:
    case MSG_FILE_END:
        handle_file_packet(state, fd, packet);
        break;
    case MSG_LOGOUT:
        user_store_logout_fd(&state->users, fd);
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
    user_store_logout_fd(&state->users, fd);
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

    g_state.listen_fd = create_tcp_server_socket(tcp_port, LISTEN_BACKLOG);
    if (g_state.listen_fd < 0) {
        perror("create_tcp_server_socket");
        user_store_destroy(&g_state.users);
        return 1;
    }

    g_state.udp_fd = create_udp_broadcast_sender();
    if (g_state.udp_fd < 0) {
        perror("create_udp_broadcast_sender");
        close(g_state.listen_fd);
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
    user_store_destroy(&g_state.users);
    puts("服务器已退出");
    return 0;
}
