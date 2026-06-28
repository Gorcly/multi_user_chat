# Online Temp Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现由 C 服务端维护的在线临时群聊，删除 Web 前端初始硬编码群组，并允许创建者从当前在线用户中直接选择群成员。

**Architecture:** 保留旧 `MSG_GROUP` 的全局广播兼容语义，新增 `MSG_GROUP_CREATE`、`MSG_GROUP_LIST`、`MSG_GROUP_MESSAGE`、`MSG_GROUP_EVENT` 作为真正群聊协议。C 服务端新增内存态 `GroupStore`，Web 网关把浏览器动作转换为新协议，前端只展示服务端返回的群。群协议 payload 使用 `Packet.data` 中的 NUL 分隔 UTF-8 字段，避免引入 C JSON 解析依赖。

**Tech Stack:** C11 风格代码、pthread mutex、现有 `Packet` TCP 协议、Node.js `node:test`、浏览器原生 DOM/WebSocket。

---

## 约束与提交边界

- 不提交 git commit；用户明确要求后再按 tight staging 提交。
- 不回退已有未授权改动；当前工作树已有 Web 与 Superpowers 文件改动。
- 注释、文档和用户可见说明使用中文；代码标识符沿用现有英文风格。
- Linux shell 没有可用 `node`；Web 测试使用 `/mnt/c/Users/Gorcly/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。

## 协议格式

新增消息类型追加在现有枚举末尾，避免改变旧编号：

```c
MSG_GROUP_CREATE = 14,
MSG_GROUP_LIST = 15,
MSG_GROUP_MESSAGE = 16,
MSG_GROUP_EVENT = 17
```

群协议字段格式：

- `Packet.data` 是多个 UTF-8 字段按 `\0` 分隔的二进制 payload。
- 所有字段不得包含 NUL；群名和用户名不得为空。
- `MSG_GROUP_CREATE` 请求字段：`[name, member1, member2, ...]`。
- `MSG_GROUP_LIST` 响应字段：`[groupCount, groupId, name, creator, memberCount, member1, ...]`，重复 group record。
- `MSG_GROUP_EVENT` 推送字段：`[event, groupId, name, creator, memberCount, member1, ...]`，`event` 为 `created` 或 `member_left`。
- `MSG_GROUP_MESSAGE` 浏览器到服务端请求：`receiver = groupId`，`data = text\0`。
- `MSG_GROUP_MESSAGE` 服务端到成员推送字段：`[groupId, groupName, text]`。

## 文件结构

- Modify: `include/protocol.h`，追加消息类型和群常量。
- Modify: `common/protocol.c`，让 `message_type_name()` 识别新增类型。
- Create: `include/group.h`，定义群 payload helper、`GroupStore`、快照和结果码。
- Create: `common/group.c`，实现群 payload 解析、内存群存储、成员增删和列表编码。
- Modify: `Makefile`，把 `common/group.c` 加入 `COMMON_SRC`。
- Modify: `test/unit_tests.c`，新增群 payload 与 `GroupStore` 单元测试。
- Modify: `server/server.c`，初始化 `GroupStore`、新增群协议处理、离线自动退群和事件推送。
- Modify: `web/lib/protocol.js`，同步消息类型并新增群 payload helper。
- Modify: `web/test/protocol.test.js`，覆盖 JS 群 payload helper。
- Modify: `web/server.js`，新增 `create_group`、`group_list`、`send_group_message`，解析群事件、群列表和群消息。
- Modify: `web/test/gateway.integration.test.js`，覆盖三用户真实群聊流。
- Modify: `web/public/index.html`，新增群创建入口和对话框。
- Modify: `web/public/main.js`，删除硬编码群，改用服务端群列表与事件。
- Modify: `web/public/style.css`，补齐群创建 UI 样式。

## Task 1: JS 协议 helper 先红

**Files:**
- Modify: `web/test/protocol.test.js`

- [ ] **Step 1: 写失败测试**

在 `web/test/protocol.test.js` 的 import 中加入：

```js
  decodeGroupEventPayload,
  decodeGroupListPayload,
  decodeGroupMessagePayload,
  encodeGroupCreatePayload,
  encodeGroupMessagePayload,
```

在文件末尾追加：

```js
test('group payload helpers encode and decode nul-separated fields', () => {
  const createPayload = encodeGroupCreatePayload('项目组', ['bob', 'carol']);
  assert.deepEqual([...createPayload], [...Buffer.from('项目组\0bob\0carol\0', 'utf8')]);

  const messagePayload = encodeGroupMessagePayload('g000001', 'hello\nteam');
  assert.deepEqual(decodeGroupMessagePayload(Buffer.from('g000001\0项目组\0hello\nteam\0', 'utf8')), {
    groupId: 'g000001',
    groupName: '项目组',
    text: 'hello\nteam',
  });
  assert.deepEqual([...messagePayload], [...Buffer.from('hello\nteam\0', 'utf8')]);

  const eventPayload = Buffer.from(['created', 'g000001', '项目组', 'alice', '3', 'alice', 'bob', 'carol'].join('\0') + '\0', 'utf8');
  assert.deepEqual(decodeGroupEventPayload(eventPayload), {
    event: 'created',
    group: {
      id: 'g000001',
      name: '项目组',
      creator: 'alice',
      members: ['alice', 'bob', 'carol'],
    },
  });

  const listPayload = Buffer.from(['1', 'g000001', '项目组', 'alice', '3', 'alice', 'bob', 'carol'].join('\0') + '\0', 'utf8');
  assert.deepEqual(decodeGroupListPayload(listPayload), [
    {
      id: 'g000001',
      name: '项目组',
      creator: 'alice',
      members: ['alice', 'bob', 'carol'],
    },
  ]);
});

