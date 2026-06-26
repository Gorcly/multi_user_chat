#include "user.h"

#include "file_utils.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned int hash_username(const char *username) {
    unsigned int hash = 5381;
    int c;

    while ((c = *username++) != '\0') {
        hash = ((hash << 5) + hash) + (unsigned int)c;
    }
    return hash % USER_HASH_BUCKETS;
}

static bool valid_username(const char *username) {
    return username != NULL && username[0] != '\0' &&
           strlen(username) < USERNAME_MAX_LEN &&
           strchr(username, ':') == NULL && strchr(username, '\n') == NULL;
}

static bool valid_password(const char *password) {
    return password != NULL && password[0] != '\0' &&
           strlen(password) < PASSWORD_MAX_LEN && strchr(password, '\n') == NULL;
}

static User *find_user_locked(UserStore *store, const char *username) {
    unsigned int bucket;
    User *cur;

    if (!valid_username(username)) {
        return NULL;
    }
    bucket = hash_username(username);
    for (cur = store->buckets[bucket]; cur != NULL; cur = cur->hash_next) {
        if (strcmp(cur->username, username) == 0) {
            return cur;
        }
    }
    return NULL;
}

static int insert_user_locked(UserStore *store, User *user) {
    unsigned int bucket;

    if (store == NULL || user == NULL || find_user_locked(store, user->username)) {
        return -1;
    }
    user->next = store->head;
    store->head = user;
    bucket = hash_username(user->username);
    user->hash_next = store->buckets[bucket];
    store->buckets[bucket] = user;
    return 0;
}

static User *create_user(const char *username, const char *salt,
                         const char *hash) {
    User *user = (User *)calloc(1, sizeof(User));

    if (user == NULL) {
        return NULL;
    }
    snprintf(user->username, sizeof(user->username), "%s", username);
    snprintf(user->salt, sizeof(user->salt), "%s", salt);
    snprintf(user->password_hash, sizeof(user->password_hash), "%s", hash);
    user->socket_fd = -1;
    user->online = false;
    return user;
}

static int append_user_record(UserStore *store, const User *user) {
    FILE *fp;

    fp = fopen(store->storage_path, "a");
    if (fp == NULL) {
        return USER_ERR_IO;
    }
    if (fprintf(fp, "%s:%s:%s\n", user->username, user->salt,
                user->password_hash) < 0) {
        fclose(fp);
        return USER_ERR_IO;
    }
    if (fclose(fp) != 0) {
        return USER_ERR_IO;
    }
    return USER_OK;
}

static int ensure_storage_parent(const char *path) {
    char dir[512];
    char *slash;

    if (path == NULL || strlen(path) >= sizeof(dir)) {
        return -1;
    }
    snprintf(dir, sizeof(dir), "%s", path);
    slash = strrchr(dir, '/');
    if (slash == NULL) {
        return 0;
    }
    *slash = '\0';
    if (dir[0] == '\0') {
        return 0;
    }
    return ensure_directory(dir);
}

int user_store_init(UserStore *store, const char *storage_path) {
    if (store == NULL || storage_path == NULL ||
        strlen(storage_path) >= sizeof(store->storage_path)) {
        return -1;
    }
    memset(store, 0, sizeof(*store));
    snprintf(store->storage_path, sizeof(store->storage_path), "%s",
             storage_path);
    if (pthread_mutex_init(&store->mutex, NULL) != 0) {
        return -1;
    }
    return 0;
}

void user_store_destroy(UserStore *store) {
    User *cur;

    if (store == NULL) {
        return;
    }
    cur = store->head;
    while (cur != NULL) {
        User *next = cur->next;
        free(cur);
        cur = next;
    }
    pthread_mutex_destroy(&store->mutex);
    memset(store, 0, sizeof(*store));
}

