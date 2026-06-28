#include "group.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct Group {
    GroupSnapshot snapshot;
    struct Group *next;
};

static bool valid_group_name(const char *name) {
    return name != NULL && name[0] != '\0' &&
           strlen(name) < GROUP_NAME_MAX_LEN && strchr(name, '\n') == NULL;
}

static bool valid_group_id(const char *group_id) {
    return group_id != NULL && group_id[0] != '\0' &&
           strlen(group_id) < GROUP_ID_MAX_LEN && strchr(group_id, '\n') == NULL;
}

static bool valid_member_name(const char *username) {
    return username != NULL && username[0] != '\0' &&
           strlen(username) < USERNAME_MAX_LEN && strchr(username, ':') == NULL &&
           strchr(username, '\n') == NULL;
}

static void copy_fixed(char *dest, size_t dest_size, const char *src) {
    memset(dest, 0, dest_size);
    if (src != NULL && dest_size > 0) {
        strncpy(dest, src, dest_size - 1);
    }
}

static void copy_snapshot(GroupSnapshot *dest, const GroupSnapshot *src) {
    if (dest != NULL && src != NULL) {
        memcpy(dest, src, sizeof(*dest));
    }
}

static Group *find_group_locked(GroupStore *store, const char *group_id) {
    Group *cur;

    if (store == NULL || !valid_group_id(group_id)) {
        return NULL;
    }
    for (cur = store->head; cur != NULL; cur = cur->next) {
        if (strcmp(cur->snapshot.id, group_id) == 0) {
            return cur;
        }
    }
    return NULL;
}

static int member_index(const GroupSnapshot *snapshot, const char *username) {
    if (snapshot == NULL || !valid_member_name(username)) {
        return -1;
    }
    for (size_t i = 0; i < snapshot->member_count; ++i) {
        if (strcmp(snapshot->members[i], username) == 0) {
            return (int)i;
        }
    }
    return -1;
}

static int add_member(GroupSnapshot *snapshot, const char *username,
                      bool *added) {
    if (added != NULL) {
        *added = false;
    }
    if (snapshot == NULL || !valid_member_name(username)) {
        return GROUP_ERR_INVALID;
    }
    if (member_index(snapshot, username) >= 0) {
        return GROUP_OK;
    }
    if (snapshot->member_count >= GROUP_MAX_MEMBERS) {
        return GROUP_ERR_FULL;
    }
    copy_fixed(snapshot->members[snapshot->member_count],
               sizeof(snapshot->members[snapshot->member_count]), username);
    snapshot->member_count++;
    if (added != NULL) {
        *added = true;
    }
    return GROUP_OK;
}

static void remove_member_at(GroupSnapshot *snapshot, size_t index) {
    if (snapshot == NULL || index >= snapshot->member_count) {
        return;
    }
    for (size_t i = index; i + 1 < snapshot->member_count; ++i) {
        copy_fixed(snapshot->members[i], sizeof(snapshot->members[i]),
                   snapshot->members[i + 1]);
    }
    memset(snapshot->members[snapshot->member_count - 1], 0,
           sizeof(snapshot->members[snapshot->member_count - 1]));
    snapshot->member_count--;
}

bool group_snapshot_has_member(const GroupSnapshot *snapshot,
                               const char *username) {
    return member_index(snapshot, username) >= 0;
}

int group_payload_init(GroupPayload *payload) {
    if (payload == NULL) {
        return GROUP_ERR_INVALID;
    }
    memset(payload, 0, sizeof(*payload));
    return GROUP_OK;
}

int group_payload_add(GroupPayload *payload, const char *field) {
    size_t len;

    if (payload == NULL || field == NULL) {
        return GROUP_ERR_INVALID;
    }
    len = strlen(field);
    if (payload->length + len + 1 > PACKET_DATA_MAX) {
        return GROUP_ERR_PAYLOAD;
    }
    memcpy(payload->data + payload->length, field, len);
    payload->length += len;
    payload->data[payload->length++] = '\0';
    return GROUP_OK;
}