test('group payload helpers reject invalid fields', () => {
  assert.throws(() => encodeGroupCreatePayload('', ['bob']), /群名/);
  assert.throws(() => encodeGroupCreatePayload('team', []), /至少选择/);
  assert.throws(() => encodeGroupCreatePayload('bad\0name', ['bob']), /NUL/);
  assert.throws(() => encodeGroupMessagePayload('', 'hello'), /群 ID/);
  assert.throws(() => encodeGroupMessagePayload('g000001', ''), /消息/);
  const malformedEventPayload = Buffer.from(['created', 'g1', 'name', 'alice', '2', 'alice'].join('\0') + '\0', 'utf8');
  assert.throws(() => decodeGroupEventPayload(malformedEventPayload), /成员数量/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
/mnt/c/Users/Gorcly/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe --test /home/gorcly/multi_user_chat/web/test/protocol.test.js
```

Expected: FAIL，错误指出 `../lib/protocol.js` 没有导出新增 helper。

## Task 2: 实现 JS 协议 helper

**Files:**
- Modify: `web/lib/protocol.js`
- Test: `web/test/protocol.test.js`

- [ ] **Step 1: 同步消息类型**

在 `MessageType` 末尾追加：

```js
  MSG_GROUP_CREATE: 14,
  MSG_GROUP_LIST: 15,
  MSG_GROUP_MESSAGE: 16,
  MSG_GROUP_EVENT: 17,
```

- [ ] **Step 2: 添加群字段 helper**

在 `packetText()` 后添加：

```js
function assertGroupField(value, fieldName, { allowEmpty = false } = {}) {
  const text = String(value ?? '');
  if (!allowEmpty && text.length === 0) {
    throw new Error(`${fieldName}不能为空`);
  }
  if (text.includes('\0')) {
    throw new Error(`${fieldName}不能包含 NUL 字符`);
  }
  return text;
}

export function encodeGroupFields(fields) {
  const chunks = [];
  let total = 0;
  for (const field of fields) {
    const bytes = Buffer.from(`${assertGroupField(field, '群字段', { allowEmpty: true })}\0`, 'utf8');
    total += bytes.length;
    if (total > PACKET_DATA_MAX) {
      throw new Error(`群协议 payload 不能超过 ${PACKET_DATA_MAX} 字节`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function decodeGroupFields(data) {
  if (!Buffer.isBuffer(data)) {
    throw new Error('群协议 payload 必须是 Buffer');
  }
  if (data.length === 0) {
    return [];
  }
  if (data[data.length - 1] !== 0) {
    throw new Error('群协议 payload 必须以 NUL 结束');
  }
  return data.subarray(0, data.length - 1).toString('utf8').split('\0');
}

export function encodeGroupCreatePayload(name, members) {
  const groupName = assertGroupField(name, '群名').trim();
  const uniqueMembers = Array.from(new Set((members || []).map((item) => assertGroupField(item, '群成员').trim()).filter(Boolean)));
  if (groupName.length === 0) {
    throw new Error('群名不能为空');
  }
  if (uniqueMembers.length === 0) {
    throw new Error('请至少选择一名在线成员');
  }
  return encodeGroupFields([groupName, ...uniqueMembers]);
}

export function encodeGroupMessagePayload(groupId, text) {
  const id = assertGroupField(groupId, '群 ID').trim();
  const body = assertGroupField(text, '消息');
  return encodeTextPacket({ type: MessageType.MSG_GROUP_MESSAGE, sender: '', receiver: id, text: body }).subarray(WIRE_HEADER_BYTES);
}

function parseGroupRecord(fields, index) {
  if (index + 4 > fields.length) {
    throw new Error('群记录字段不足');
  }
  const id = fields[index++];
  const name = fields[index++];
  const creator = fields[index++];
  const memberCount = Number(fields[index++]);
  if (!Number.isInteger(memberCount) || memberCount < 0) {
    throw new Error('成员数量不合法');
  }
  if (index + memberCount > fields.length) {
    throw new Error('成员数量和字段数量不匹配');
  }
  const members = fields.slice(index, index + memberCount);
  return [{ id, name, creator, members }, index + memberCount];
}

export function decodeGroupEventPayload(data) {
  const fields = decodeGroupFields(data);
  if (fields.length < 5) {
    throw new Error('群事件字段不足');
  }
  const event = fields[0];
  const [group, nextIndex] = parseGroupRecord(fields, 1);
  if (nextIndex !== fields.length) {
    throw new Error('群事件包含多余字段');
  }
  return { event, group };
}

export function decodeGroupListPayload(data) {
  const fields = decodeGroupFields(data);
  if (fields.length === 0) {
    return [];
  }
  const groupCount = Number(fields[0]);
  if (!Number.isInteger(groupCount) || groupCount < 0) {
    throw new Error('群数量不合法');
  }
  const groups = [];
  let index = 1;
  for (let i = 0; i < groupCount; i += 1) {
    const [group, nextIndex] = parseGroupRecord(fields, index);
    groups.push(group);
    index = nextIndex;
  }
  if (index !== fields.length) {
    throw new Error('群列表包含多余字段');
  }
  return groups;
}

export function decodeGroupMessagePayload(data) {
  const fields = decodeGroupFields(data);
  if (fields.length !== 3) {
    throw new Error('群消息字段数量不合法');
  }
  return { groupId: fields[0], groupName: fields[1], text: fields[2] };
}
```

- [ ] **Step 3: 运行协议测试**

Run:

```bash
/mnt/c/Users/Gorcly/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe --test /home/gorcly/multi_user_chat/web/test/protocol.test.js
```

Expected: PASS。

## Task 3: C 群模块先红

**Files:**
- Modify: `test/unit_tests.c`

- [ ] **Step 1: 写失败测试**

在 include 列表加入：

```c
#include "group.h"
```

在 `test_file_save_path_avoids_conflict()` 后追加：

```c
static void test_group_payload_round_trip(void) {
    GroupPayload payload;
    GroupFields fields;

    ASSERT_EQ_INT(group_payload_init(&payload), 0);
    ASSERT_EQ_INT(group_payload_add(&payload, "created"), 0);
    ASSERT_EQ_INT(group_payload_add(&payload, "g000001"), 0);
    ASSERT_EQ_INT(group_payload_add(&payload, "项目组"), 0);
    ASSERT_EQ_INT(group_payload_parse(payload.data, payload.length, &fields), 0);
    ASSERT_EQ_INT((int)fields.count, 3);
    ASSERT_STREQ(fields.values[0], "created");
    ASSERT_STREQ(fields.values[1], "g000001");
    ASSERT_STREQ(fields.values[2], "项目组");
}

static void test_group_store_create_and_list(void) {
    GroupStore store;
    GroupSnapshot snapshot;
    GroupPayload payload;
    GroupFields fields;
    const char *members[] = {"bob", "carol", "bob"};

    ASSERT_EQ_INT(group_store_init(&store), 0);
    ASSERT_EQ_INT(group_store_create(&store, "alice", "项目组", members, 3, &snapshot), GROUP_OK);
    ASSERT_STREQ(snapshot.id, "g000001");
    ASSERT_STREQ(snapshot.name, "项目组");
    ASSERT_EQ_INT((int)snapshot.member_count, 3);
    ASSERT_TRUE(group_snapshot_has_member(&snapshot, "alice"));
    ASSERT_TRUE(group_snapshot_has_member(&snapshot, "bob"));
    ASSERT_TRUE(group_snapshot_has_member(&snapshot, "carol"));

    ASSERT_EQ_INT(group_store_build_list_payload(&store, "bob", &payload), GROUP_OK);
    ASSERT_EQ_INT(group_payload_parse(payload.data, payload.length, &fields), 0);
    ASSERT_STREQ(fields.values[0], "1");
    ASSERT_STREQ(fields.values[1], "g000001");
    ASSERT_STREQ(fields.values[2], "项目组");
    ASSERT_STREQ(fields.values[4], "3");

    group_store_destroy(&store);
}

static void test_group_store_remove_member_and_delete_empty(void) {
    GroupStore store;
    GroupSnapshot snapshot;
    GroupChange changes[4];
    size_t change_count = 0;
    const char *members[] = {"bob"};

    ASSERT_EQ_INT(group_store_init(&store), 0);
    ASSERT_EQ_INT(group_store_create(&store, "alice", "临时群", members, 1, &snapshot), GROUP_OK);
    ASSERT_EQ_INT(group_store_remove_member(&store, "bob", changes, 4, &change_count), GROUP_OK);
    ASSERT_EQ_INT((int)change_count, 1);
    ASSERT_STREQ(changes[0].event, GROUP_EVENT_MEMBER_LEFT);
    ASSERT_TRUE(group_snapshot_has_member(&changes[0].group, "alice"));
    ASSERT_TRUE(!group_snapshot_has_member(&changes[0].group, "bob"));

    ASSERT_EQ_INT(group_store_remove_member(&store, "alice", changes, 4, &change_count), GROUP_OK);
    ASSERT_EQ_INT((int)change_count, 0);
    ASSERT_EQ_INT(group_store_get_snapshot(&store, "g000001", &snapshot), GROUP_ERR_NOT_FOUND);

    group_store_destroy(&store);
}
```

在 `main()` 中调用：

```c
    test_group_payload_round_trip();
    test_group_store_create_and_list();
    test_group_store_remove_member_and_delete_empty();
```

- [ ] **Step 2: 运行单元测试确认失败**

Run:

```bash
make unit
```

Expected: FAIL，编译错误包含 `group.h: No such file or directory`。

## Task 4: 实现 C 群模块和协议常量

**Files:**
- Modify: `include/protocol.h`
- Modify: `common/protocol.c`
- Create: `include/group.h`
- Create: `common/group.c`
- Modify: `Makefile`
- Test: `test/unit_tests.c`

- [ ] **Step 1: 更新 `include/protocol.h`**

在 `FILE_TRANSFER_MAX_BYTES` 后添加：

```c
#define GROUP_ID_MAX_LEN 32
#define GROUP_NAME_MAX_LEN 64
#define GROUP_MAX_MEMBERS 64
#define GROUP_MAX_GROUPS 128
#define GROUP_EVENT_MAX_CHANGES 64
#define GROUP_PAYLOAD_MAX_FIELDS 128
```

在 `MSG_ERROR = 13` 后追加新增枚举，并保留旧编号：

```c
    MSG_ERROR = 13,
    MSG_GROUP_CREATE = 14,
    MSG_GROUP_LIST = 15,
    MSG_GROUP_MESSAGE = 16,
    MSG_GROUP_EVENT = 17
```

- [ ] **Step 2: 更新 `message_type_name()`**

在 `common/protocol.c` 的 switch 中追加：

```c
    case MSG_GROUP_CREATE:
        return "GROUP_CREATE";
    case MSG_GROUP_LIST:
        return "GROUP_LIST";
    case MSG_GROUP_MESSAGE:
        return "GROUP_MESSAGE";
    case MSG_GROUP_EVENT:
        return "GROUP_EVENT";
```

- [ ] **Step 3: 创建 `include/group.h`**

文件内容：

```c
#ifndef GROUP_H
#define GROUP_H

#include "protocol.h"

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
                                const char *text,
                                GroupPayload *payload);

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
```

Add `#include <pthread.h>` above the `GroupStore` declaration because `pthread_mutex_t` is part of the public struct.

- [ ] **Step 4: 创建 `common/group.c`**

实现要点固定如下：

- `Group` 私有结构包含 `GroupSnapshot snapshot` 和 `Group *next`。
- `group_payload_add()` 将字段字节和尾随 NUL 写入 `payload->data`，拒绝空指针、包含 NUL 的字段和超过 `PACKET_DATA_MAX` 的 payload。
- `group_payload_parse()` 按实际 `length` 扫描 NUL，复制字段到 `GroupFields.values`，拒绝未以 NUL 结束、字段数超过 `GROUP_PAYLOAD_MAX_FIELDS`、单字段超过 `PACKET_DATA_MAX - 1`。
- `group_store_create()` 生成 `g%06u` ID；创建者先加入；候选成员去重；空群名、空创建者、候选成员数为 0、群数量超过 `GROUP_MAX_GROUPS` 返回错误。
- `group_store_build_list_payload()` 先写用户所属群数量，再按 record 格式写入每个群。
- `group_store_remove_member()` 从包含用户的每个群中删除成员；非空群产生 `member_left` change；空群直接删除且不产生 change。

- [ ] **Step 5: 更新 `Makefile`**

在 `COMMON_SRC` 中加入：

```make
	common/group.c \
```

放在 `common/user.c` 后，便于阅读公共状态模块。

- [ ] **Step 6: 运行 C 单元测试**

Run:

```bash
make unit
```

Expected: PASS，输出 `unit tests passed`。

## Task 5: C 服务端接入真正群协议

**Files:**
- Modify: `server/server.c`
- Test: `test/unit_tests.c`

- [ ] **Step 1: 引入群模块并扩展状态**

在 include 区加入：

```c
#include "group.h"
```

在 `ServerState` 中加入：

```c
    GroupStore groups;
```

在 `main()` 初始化用户存储成功后初始化群存储；所有失败分支销毁已初始化资源：

```c
    if (group_store_init(&g_state.groups) != 0) {
        fprintf(stderr, "群聊数据初始化失败\n");
        user_store_destroy(&g_state.users);
        return 1;
    }
```

退出前调用：

```c
    group_store_destroy(&g_state.groups);
```

- [ ] **Step 2: 新增通用离线清理 helper**

在 `handle_group()` 后添加：

```c
static void push_group_event(ServerState *state, const char *event,
                             const GroupSnapshot *snapshot);

static void cleanup_offline_fd(ServerState *state, int fd) {
    char username[USERNAME_MAX_LEN];
    GroupChange changes[GROUP_EVENT_MAX_CHANGES];
    size_t change_count = 0;

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
```

把 `handle_private()`、旧 `handle_group()`、`handle_file_packet()` 和 `client_handler()` 中直接调用 `user_store_logout_fd()` 的失败/断开路径替换为 `cleanup_offline_fd(state, fd)` 或 `cleanup_offline_fd(state, target_fd)`。

- [ ] **Step 3: 新增群事件推送 helper**

添加：

```c
static void send_group_payload_to_fd(ServerState *state, int fd, int type,
                                     const GroupPayload *payload) {
    Packet packet;
    if (packet_init(&packet, type, "server", "", payload->data,
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
                                     &payload);
        }
    }
}
```

- [ ] **Step 4: 实现 `handle_group_create()`**

添加行为：

- 要求 `user_store_username_by_fd()` 能拿到当前用户名。
- 解析 `MSG_GROUP_CREATE` payload 字段。
- 群名来自字段 0；字段 1 之后是创建者选择的在线成员。
- 字段 1 之后数量为 0 时返回 `MSG_ERROR`：`请至少选择一名在线成员`。
- 每个被选成员必须 `user_store_get_fd()` 成功，否则返回 `MSG_ERROR`：`群成员必须是当前在线用户`。
- 调用 `group_store_create()`；成功后向成员推送 `created` 事件，并向创建者发 `MSG_OK`：`群聊已创建`。

- [ ] **Step 5: 实现 `handle_group_list()`**

添加行为：

- 要求登录。
- `group_store_build_list_payload(&state->groups, username, &payload)`。
- 发送 `MSG_GROUP_LIST`，`sender = server`，`receiver = username`。

- [ ] **Step 6: 实现 `handle_group_message()`**

添加行为：

- 要求登录。
- `packet->receiver` 是 `group_id`；文本来自 `(const char *)packet->data`。
- `group_store_get_snapshot()` 拿群快照，`group_snapshot_has_member()` 校验发送者。
- `group_payload_build_message()` 生成 `[groupId, groupName, text]`。
- 向群内所有在线成员发送 `MSG_GROUP_MESSAGE`，`sender = username`，`receiver = group_id`。
- 发送失败时对失败 fd 调用 `cleanup_offline_fd()`。
- 发送结束后向发送者返回 `MSG_OK`：`群聊消息已发送`。

- [ ] **Step 7: 接入 switch**

在 `process_packet()` 中加入：

```c
    case MSG_GROUP_CREATE:
        handle_group_create(state, fd, packet);
        break;
    case MSG_GROUP_LIST:
        handle_group_list(state, fd);
        break;
    case MSG_GROUP_MESSAGE:
        handle_group_message(state, fd, packet);
        break;
```

`MSG_GROUP_EVENT` 是服务端推送类型，收到客户端主动发来时走默认非法消息。

- [ ] **Step 8: 编译服务端**

Run:

```bash
make all
```

Expected: PASS，生成 `server_app` 和 `client_app`。

## Task 6: 网关真实群聊集成测试先红

**Files:**
- Modify: `web/test/gateway.integration.test.js`

- [ ] **Step 1: 扩展测试 helper**

在 `connectGateway()` 返回对象中加入：

```js
    async waitForNoMessage(type, predicate, timeoutMs = 300) {
      const foundIndex = messages.findIndex((message) => {
        return message.type === type && (!predicate || predicate(message));
      });
      if (foundIndex >= 0) {
        throw new Error(`unexpected ${type}: ${JSON.stringify(messages[foundIndex])}`);
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, timeoutMs);
        waiters.push({
          type,
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            reject(new Error(`unexpected ${type}: ${JSON.stringify(message)}`));
          },
          timer,
        });
      });
    },
```

- [ ] **Step 2: 新增三用户群聊测试**

在现有集成测试中注册登录 `user3`，并在旧 `send_group` 回归后追加：

```js
  const user3 = await connectGateway();
  const user3Name = `u3_${suffix}`;
  user3.send('register', authPayload(user3Name, 'pw3'));
  assert.equal((await user3.waitFor('auth_result', (message) => message.action === 'register')).ok, true);
  user3.send('login', authPayload(user3Name, 'pw3'));
  assert.equal((await user3.waitFor('auth_result', (message) => message.action === 'login')).ok, true);

  user1.send('create_group', { name: '临时项目组', members: [user2Name] });
  const createEvent1 = await user1.waitFor('group_event', (message) => message.event === 'created');
  const createEvent2 = await user2.waitFor('group_event', (message) => message.event === 'created');
  assert.equal(createEvent1.group.name, '临时项目组');
  assert.deepEqual(new Set(createEvent1.group.members), new Set([user1Name, user2Name]));
  assert.equal(createEvent2.group.id, createEvent1.group.id);
  await user3.waitForNoMessage('group_event', (message) => message.group?.id === createEvent1.group.id);

  user1.send('group_list');
  assert.equal((await user1.waitFor('group_list')).groups[0].id, createEvent1.group.id);

  user1.send('send_group_message', { groupId: createEvent1.group.id, text: 'hello-real-group' });
  assert.equal((await user1.waitFor('chat_message', (message) => message.mode === 'group')).text, 'hello-real-group');
  assert.equal((await user2.waitFor('chat_message', (message) => message.mode === 'group')).text, 'hello-real-group');
  await user3.waitForNoMessage('chat_message', (message) => message.text === 'hello-real-group');

  user2.send('logout');
  assert.equal((await user2.waitFor('status', (message) => message.status === 'logged_out')).status, 'logged_out');
  const leaveEvent = await user1.waitFor('group_event', (message) => message.event === 'member_left');
  assert.deepEqual(leaveEvent.group.members, [user1Name]);
  user3.close();
```

关闭阶段追加：

```js
  user3.close();
```

- [ ] **Step 3: 运行集成测试确认失败**

Run:

```bash
/mnt/c/Users/Gorcly/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe --test /home/gorcly/multi_user_chat/web/test/gateway.integration.test.js
```

Expected: FAIL，错误为 Web 网关未知 `create_group` 或未解析新群包。

## Task 7: Web 网关接入新群协议

**Files:**
- Modify: `web/server.js`
- Modify: `web/lib/protocol.js`
- Test: `web/test/gateway.integration.test.js`

- [ ] **Step 1: 引入群 helper**

在 `web/server.js` import 中加入：

```js
  decodeGroupEventPayload,
  decodeGroupListPayload,
  decodeGroupMessagePayload,
  encodeGroupCreatePayload,
  encodeGroupMessagePayload,
```

- [ ] **Step 2: 添加 session 群缓存**

在 `ClientSession` constructor 中加入：

```js
    this.groupsById = new Map();
```

在 TCP 主动关闭登录态清理处、`handleCommandResponse()` logout 分支、`show logged_out` 对应 server session 清理处清空：

```js
    this.groupsById.clear();
```

- [ ] **Step 3: 解析服务端群包**

在 `handlePacket()` 中新增 cases：

```js
      case MessageType.MSG_GROUP_LIST: {
        const groups = decodeGroupListPayload(packet.data);
        this.groupsById = new Map(groups.map((group) => [group.id, group]));
        this.send('group_list', { groups });
        break;
      }
      case MessageType.MSG_GROUP_EVENT: {
        const { event, group } = decodeGroupEventPayload(packet.data);
        if (event === 'created' || event === 'member_left') {
          this.groupsById.set(group.id, group);
        }
        this.send('group_event', { event, group });
        break;
      }
      case MessageType.MSG_GROUP_MESSAGE: {
        const decoded = decodeGroupMessagePayload(packet.data);
        this.groupsById.set(decoded.groupId, {
          ...(this.groupsById.get(decoded.groupId) || {}),
          id: decoded.groupId,
          name: decoded.groupName,
        });
        this.send('chat_message', {
          mode: 'group',
          groupId: decoded.groupId,
          groupName: decoded.groupName,
          sender: packet.sender,
          text: decoded.text,
        });
        break;
      }
```

保留旧 `MSG_GROUP` case 不变，用于旧广播兼容。

- [ ] **Step 4: 添加群 action handlers**

添加：

```js
function validateGroupName(name) {
  if (!name || byteLength(name) >= 64 || name.includes('\0') || name.includes('\n')) {
    return '群名不能为空，长度需小于 64 字节，且不能包含换行';
  }
  return null;
}
```

在 `ClientSession` 中添加：

```js
  handleGroupList() {
    if (!this.requireLogin()) {
      return;
    }
    this.sendPacket(encodePacket({
      type: MessageType.MSG_GROUP_LIST,
      sender: this.username,
      receiver: '',
    }));
  }

  handleCreateGroup(msg) {
    if (!this.requireLogin()) {
      return;
    }
    const name = String(msg.name || '').trim();
    const members = Array.isArray(msg.members) ? msg.members.map((item) => String(item || '').trim()) : [];
    const error = validateGroupName(name);
    if (error) {
      this.send('error', { message: error });
      return;
    }
    try {
      const payload = encodeGroupCreatePayload(name, members.filter((item) => item && item !== this.username));
      this.pendingResponses.push({ kind: 'status', action: 'create_group' });
      this.sendPacket(encodePacket({
        type: MessageType.MSG_GROUP_CREATE,
        sender: this.username,
        receiver: '',
        data: payload,
      }));
    } catch (err) {
      this.send('error', { message: err.message });
    }
  }

  handleGroupMessage(msg) {
    if (!this.requireLogin()) {
      return;
    }
    const groupId = String(msg.groupId || '').trim();
    const text = String(msg.text || '');
    const error = validateText(text);
    if (!groupId) {
      this.send('error', { message: '请选择群聊后再发送消息' });
      return;
    }
    if (error) {
      this.send('error', { message: error });
      return;
    }
    this.pendingResponses.push({ kind: 'status', action: 'send_group_message' });
    this.sendPacket(encodeTextPacket({
      type: MessageType.MSG_GROUP_MESSAGE,
      sender: this.username,
      receiver: groupId,
      text,
    }));
  }
```

- [ ] **Step 5: 接入 action switch**

在 `handleMessage()` switch 中加入：

```js
        case 'group_list':
          this.handleGroupList();
          break;
        case 'create_group':
          this.handleCreateGroup(msg);
          break;
        case 'send_group_message':
          this.handleGroupMessage(msg);
          break;
```

旧 `send_group` 保持原样。

- [ ] **Step 6: 运行 Web 测试**

Run:

```bash
/mnt/c/Users/Gorcly/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe --test /home/gorcly/multi_user_chat/web/test/protocol.test.js /home/gorcly/multi_user_chat/web/test/gateway.session.test.js /home/gorcly/multi_user_chat/web/test/gateway.integration.test.js
```

Expected: PASS。

## Task 8: 前端删除默认群并新增创建群 UI

**Files:**
- Modify: `web/public/index.html`
- Modify: `web/public/main.js`
- Modify: `web/public/style.css`

- [ ] **Step 1: 更新 HTML**

在 `.list-tabs` 后加入：

```html
          <button id="newGroupBtn" class="new-group-button" type="button" hidden>＋ 新建群聊</button>
```

在 `</main>` 前加入：

```html
    <dialog id="groupDialog" class="group-dialog">
      <form id="groupForm" method="dialog">
        <header>
          <strong>新建群聊</strong>
          <button id="closeGroupDialogBtn" type="button" aria-label="关闭">×</button>
        </header>
        <label>
          群名
          <input id="groupNameInput" maxlength="63" autocomplete="off" />
        </label>
        <div id="groupMemberList" class="group-member-list" aria-live="polite"></div>
        <p id="groupFormMessage" class="form-message" role="status"></p>
        <div class="button-row">
          <button id="createGroupBtn" type="submit">创建</button>
          <button id="cancelGroupBtn" class="secondary" type="button">取消</button>
        </div>
      </form>
    </dialog>
```

- [ ] **Step 2: 更新 JS 状态**

删除硬编码 `const groups = [...]`，替换为：

```js
let groups = [];
```

把初始 `selectedConversation` 改为：

```js
let selectedConversation = {
  mode: 'none',
  id: '',
  name: '请选择会话',
  online: false,
};
```

新增 DOM refs：

```js
const newGroupBtnEl = $('#newGroupBtn');
const groupDialogEl = $('#groupDialog');
const groupFormEl = $('#groupForm');
const groupNameInputEl = $('#groupNameInput');
const groupMemberListEl = $('#groupMemberList');
const groupFormMessageEl = $('#groupFormMessage');
const createGroupBtnEl = $('#createGroupBtn');
```

- [ ] **Step 3: 前端刷新动作**

`startOnlineRefresh()` 的定时器中发送：

```js
      send('online_list');
      send('group_list');
```

登录成功后发送：

```js
      send('online_list');
      send('group_list');
```

窗口 focus 时发送：

```js
    send('online_list');
    send('group_list');
```

- [ ] **Step 4: 群列表渲染**

`setTab()` 中加入：

```js
  newGroupBtnEl.hidden = currentTab !== 'groups';
```

`rosterItems()` 的 groups 分支改为读取 `groups`：

```js
    return groups
      .filter((group) => !query || group.name.toLowerCase().includes(query))
      .map((group, index) => ({
        mode: 'group',
        id: group.id,
        name: group.name,
        subtitle: `${group.members?.length || 0} 人在线`,
        icon: initials(group.name),
        online: true,
        accent: `a${(index % 6) + 1}`,
      }));
```

空状态文案改为：

```js
    empty.textContent = currentTab === 'groups' ? '还没有在线群聊' : '没有匹配的好友';
```

- [ ] **Step 5: 群创建对话框**

新增：

```js
function setGroupFormMessage(text, level = 'info') {
  groupFormMessageEl.textContent = text;
  groupFormMessageEl.className = `form-message ${level}`;
}

function renderGroupMemberOptions() {
  const candidates = onlineUsers.filter((user) => user && user !== currentUsername);
  groupMemberListEl.replaceChildren();
  if (candidates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact';
    empty.textContent = '当前没有其他在线用户';
    groupMemberListEl.appendChild(empty);
    createGroupBtnEl.disabled = true;
    return;
  }
  createGroupBtnEl.disabled = false;
  for (const user of candidates) {
    const label = document.createElement('label');
    label.className = 'member-option';
    label.innerHTML = `<input type="checkbox" value="${escapeText(user)}" /> <span>${escapeText(user)}</span>`;
    groupMemberListEl.appendChild(label);
  }
}

function openGroupDialog() {
  groupNameInputEl.value = '';
  setGroupFormMessage('');
  renderGroupMemberOptions();
  groupDialogEl.showModal();
  groupNameInputEl.focus();
}

function closeGroupDialog() {
  groupDialogEl.close();
}
```

事件绑定：

```js
newGroupBtnEl.addEventListener('click', openGroupDialog);
$('#closeGroupDialogBtn').addEventListener('click', closeGroupDialog);
$('#cancelGroupBtn').addEventListener('click', closeGroupDialog);

groupFormEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const members = Array.from(groupMemberListEl.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value);
  const name = groupNameInputEl.value.trim();
  if (!name) {
    setGroupFormMessage('请输入群名', 'error');
    return;
  }
  if (members.length === 0) {
    setGroupFormMessage('请至少选择一名在线成员', 'error');
    return;
  }
  send('create_group', { name, members });
});
```

- [ ] **Step 6: 处理群列表、事件和消息归档**

在 `handleGatewayMessage()` 中加入：

```js
  if (msg.type === 'group_list') {
    groups = msg.groups || [];
    if (selectedConversation.mode === 'group' && !groups.some((group) => group.id === selectedConversation.id)) {
      pushMessage({ direction: 'system', text: '当前群聊已结束' });
      selectedConversation = { mode: 'none', id: '', name: '请选择会话', online: false };
    }
    updateHeader();
    renderRoster();
    renderMessages();
    return;
  }

  if (msg.type === 'group_event') {
    const group = msg.group;
    const index = groups.findIndex((item) => item.id === group.id);
    if (index >= 0) {
      groups[index] = group;
    } else {
      groups.push(group);
    }
    if (msg.event === 'created') {
      addToast(`群聊已创建：${group.name}`);
      closeGroupDialog();
    }
    if (msg.event === 'member_left') {
      addToast(`群成员变化：${group.name}`);
    }
    renderRoster();
    updateHeader();
    return;
  }
```

把 `chat_message` 群分支改为：

```js
    const conversation = isGroup
      ? { mode: 'group', id: msg.groupId, name: msg.groupName || '群聊', online: true }
      : { mode: 'friend', id: msg.sender, name: msg.sender, online: onlineUsers.includes(msg.sender) };
```

`pushMessage()` 的方向使用：

```js
      direction: msg.sender === currentUsername ? 'out' : 'in',
```

群消息收到后不修改 `selectedConversation`。

- [ ] **Step 7: 发送群消息**

在 composer submit 中把群发送改为：

```js
    send('send_group_message', { groupId: selectedConversation.id, text });
```

删除群消息的本地 optimistic `pushMessage()`，依赖服务端回显落入对应群会话。

- [ ] **Step 8: CSS**

追加样式：

```css
.new-group-button {
  margin: 0 12px 12px;
  min-height: 38px;
  border-radius: 10px;
  background: rgba(22, 119, 255, 0.18);
  color: #fff;
  border: 1px solid rgba(22, 119, 255, 0.42);
}

.group-dialog {
  width: min(420px, calc(100vw - 32px));
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: #0f1b2a;
  color: var(--text);
}

.group-dialog::backdrop {
  background: rgba(0, 0, 0, 0.52);
}

.group-dialog form {
  display: grid;
  gap: 14px;
}

.group-dialog header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.group-member-list {
  max-height: 220px;
  overflow: auto;
  display: grid;
  gap: 8px;
}

.member-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(20, 32, 48, 0.72);
}

.empty-state.compact {
  margin: 0;
  padding: 12px;
}
```

## Task 9: 全量验证和本地服务重启

**Files:**
- No code edits.

- [ ] **Step 1: C 验证**

Run:

```bash
make unit
make all
```

Expected: 单元测试通过，`server_app` 和 `client_app` 构建成功。

- [ ] **Step 2: Web 验证**

Run:

```bash
/mnt/c/Users/Gorcly/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe --test /home/gorcly/multi_user_chat/web/test/protocol.test.js /home/gorcly/multi_user_chat/web/test/gateway.session.test.js /home/gorcly/multi_user_chat/web/test/gateway.integration.test.js
```

Expected: 全部测试 PASS。

- [ ] **Step 3: Diff 检查**

Run:

```bash
git diff --check -- include/protocol.h common/protocol.c include/group.h common/group.c Makefile test/unit_tests.c server/server.c web/lib/protocol.js web/server.js web/test/protocol.test.js web/test/gateway.integration.test.js web/public/index.html web/public/main.js web/public/style.css
```

Expected: 无输出。

- [ ] **Step 4: 重启本轮服务**

只处理本轮已知进程，先核对再 kill：

```bash
ps -p 30921,43726 -o pid,cmd
kill 30921 43726
./server_app 9000 9001
/mnt/c/Users/Gorcly/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe server.js
```

Expected: C 服务监听 `9000/9001`，Web UI 继续在 `http://localhost:8080/`。

- [ ] **Step 5: 浏览器 smoke**

使用浏览器或 WebSocket smoke 验证：

- 登录后群列表没有原来的 Linux/开源/嵌入式默认群。
- 只有在线用户可勾选创建群。
- A 创建群并选择 B 后，A/B 出现群，C 不出现。
- A 发送群消息后，A/B 收到，C 收不到。
- B 退出后，A 收到成员变化，群成员只剩 A。

## Plan Self-Review

- Spec coverage: 删除默认群、在线用户多选、创建者自动加入、离线自动退出、空群删除、推送和拉取兜底、按群归档、不自动切换当前会话、旧广播兼容均有对应任务。
- Placeholder scan: 未保留实现占位符；每个行为点都有文件、接口、命令或固定验证。
- Type consistency: C 端 `GroupSnapshot.id/name/creator/members`、JS 端 `group.id/name/creator/members`、浏览器事件 `groupId/groupName` 命名已统一。