int user_store_load(UserStore *store) {
    FILE *fp;
    char line[512];

    if (store == NULL) {
        return USER_ERR_INVALID;
    }
    if (ensure_storage_parent(store->storage_path) < 0) {
        return USER_ERR_IO;
    }

    fp = fopen(store->storage_path, "a+");
    if (fp == NULL) {
        return USER_ERR_IO;
    }
    rewind(fp);

    pthread_mutex_lock(&store->mutex);
    while (fgets(line, sizeof(line), fp) != NULL) {
        char *username = strtok(line, ":\n");
        char *salt = strtok(NULL, ":\n");
        char *hash = strtok(NULL, ":\n");
        User *user;

        if (username == NULL || salt == NULL || hash == NULL ||
            !valid_username(username) || strlen(salt) != SALT_HEX_LEN ||
            strlen(hash) != PASSWORD_HASH_HEX_LEN ||
            find_user_locked(store, username) != NULL) {
            continue;
        }

        user = create_user(username, salt, hash);
        if (user != NULL) {
            insert_user_locked(store, user);
        }
    }
    pthread_mutex_unlock(&store->mutex);
    fclose(fp);
    return USER_OK;
}

int user_store_register(UserStore *store, const char *username,
                        const char *password) {
    char salt[SALT_HEX_LEN + 1];
    char hash[PASSWORD_HASH_HEX_LEN + 1];
    User *user;
    int rc;

    if (store == NULL || !valid_username(username) || !valid_password(password)) {
        return USER_ERR_INVALID;
    }
    if (generate_salt_hex(salt, sizeof(salt)) < 0 ||
        hash_password(password, salt, hash, sizeof(hash)) < 0) {
        return USER_ERR_IO;
    }

    pthread_mutex_lock(&store->mutex);
    if (find_user_locked(store, username) != NULL) {
        pthread_mutex_unlock(&store->mutex);
        return USER_ERR_EXISTS;
    }
    user = create_user(username, salt, hash);
    if (user == NULL || insert_user_locked(store, user) < 0) {
        free(user);
        pthread_mutex_unlock(&store->mutex);
        return USER_ERR_IO;
    }
    rc = append_user_record(store, user);
    if (rc != USER_OK) {
        pthread_mutex_unlock(&store->mutex);
        return rc;
    }
    pthread_mutex_unlock(&store->mutex);
    return USER_OK;
}

int user_store_login(UserStore *store, const char *username,
                     const char *password, int socket_fd) {
    User *user;

    if (store == NULL || !valid_username(username) || !valid_password(password)) {
        return USER_ERR_INVALID;
    }
    pthread_mutex_lock(&store->mutex);
    user = find_user_locked(store, username);
    if (user == NULL) {
        pthread_mutex_unlock(&store->mutex);
        return USER_ERR_NOT_FOUND;
    }
    if (!verify_password(password, user->salt, user->password_hash)) {
        pthread_mutex_unlock(&store->mutex);
        return USER_ERR_BAD_PASSWORD;
    }
    if (user->online) {
        pthread_mutex_unlock(&store->mutex);
        return USER_ERR_ALREADY_ONLINE;
    }
    user->online = true;
    user->socket_fd = socket_fd;
    pthread_mutex_unlock(&store->mutex);
    return USER_OK;
}

int user_store_logout(UserStore *store, const char *username) {
    User *user;

    if (store == NULL || !valid_username(username)) {
        return USER_ERR_INVALID;
    }
    pthread_mutex_lock(&store->mutex);
    user = find_user_locked(store, username);
    if (user == NULL) {
        pthread_mutex_unlock(&store->mutex);
        return USER_ERR_NOT_FOUND;
    }
    user->online = false;
    user->socket_fd = -1;
    pthread_mutex_unlock(&store->mutex);
    return USER_OK;
}

int user_store_logout_fd(UserStore *store, int socket_fd) {
    User *cur;

    if (store == NULL) {
        return USER_ERR_INVALID;
    }
    pthread_mutex_lock(&store->mutex);
    for (cur = store->head; cur != NULL; cur = cur->next) {
        if (cur->online && cur->socket_fd == socket_fd) {
            cur->online = false;
            cur->socket_fd = -1;
            pthread_mutex_unlock(&store->mutex);
            return USER_OK;
        }
    }
    pthread_mutex_unlock(&store->mutex);
    return USER_ERR_NOT_FOUND;
}

