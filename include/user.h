#ifndef USER_H
#define USER_H

#include "crypto_utils.h"
#include "protocol.h"

#include <pthread.h>
#include <stdbool.h>
#include <stddef.h>

#define USER_HASH_BUCKETS 101

typedef enum UserResult {
    USER_OK = 0,
    USER_ERR_EXISTS = -2,
    USER_ERR_NOT_FOUND = -3,
    USER_ERR_BAD_PASSWORD = -4,
    USER_ERR_ALREADY_ONLINE = -5,
    USER_ERR_OFFLINE = -6,
    USER_ERR_INVALID = -7,
    USER_ERR_IO = -8
} UserResult;

typedef struct User {
    char username[USERNAME_MAX_LEN];
    char salt[SALT_HEX_LEN + 1];
    char password_hash[PASSWORD_HASH_HEX_LEN + 1];
    int socket_fd;
    bool online;
    struct User *next;
    struct User *hash_next;
} User;

typedef struct UserStore {
    User *head;
    User *buckets[USER_HASH_BUCKETS];
    char storage_path[512];
    pthread_mutex_t mutex;
} UserStore;

int user_store_init(UserStore *store, const char *storage_path);
void user_store_destroy(UserStore *store);
int user_store_load(UserStore *store);
int user_store_register(UserStore *store, const char *username,
                        const char *password);
int user_store_login(UserStore *store, const char *username,
                     const char *password, int socket_fd);
int user_store_logout(UserStore *store, const char *username);
int user_store_logout_fd(UserStore *store, int socket_fd);
bool user_store_has_user(UserStore *store, const char *username);
int user_store_get_fd(UserStore *store, const char *username, int *socket_fd);
int user_store_online_list(UserStore *store, char *out, size_t out_size);
int user_store_snapshot_online_fds(UserStore *store, int except_fd, int *fds,
                                   size_t max_fds, size_t *count);
int user_store_username_by_fd(UserStore *store, int socket_fd, char *out,
                              size_t out_size);
const char *user_result_message(int result);

#endif
