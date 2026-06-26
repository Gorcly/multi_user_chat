#include "crypto_utils.h"
#include "file_utils.h"
#include "message_queue.h"
#include "protocol.h"
#include "user.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define ASSERT_TRUE(expr)                                                       \
    do {                                                                       \
        if (!(expr)) {                                                         \
            fprintf(stderr, "ASSERT_TRUE failed at %s:%d: %s\n", __FILE__,   \
                    __LINE__, #expr);                                          \
            exit(1);                                                           \
        }                                                                      \
    } while (0)

#define ASSERT_EQ_INT(actual, expected)                                         \
    do {                                                                       \
        int a_ = (actual);                                                     \
        int e_ = (expected);                                                   \
        if (a_ != e_) {                                                        \
            fprintf(stderr,                                                     \
                    "ASSERT_EQ_INT failed at %s:%d: got %d expected %d\n",    \
                    __FILE__, __LINE__, a_, e_);                               \
            exit(1);                                                           \
        }                                                                      \
    } while (0)

#define ASSERT_STREQ(actual, expected)                                          \
    do {                                                                       \
        const char *a_ = (actual);                                             \
        const char *e_ = (expected);                                           \
        if (strcmp(a_, e_) != 0) {                                             \
            fprintf(stderr,                                                     \
                    "ASSERT_STREQ failed at %s:%d: got '%s' expected '%s'\n", \
                    __FILE__, __LINE__, a_, e_);                               \
            exit(1);                                                           \
        }                                                                      \
    } while (0)

static void test_protocol_round_trip_text(void) {
    int fds[2];
    Packet out;
    Packet in;

    ASSERT_EQ_INT(socketpair(AF_UNIX, SOCK_STREAM, 0, fds), 0);
    ASSERT_EQ_INT(packet_init(&out, MSG_PRIVATE, "user1", "user2",
                              "hello user2", strlen("hello user2") + 1),
                  0);
    ASSERT_EQ_INT(send_packet(fds[0], &out), 0);
    ASSERT_EQ_INT(recv_packet(fds[1], &in), 0);

    ASSERT_EQ_INT(in.type, MSG_PRIVATE);
    ASSERT_EQ_INT((int)in.length, (int)strlen("hello user2") + 1);
    ASSERT_STREQ(in.sender, "user1");
    ASSERT_STREQ(in.receiver, "user2");
    ASSERT_STREQ((const char *)in.data, "hello user2");

    close(fds[0]);
    close(fds[1]);
}

static void test_protocol_handles_max_binary_payload(void) {
    int fds[2];
    unsigned char payload[PACKET_DATA_MAX];
    Packet out;
    Packet in;

    for (size_t i = 0; i < sizeof(payload); ++i) {
        payload[i] = (unsigned char)(i % 251);
    }

    ASSERT_EQ_INT(socketpair(AF_UNIX, SOCK_STREAM, 0, fds), 0);
    ASSERT_EQ_INT(packet_init(&out, MSG_FILE_CHUNK, "alice", "bob", payload,
                              sizeof(payload)),
                  0);
    ASSERT_EQ_INT(send_packet(fds[0], &out), 0);
    ASSERT_EQ_INT(recv_packet(fds[1], &in), 0);

    ASSERT_EQ_INT(in.type, MSG_FILE_CHUNK);
    ASSERT_EQ_INT((int)in.length, PACKET_DATA_MAX);
    ASSERT_EQ_INT(memcmp(in.data, payload, sizeof(payload)), 0);

    close(fds[0]);
    close(fds[1]);
}

static void test_message_queue_fifo_and_capacity(void) {
    MessageQueue queue;
    Packet first;
    Packet second;
    Packet got;

    ASSERT_EQ_INT(message_queue_init(&queue, 2), 0);
    ASSERT_TRUE(message_queue_is_empty(&queue));

    ASSERT_EQ_INT(packet_init(&first, MSG_GROUP, "a", "", "one", 4), 0);
    ASSERT_EQ_INT(packet_init(&second, MSG_GROUP, "b", "", "two", 4), 0);

    ASSERT_EQ_INT(message_queue_enqueue(&queue, &first), 0);
    ASSERT_EQ_INT(message_queue_enqueue(&queue, &second), 0);
    ASSERT_EQ_INT(message_queue_enqueue(&queue, &second), -1);

    ASSERT_EQ_INT(message_queue_dequeue(&queue, &got), 0);
    ASSERT_STREQ((const char *)got.data, "one");
    ASSERT_EQ_INT(message_queue_dequeue(&queue, &got), 0);
    ASSERT_STREQ((const char *)got.data, "two");
    ASSERT_TRUE(message_queue_is_empty(&queue));
    ASSERT_EQ_INT(message_queue_dequeue(&queue, &got), -1);

    message_queue_destroy(&queue);
}

static void test_crypto_hash_and_verify(void) {
    char salt[SALT_HEX_LEN + 1];
    char hash[PASSWORD_HASH_HEX_LEN + 1];
    char hash_again[PASSWORD_HASH_HEX_LEN + 1];

    ASSERT_EQ_INT(generate_salt_hex(salt, sizeof(salt)), 0);
    ASSERT_EQ_INT((int)strlen(salt), SALT_HEX_LEN);
    ASSERT_EQ_INT(hash_password("secret", salt, hash, sizeof(hash)), 0);
    ASSERT_EQ_INT(hash_password("secret", salt, hash_again, sizeof(hash_again)),
                  0);

    ASSERT_STREQ(hash, hash_again);
    ASSERT_TRUE(verify_password("secret", salt, hash));
    ASSERT_TRUE(!verify_password("wrong", salt, hash));
}

static void test_user_store_persistence_and_online_state(void) {
    UserStore store;
    UserStore loaded;
    char path[] = "test/tmp/users.db";
    int fd;
    char names[128];

    ASSERT_EQ_INT(user_store_init(&store, path), 0);
    ASSERT_EQ_INT(user_store_register(&store, "alice", "pw1"), 0);
    ASSERT_EQ_INT(user_store_register(&store, "alice", "pw1"), USER_ERR_EXISTS);
    ASSERT_EQ_INT(user_store_register(&store, "bob", "pw2"), 0);
    user_store_destroy(&store);

    ASSERT_EQ_INT(user_store_init(&loaded, path), 0);
    ASSERT_EQ_INT(user_store_load(&loaded), 0);
    ASSERT_TRUE(user_store_has_user(&loaded, "alice"));
    ASSERT_EQ_INT(user_store_login(&loaded, "alice", "bad", 11),
                  USER_ERR_BAD_PASSWORD);
    ASSERT_EQ_INT(user_store_login(&loaded, "alice", "pw1", 11), 0);
    ASSERT_EQ_INT(user_store_login(&loaded, "alice", "pw1", 12),
                  USER_ERR_ALREADY_ONLINE);
    ASSERT_EQ_INT(user_store_get_fd(&loaded, "alice", &fd), 0);
    ASSERT_EQ_INT(fd, 11);
    ASSERT_EQ_INT(user_store_online_list(&loaded, names, sizeof(names)), 0);
    ASSERT_TRUE(strstr(names, "alice") != NULL);
    ASSERT_EQ_INT(user_store_logout_fd(&loaded, 11), 0);
    ASSERT_EQ_INT(user_store_get_fd(&loaded, "alice", &fd), USER_ERR_OFFLINE);
    user_store_destroy(&loaded);
}

static void test_file_save_path_avoids_conflict(void) {
    char path1[512];
    char path2[512];
    FILE *fp;

    ASSERT_EQ_INT(ensure_directory("test/tmp/downloads"), 0);
    ASSERT_EQ_INT(build_unique_download_path("test/tmp/downloads", "alice",
                                             "note.txt", path1, sizeof(path1)),
                  0);
    fp = fopen(path1, "wb");
    ASSERT_TRUE(fp != NULL);
    fputs("first", fp);
    fclose(fp);

    ASSERT_EQ_INT(build_unique_download_path("test/tmp/downloads", "alice",
                                             "note.txt", path2, sizeof(path2)),
                  0);
    ASSERT_TRUE(strcmp(path1, path2) != 0);
    ASSERT_TRUE(strstr(path2, "alice_note") != NULL);
}

int main(void) {
    ASSERT_EQ_INT(ensure_directory("test/tmp"), 0);

    test_protocol_round_trip_text();
    test_protocol_handles_max_binary_payload();
    test_message_queue_fifo_and_capacity();
    test_crypto_hash_and_verify();
    test_user_store_persistence_and_online_state();
    test_file_save_path_avoids_conflict();

    puts("unit tests passed");
    return 0;
}
