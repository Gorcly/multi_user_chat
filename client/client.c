#include "file_utils.h"
#include "net_utils.h"
#include "protocol.h"

#include <arpa/inet.h>
#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define DEFAULT_SERVER_IP "127.0.0.1"
#define DEFAULT_TCP_PORT 9000
#define DEFAULT_UDP_PORT 9001

typedef struct ClientState {
    int sockfd;
    int udp_fd;
    volatile sig_atomic_t running;
    volatile sig_atomic_t logged_in;
    char username[USERNAME_MAX_LEN];
    pthread_t recv_tid;
    pthread_t udp_tid;
} ClientState;

typedef struct IncomingFile {
    bool active;
    char sender[USERNAME_MAX_LEN];
    char filename[FILE_NAME_MAX_LEN];
    uint64_t expected_size;
    uint64_t received_size;
    FILE *fp;
    char path[512];
} IncomingFile;

static pthread_mutex_t g_print_mutex = PTHREAD_MUTEX_INITIALIZER;

static void print_line(const char *text) {
    pthread_mutex_lock(&g_print_mutex);
    puts(text);
    fflush(stdout);
    pthread_mutex_unlock(&g_print_mutex);
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

static bool read_line_prompt(const char *prompt, char *out, size_t out_size) {
    if (prompt != NULL) {
        pthread_mutex_lock(&g_print_mutex);
        fputs(prompt, stdout);
        fflush(stdout);
        pthread_mutex_unlock(&g_print_mutex);
    }
    if (fgets(out, out_size, stdin) == NULL) {
        return false;
    }
    out[strcspn(out, "\r\n")] = '\0';
    return true;
}

static int read_menu_choice(void) {
    char buf[32];

    if (!read_line_prompt("请选择: ", buf, sizeof(buf))) {
        return -1;
    }
    return atoi(buf);
}

static int send_text_packet(int fd, int type, const char *sender,
                            const char *receiver, const char *text) {
    Packet packet;

    if (packet_set_text(&packet, type, sender, receiver, text) < 0) {
        return -1;
    }
    return send_packet(fd, &packet);
}

static void show_main_menu(void) {
    print_line("========= 多用户网络通信系统 =========");
    print_line("1. 注册");
    print_line("2. 登录");
    print_line("3. 退出");
}

static void show_chat_menu(void) {
    print_line("========= 聊天功能菜单 =========");
    print_line("1. 查看在线用户");
    print_line("2. 发送私聊消息");
    print_line("3. 发送群聊消息");
    print_line("4. 发送文件");
    print_line("5. 退出登录");
    print_line("6. 退出系统");
}

static int wait_for_auth_response(ClientState *state) {
    Packet packet;

    if (recv_packet(state->sockfd, &packet) < 0) {
        print_line("服务器连接已断开");
        return -1;
    }
    if (packet.type == MSG_OK) {
        printf("%s\n", (const char *)packet.data);
        fflush(stdout);
        return 0;
    }
    printf("%s\n", (const char *)packet.data);
    fflush(stdout);
    return -1;
}

static void do_register(ClientState *state) {
    char username[USERNAME_MAX_LEN];
    char password[PASSWORD_MAX_LEN];

    if (!read_line_prompt("用户名: ", username, sizeof(username)) ||
        !read_line_prompt("密码: ", password, sizeof(password))) {
        state->running = 0;
        return;
    }
    if (send_text_packet(state->sockfd, MSG_REGISTER, username, "", password) <
        0) {
        print_line("注册请求发送失败");
        return;
    }
    wait_for_auth_response(state);
}

static bool do_login(ClientState *state) {
    char username[USERNAME_MAX_LEN];
    char password[PASSWORD_MAX_LEN];

    if (!read_line_prompt("用户名: ", username, sizeof(username)) ||
        !read_line_prompt("密码: ", password, sizeof(password))) {
        state->running = 0;
        return false;
    }
    if (send_text_packet(state->sockfd, MSG_LOGIN, username, "", password) < 0) {
        print_line("登录请求发送失败");
        return false;
    }
    if (wait_for_auth_response(state) == 0) {
        snprintf(state->username, sizeof(state->username), "%s", username);
        state->logged_in = 1;
        return true;
    }
    return false;
}

static void close_incoming_file(IncomingFile *file) {
    if (file->fp != NULL) {
        fclose(file->fp);
    }
    memset(file, 0, sizeof(*file));
}

static void handle_file_begin(IncomingFile *file, const Packet *packet) {
    FileBeginPayload payload;

    close_incoming_file(file);
    if (packet->length != sizeof(payload)) {
        print_line("收到非法文件头");
        return;
    }
    memcpy(&payload, packet->data, sizeof(payload));
    payload.filename[FILE_NAME_MAX_LEN - 1] = '\0';
    if (payload.filesize > FILE_TRANSFER_MAX_BYTES) {
        print_line("收到的文件超过大小限制，已拒绝");
        return;
    }
    if (build_unique_download_path("downloads", packet->sender,
                                   payload.filename, file->path,
                                   sizeof(file->path)) < 0) {
        print_line("创建下载路径失败");
        return;
    }
    file->fp = fopen(file->path, "wb");
    if (file->fp == NULL) {
        print_line("保存接收文件失败");
        memset(file, 0, sizeof(*file));
        return;
    }
    file->active = true;
    snprintf(file->sender, sizeof(file->sender), "%s", packet->sender);
    snprintf(file->filename, sizeof(file->filename), "%s", payload.filename);
    file->expected_size = payload.filesize;
    file->received_size = 0;
    printf("开始接收文件: %s -> %s (%" PRIu64 " bytes)\n", file->filename,
           file->path, file->expected_size);
    fflush(stdout);
}

static void handle_file_chunk(IncomingFile *file, const Packet *packet) {
    if (!file->active || file->fp == NULL) {
        return;
    }
    if (fwrite(packet->data, 1, packet->length, file->fp) != packet->length) {
        print_line("写入接收文件失败");
        close_incoming_file(file);
        return;
    }
    file->received_size += packet->length;
}

static void handle_file_end(IncomingFile *file) {
    char message[768];

    if (!file->active) {
        return;
    }
    if (file->received_size == file->expected_size) {
        snprintf(message, sizeof(message), "文件接收完成: %s", file->path);
        print_line(message);
    } else {
        snprintf(message, sizeof(message),
                 "文件接收大小不匹配: 已收 %" PRIu64 " / 期望 %" PRIu64,
                 file->received_size, file->expected_size);
        print_line(message);
    }
    close_incoming_file(file);
}

static void *recv_thread(void *arg) {
    ClientState *state = (ClientState *)arg;
    Packet packet;
    IncomingFile incoming;

    memset(&incoming, 0, sizeof(incoming));
    while (state->running && recv_packet(state->sockfd, &packet) == 0) {
        switch (packet.type) {
        case MSG_OK:
        case MSG_ERROR:
        case MSG_ONLINE_LIST:
            printf("%s\n", (const char *)packet.data);
            fflush(stdout);
            break;
        case MSG_PRIVATE:
            printf("[私聊][%s]: %s\n", packet.sender, (const char *)packet.data);
            fflush(stdout);
            break;
        case MSG_GROUP:
            printf("[群聊][%s]: %s\n", packet.sender, (const char *)packet.data);
            fflush(stdout);
            break;
        case MSG_FILE_BEGIN:
            handle_file_begin(&incoming, &packet);
            break;
        case MSG_FILE_CHUNK:
            handle_file_chunk(&incoming, &packet);
            break;
        case MSG_FILE_END:
            handle_file_end(&incoming);
            break;
        default:
            printf("[系统] 收到消息类型 %s\n", message_type_name(packet.type));
            fflush(stdout);
            break;
        }
    }
    close_incoming_file(&incoming);
    state->running = 0;
    return NULL;
}

static void *udp_thread(void *arg) {
    ClientState *state = (ClientState *)arg;
    char buf[PACKET_DATA_MAX + 1];

    while (state->running) {
        ssize_t n = recv(state->udp_fd, buf, PACKET_DATA_MAX, 0);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        buf[n] = '\0';
        printf("[UDP广播] %s\n", buf);
        fflush(stdout);
    }
    return NULL;
}

static void request_online_list(ClientState *state) {
    Packet packet;

    if (packet_init(&packet, MSG_ONLINE_LIST, state->username, "", NULL, 0) < 0 ||
        send_packet(state->sockfd, &packet) < 0) {
        print_line("在线列表请求发送失败");
    }
}

static void send_private_message(ClientState *state) {
    char receiver[USERNAME_MAX_LEN];
    char content[PACKET_DATA_MAX];

    if (!read_line_prompt("接收者: ", receiver, sizeof(receiver)) ||
        !read_line_prompt("消息内容: ", content, sizeof(content))) {
        state->running = 0;
        return;
    }
    if (send_text_packet(state->sockfd, MSG_PRIVATE, state->username, receiver,
                         content) < 0) {
        print_line("私聊消息发送失败");
    }
}

static void send_group_message(ClientState *state) {
    char content[PACKET_DATA_MAX];

    if (!read_line_prompt("群聊内容: ", content, sizeof(content))) {
        state->running = 0;
        return;
    }
    if (send_text_packet(state->sockfd, MSG_GROUP, state->username, "", content) <
        0) {
        print_line("群聊消息发送失败");
    }
}

static int send_file_chunk(ClientState *state, const char *receiver,
                           const unsigned char *buf, size_t len) {
    Packet packet;

    if (packet_init(&packet, MSG_FILE_CHUNK, state->username, receiver, buf,
                    len) < 0) {
        return -1;
    }
    return send_packet(state->sockfd, &packet);
}

static void send_file(ClientState *state) {
    char receiver[USERNAME_MAX_LEN];
    char path[512];
    const char *filename;
    struct stat st;
    FILE *fp;
    FileBeginPayload payload;
    Packet packet;
    unsigned char buf[PACKET_DATA_MAX];

    if (!read_line_prompt("接收者: ", receiver, sizeof(receiver)) ||
        !read_line_prompt("文件路径: ", path, sizeof(path))) {
        state->running = 0;
        return;
    }
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) {
        print_line("文件不存在");
        return;
    }
    if ((uint64_t)st.st_size > FILE_TRANSFER_MAX_BYTES) {
        print_line("文件超过 10 MiB 限制");
        return;
    }
    fp = fopen(path, "rb");
    if (fp == NULL) {
        print_line("打开文件失败");
        return;
    }

    memset(&payload, 0, sizeof(payload));
    filename = base_filename(path);
    snprintf(payload.filename, sizeof(payload.filename), "%s", filename);
    payload.filesize = (uint64_t)st.st_size;
    if (packet_init(&packet, MSG_FILE_BEGIN, state->username, receiver, &payload,
                    sizeof(payload)) < 0 ||
        send_packet(state->sockfd, &packet) < 0) {
        fclose(fp);
        print_line("文件头发送失败");
        return;
    }

    while (!feof(fp)) {
        size_t n = fread(buf, 1, sizeof(buf), fp);
        if (n > 0 && send_file_chunk(state, receiver, buf, n) < 0) {
            fclose(fp);
            print_line("文件分块发送失败");
            return;
        }
        if (ferror(fp)) {
            fclose(fp);
            print_line("读取文件失败");
            return;
        }
    }
    fclose(fp);

    if (packet_init(&packet, MSG_FILE_END, state->username, receiver, NULL, 0) <
            0 ||
        send_packet(state->sockfd, &packet) < 0) {
        print_line("文件结束包发送失败");
        return;
    }
    print_line("文件发送请求已提交");
}