int group_payload_parse(const unsigned char *data, size_t length,
                        GroupFields *fields) {
    size_t start = 0;

    if (fields == NULL || (data == NULL && length > 0)) {
        return GROUP_ERR_INVALID;
    }
    memset(fields, 0, sizeof(*fields));
    if (length == 0) {
        return GROUP_OK;
    }
    if (length > PACKET_DATA_MAX || data[length - 1] != '\0') {
        return GROUP_ERR_PAYLOAD;
    }

    for (size_t i = 0; i < length; ++i) {
        if (data[i] != '\0') {
            continue;
        }
        if (fields->count >= GROUP_PAYLOAD_MAX_FIELDS) {
            return GROUP_ERR_PAYLOAD;
        }
        size_t field_len = i - start;
        if (field_len >= PACKET_DATA_MAX) {
            return GROUP_ERR_PAYLOAD;
        }
        memcpy(fields->values[fields->count], data + start, field_len);
        fields->values[fields->count][field_len] = '\0';
        fields->count++;
        start = i + 1;
    }
    return GROUP_OK;
}

int group_payload_build_record(GroupPayload *payload,
                               const GroupSnapshot *snapshot) {
    char count_text[32];

    if (payload == NULL || snapshot == NULL) {
        return GROUP_ERR_INVALID;
    }
    snprintf(count_text, sizeof(count_text), "%zu", snapshot->member_count);
    if (group_payload_add(payload, snapshot->id) != GROUP_OK ||
        group_payload_add(payload, snapshot->name) != GROUP_OK ||
        group_payload_add(payload, snapshot->creator) != GROUP_OK ||
        group_payload_add(payload, count_text) != GROUP_OK) {
        return GROUP_ERR_PAYLOAD;
    }
    for (size_t i = 0; i < snapshot->member_count; ++i) {
        if (group_payload_add(payload, snapshot->members[i]) != GROUP_OK) {
            return GROUP_ERR_PAYLOAD;
        }
    }
    return GROUP_OK;
}

int group_payload_build_event(const char *event,
                              const GroupSnapshot *snapshot,
                              GroupPayload *payload) {
    int rc;

    rc = group_payload_init(payload);
    if (rc != GROUP_OK) {
        return rc;
    }
    if (group_payload_add(payload, event) != GROUP_OK) {
        return GROUP_ERR_PAYLOAD;
    }
    return group_payload_build_record(payload, snapshot);
}

int group_payload_build_message(const GroupSnapshot *snapshot,
                                const char *text, GroupPayload *payload) {
    int rc;

    if (snapshot == NULL || text == NULL || text[0] == '\0') {
        return GROUP_ERR_INVALID;
    }
    rc = group_payload_init(payload);
    if (rc != GROUP_OK) {
        return rc;
    }
    if (group_payload_add(payload, snapshot->id) != GROUP_OK ||
        group_payload_add(payload, snapshot->name) != GROUP_OK ||
        group_payload_add(payload, text) != GROUP_OK) {
        return GROUP_ERR_PAYLOAD;
    }
    return GROUP_OK;
}

int group_store_init(GroupStore *store) {
    if (store == NULL) {
        return GROUP_ERR_INVALID;
    }
    memset(store, 0, sizeof(*store));
    store->next_id = 1;
    if (pthread_mutex_init(&store->mutex, NULL) != 0) {
        return GROUP_ERR_INVALID;
    }
    return GROUP_OK;
}

void group_store_destroy(GroupStore *store) {
    Group *cur;

    if (store == NULL) {
        return;
    }
    cur = store->head;
    while (cur != NULL) {
        Group *next = cur->next;
        free(cur);
        cur = next;
    }
    pthread_mutex_destroy(&store->mutex);
    memset(store, 0, sizeof(*store));
}

int group_store_create(GroupStore *store, const char *creator,
                       const char *name, const char *const *members,
                       size_t member_count, GroupSnapshot *out) {
    Group *group;
    bool has_non_creator = false;
    int rc = GROUP_OK;

    if (store == NULL || !valid_member_name(creator) ||
        !valid_group_name(name) || members == NULL || member_count == 0) {
        return GROUP_ERR_INVALID;
    }

    group = (Group *)calloc(1, sizeof(*group));
    if (group == NULL) {
        return GROUP_ERR_INVALID;
    }
    copy_fixed(group->snapshot.name, sizeof(group->snapshot.name), name);
    copy_fixed(group->snapshot.creator, sizeof(group->snapshot.creator), creator);

    rc = add_member(&group->snapshot, creator, NULL);
    if (rc != GROUP_OK) {
        free(group);
        return rc;
    }
    for (size_t i = 0; i < member_count; ++i) {
        bool added = false;
        if (!valid_member_name(members[i])) {
            free(group);
            return GROUP_ERR_INVALID;
        }
        rc = add_member(&group->snapshot, members[i], &added);
        if (rc != GROUP_OK) {
            free(group);
            return rc;
        }
        if (added && strcmp(members[i], creator) != 0) {
            has_non_creator = true;
        }
    }
    if (!has_non_creator) {
        free(group);
        return GROUP_ERR_INVALID;
    }

    pthread_mutex_lock(&store->mutex);
    if (store->count >= GROUP_MAX_GROUPS) {
        pthread_mutex_unlock(&store->mutex);
        free(group);
        return GROUP_ERR_FULL;
    }
    snprintf(group->snapshot.id, sizeof(group->snapshot.id), "g%06u",
             store->next_id++);
    group->next = store->head;
    store->head = group;
    store->count++;
    copy_snapshot(out, &group->snapshot);
    pthread_mutex_unlock(&store->mutex);
    return GROUP_OK;
}

