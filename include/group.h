#ifndef GROUP_H
#define GROUP_H

#include "protocol.h"

#include <pthread.h>
#include <stdbool.h>
#include <stddef.h>

#define GROUP_EVENT_CREATED "created"
#define GROUP_EVENT_MEMBER_LEFT "member_left"

typedef enum GroupResult {
    GROUP_OK = 0,
    GROUP_ERR_INVALID = -20,
    GROUP_ERR_FULL = -21,
    GROUP_ERR_NOT_FOUND = -22,
    GROUP_ERR_NOT_MEMBER = -23,
    GROUP_ERR_PAYLOAD = -24
} GroupResult;

typedef struct GroupPayload {
    unsigned char data[PACKET_DATA_MAX];
    size_t length;
} GroupPayload;

typedef struct GroupFields {
    char values[GROUP_PAYLOAD_MAX_FIELDS][PACKET_DATA_MAX];
    size_t count;
} GroupFields;

typedef struct GroupSnapshot {
    char id[GROUP_ID_MAX_LEN];
    char name[GROUP_NAME_MAX_LEN];
    char creator[USERNAME_MAX_LEN];
    char members[GROUP_MAX_MEMBERS][USERNAME_MAX_LEN];
    size_t member_count;
} GroupSnapshot;

typedef struct GroupChange {
    char event[32];
    GroupSnapshot group;
} GroupChange;

typedef struct Group Group;

typedef struct GroupStore {
    Group *head;
    unsigned int next_id;
    size_t count;
    pthread_mutex_t mutex;
} GroupStore;

int group_payload_init(GroupPayload *payload);
int group_payload_add(GroupPayload *payload, const char *field);
int group_payload_parse(const unsigned char *data, size_t length,
                        GroupFields *fields);
int group_payload_build_record(GroupPayload *payload,
                               const GroupSnapshot *snapshot);
int group_payload_build_event(const char *event,
                              const GroupSnapshot *snapshot,
                              GroupPayload *payload);
int group_payload_build_message(const GroupSnapshot *snapshot,
                                const char *text, GroupPayload *payload);

int group_store_init(GroupStore *store);
void group_store_destroy(GroupStore *store);
int group_store_create(GroupStore *store, const char *creator,
                       const char *name, const char *const *members,
                       size_t member_count, GroupSnapshot *out);
int group_store_get_snapshot(GroupStore *store, const char *group_id,
                             GroupSnapshot *out);
int group_store_build_list_payload(GroupStore *store, const char *username,
                                   GroupPayload *payload);
int group_store_remove_member(GroupStore *store, const char *username,
                              GroupChange *changes, size_t max_changes,
                              size_t *change_count);
bool group_snapshot_has_member(const GroupSnapshot *snapshot,
                               const char *username);
const char *group_result_message(int result);

#endif