static void logout(ClientState *state) {
    Packet packet;

    if (!state->logged_in) {
        return;
    }
    if (packet_init(&packet, MSG_LOGOUT, state->username, "", NULL, 0) == 0) {
        send_packet(state->sockfd, &packet);
    }
    state->logged_in = 0;
    state->username[0] = '\0';
}

static void chat_loop(ClientState *state) {
    while (state->running && state->logged_in) {
        show_chat_menu();
        switch (read_menu_choice()) {
        case 1:
            request_online_list(state);
            sleep(1);
            break;
        case 2:
            send_private_message(state);
            sleep(1);
            break;
        case 3:
            send_group_message(state);
            sleep(1);
            break;
        case 4:
            send_file(state);
            sleep(1);
            break;
        case 5:
            logout(state);
            sleep(1);
            return;
        case 6:
            logout(state);
            state->running = 0;
            return;
        default:
            print_line("无效选择");
            break;
        }
    }
}

static void main_loop(ClientState *state) {
    while (state->running) {
        show_main_menu();
        switch (read_menu_choice()) {
        case 1:
            do_register(state);
            break;
        case 2:
            if (do_login(state)) {
                if (pthread_create(&state->recv_tid, NULL, recv_thread, state) ==
                    0) {
                    pthread_detach(state->recv_tid);
                }
                chat_loop(state);
            }
            break;
        case 3:
        case -1:
            state->running = 0;
            break;
        default:
            print_line("无效选择");
            break;
        }
    }
}