int group_store_get_snapshot(GroupStore *store, const char *group_id,
                             GroupSnapshot *out) {
    Group *group;

    if (store == NULL || out == NULL || !valid_group_id(group_id)) {
        return GROUP_ERR_INVALID;
    }
    pthread_mutex_lock(&store->mutex);
    group = find_group_locked(store, group_id);
    if (group == NULL) {
        pthread_mutex_unlock(&store->mutex);
        return GROUP_ERR_NOT_FOUND;
    }
    copy_snapshot(out, &group->snapshot);
    pthread_mutex_unlock(&store->mutex);
    return GROUP_OK;
}

int group_store_build_list_payload(GroupStore *store, const char *username,
                                   GroupPayload *payload) {
    Group *cur;
    char count_text[32];
    size_t group_count = 0;
    int rc;

    if (store == NULL || !valid_member_name(username)) {
        return GROUP_ERR_INVALID;
    }
    rc = group_payload_init(payload);
    if (rc != GROUP_OK) {
        return rc;
    }

    pthread_mutex_lock(&store->mutex);
    for (cur = store->head; cur != NULL; cur = cur->next) {
        if (group_snapshot_has_member(&cur->snapshot, username)) {
            group_count++;
        }
    }
    snprintf(count_text, sizeof(count_text), "%zu", group_count);
    rc = group_payload_add(payload, count_text);
    if (rc == GROUP_OK) {
        for (cur = store->head; cur != NULL; cur = cur->next) {
            if (!group_snapshot_has_member(&cur->snapshot, username)) {
                continue;
            }
            rc = group_payload_build_record(payload, &cur->snapshot);
            if (rc != GROUP_OK) {
                break;
            }
        }
    }
    pthread_mutex_unlock(&store->mutex);
    return rc;
}

int group_store_remove_member(GroupStore *store, const char *username,
                              GroupChange *changes, size_t max_changes,
                              size_t *change_count) {
    Group *cur;
    Group *prev = NULL;
    size_t generated = 0;
    int rc = GROUP_OK;

    if (store == NULL || !valid_member_name(username) || change_count == NULL ||
        (max_changes > 0 && changes == NULL)) {
        return GROUP_ERR_INVALID;
    }
    *change_count = 0;

    pthread_mutex_lock(&store->mutex);
    cur = store->head;
    while (cur != NULL) {
        Group *next = cur->next;
        int index = member_index(&cur->snapshot, username);

        if (index < 0) {
            prev = cur;
            cur = next;
            continue;
        }

        remove_member_at(&cur->snapshot, (size_t)index);
        if (cur->snapshot.member_count == 0) {
            if (prev == NULL) {
                store->head = next;
            } else {
                prev->next = next;
            }
            free(cur);
            store->count--;
            cur = next;
            continue;
        }

        if (generated >= max_changes) {
            rc = GROUP_ERR_FULL;
        } else {
            copy_fixed(changes[generated].event, sizeof(changes[generated].event),
                       GROUP_EVENT_MEMBER_LEFT);
            copy_snapshot(&changes[generated].group, &cur->snapshot);
            generated++;
        }
        prev = cur;
        cur = next;
    }
    pthread_mutex_unlock(&store->mutex);
    *change_count = generated;
    return rc;
}

const char *group_result_message(int result) {
    switch (result) {
    case GROUP_OK:
        return "成功";
    case GROUP_ERR_INVALID:
        return "群聊输入不合法";
    case GROUP_ERR_FULL:
        return "群聊数量或成员数量已达上限";
    case GROUP_ERR_NOT_FOUND:
        return "群聊不存在";
    case GROUP_ERR_NOT_MEMBER:
        return "当前用户不在该群聊中";
    case GROUP_ERR_PAYLOAD:
        return "群聊协议数据不合法";
    default:
        return "未知群聊错误";
    }
}