bool user_store_has_user(UserStore *store, const char *username) {
    bool found;

    if (store == NULL || !valid_username(username)) {
        return false;
    }
    pthread_mutex_lock(&store->mutex);
    found = find_user_locked(store, username) != NULL;
    pthread_mutex_unlock(&store->mutex);
    return found;
}

int user_store_get_fd(UserStore *store, const char *username, int *socket_fd) {
    User *user;

    if (store == NULL || socket_fd == NULL || !valid_username(username)) {
        return USER_ERR_INVALID;
    }
    pthread_mutex_lock(&store->mutex);
    user = find_user_locked(store, username);
    if (user == NULL) {
        pthread_mutex_unlock(&store->mutex);
        return USER_ERR_NOT_FOUND;
    }
    if (!user->online) {
        pthread_mutex_unlock(&store->mutex);
        return USER_ERR_OFFLINE;
    }
    *socket_fd = user->socket_fd;
    pthread_mutex_unlock(&store->mutex);
    return USER_OK;
}

int user_store_online_list(UserStore *store, char *out, size_t out_size) {
    User *cur;
    size_t used = 0;
    int count = 0;

    if (store == NULL || out == NULL || out_size == 0) {
        return USER_ERR_INVALID;
    }
    out[0] = '\0';
    pthread_mutex_lock(&store->mutex);
    for (cur = store->head; cur != NULL; cur = cur->next) {
        if (!cur->online) {
            continue;
        }
        int n = snprintf(out + used, out_size - used, "%s%s", count == 0 ? "" : "\n",
                         cur->username);
        if (n < 0 || (size_t)n >= out_size - used) {
            pthread_mutex_unlock(&store->mutex);
            return USER_ERR_IO;
        }
        used += (size_t)n;
        count++;
    }
    pthread_mutex_unlock(&store->mutex);

    if (count == 0) {
        snprintf(out, out_size, "当前没有在线用户");
    }
    return USER_OK;
}

int user_store_snapshot_online_fds(UserStore *store, int except_fd, int *fds,
                                   size_t max_fds, size_t *count) {
    User *cur;
    size_t n = 0;

    if (store == NULL || fds == NULL || count == NULL) {
        return USER_ERR_INVALID;
    }
    pthread_mutex_lock(&store->mutex);
    for (cur = store->head; cur != NULL && n < max_fds; cur = cur->next) {
        if (cur->online && cur->socket_fd >= 0 && cur->socket_fd != except_fd) {
            fds[n++] = cur->socket_fd;
        }
    }
    pthread_mutex_unlock(&store->mutex);
    *count = n;
    return USER_OK;
}

int user_store_username_by_fd(UserStore *store, int socket_fd, char *out,
                              size_t out_size) {
    User *cur;

    if (store == NULL || out == NULL || out_size == 0) {
        return USER_ERR_INVALID;
    }
    pthread_mutex_lock(&store->mutex);
    for (cur = store->head; cur != NULL; cur = cur->next) {
        if (cur->online && cur->socket_fd == socket_fd) {
            snprintf(out, out_size, "%s", cur->username);
            pthread_mutex_unlock(&store->mutex);
            return USER_OK;
        }
    }
    pthread_mutex_unlock(&store->mutex);
    return USER_ERR_NOT_FOUND;
}

const char *user_result_message(int result) {
    switch (result) {
    case USER_OK:
        return "成功";
    case USER_ERR_EXISTS:
        return "用户名已存在";
    case USER_ERR_NOT_FOUND:
        return "用户不存在";
    case USER_ERR_BAD_PASSWORD:
        return "密码错误";
    case USER_ERR_ALREADY_ONLINE:
        return "用户已经在线";
    case USER_ERR_OFFLINE:
        return "用户不在线";
    case USER_ERR_INVALID:
        return "输入不合法";
    case USER_ERR_IO:
        return "系统读写错误";
    default:
        return "未知错误";
    }
}