int main(int argc, char **argv) {
    const char *server_ip = argc > 1 ? argv[1] : DEFAULT_SERVER_IP;
    int tcp_port = argc > 2 ? parse_port(argv[2], DEFAULT_TCP_PORT)
                            : DEFAULT_TCP_PORT;
    int udp_port = argc > 3 ? parse_port(argv[3], DEFAULT_UDP_PORT)
                            : DEFAULT_UDP_PORT;
    ClientState state;
    char input_ip[64];
    char input_port[32];

    signal(SIGPIPE, SIG_IGN);
    memset(&state, 0, sizeof(state));
    state.running = 1;
    state.sockfd = -1;
    state.udp_fd = -1;

    if (argc == 1) {
        if (read_line_prompt("服务器IP(默认127.0.0.1): ", input_ip,
                             sizeof(input_ip)) &&
            input_ip[0] != '\0') {
            server_ip = input_ip;
        }
        if (read_line_prompt("TCP端口(默认9000): ", input_port,
                             sizeof(input_port)) &&
            input_port[0] != '\0') {
            tcp_port = parse_port(input_port, DEFAULT_TCP_PORT);
        }
    }

    state.sockfd = connect_tcp_server(server_ip, tcp_port);
    if (state.sockfd < 0) {
        perror("连接服务器失败");
        return 1;
    }

    state.udp_fd = create_udp_broadcast_receiver(udp_port);
    if (state.udp_fd >= 0) {
        if (pthread_create(&state.udp_tid, NULL, udp_thread, &state) == 0) {
            pthread_detach(state.udp_tid);
        }
    } else {
        print_line("UDP 广播接收启动失败，聊天功能仍可使用");
    }

    printf("已连接服务器 %s:%d，UDP广播端口 %d\n", server_ip, tcp_port,
           udp_port);
    fflush(stdout);
    main_loop(&state);

    state.running = 0;
    if (state.sockfd >= 0) {
        shutdown(state.sockfd, SHUT_RDWR);
        close(state.sockfd);
    }
    if (state.udp_fd >= 0) {
        close(state.udp_fd);
    }
    return 0;
}
