import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MessageType,
  PacketDecoder,
  WIRE_HEADER_BYTES,
  decodeGroupEventPayload,
  decodeGroupListPayload,
  decodeGroupMessagePayload,
  encodeFileBeginPayload,
  encodeGroupCreatePayload,
  encodeGroupMessagePayload,
  encodeTextPacket,
  parsePort,
} from '../lib/protocol.js';

test('encodeTextPacket matches the C wire layout for login', () => {
  const packet = encodeTextPacket({
    type: MessageType.MSG_LOGIN,
    sender: 'user1',
    receiver: '',
    text: 'pw1',
  });

  assert.equal(packet.length, WIRE_HEADER_BYTES + 4);
  assert.equal(packet.readInt32BE(0), MessageType.MSG_LOGIN);
  assert.equal(packet.readUInt32BE(4), 4);
  assert.equal(packet.subarray(8, 40).toString('utf8').replace(/\0+$/, ''), 'user1');
  assert.equal(packet.subarray(40, 72).toString('utf8').replace(/\0+$/, ''), '');
  assert.deepEqual(packet.subarray(72), Buffer.from('pw1\0'));
});

test('PacketDecoder reassembles fragmented and batched packets', () => {
  const first = encodeTextPacket({
    type: MessageType.MSG_REGISTER,
    sender: 'alice',
    receiver: '',
    text: 'secret',
  });
  const second = encodeTextPacket({
    type: MessageType.MSG_PRIVATE,
    sender: 'bob',
    receiver: 'alice',
    text: 'hello',
  });
  const decoder = new PacketDecoder();

  assert.deepEqual(decoder.push(first.subarray(0, 12)), []);
  assert.deepEqual(decoder.push(first.subarray(12, 70)), []);

  const decoded = decoder.push(Buffer.concat([first.subarray(70), second]));
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].type, MessageType.MSG_REGISTER);
  assert.equal(decoded[0].sender, 'alice');
  assert.equal(decoded[0].text, 'secret');
  assert.equal(decoded[1].type, MessageType.MSG_PRIVATE);
  assert.equal(decoded[1].sender, 'bob');
  assert.equal(decoded[1].receiver, 'alice');
  assert.equal(decoded[1].text, 'hello');
});

test('protocol helpers reject invalid field sizes and ports', () => {
  assert.throws(
    () => encodeTextPacket({
      type: MessageType.MSG_LOGIN,
      sender: 'a'.repeat(32),
      receiver: '',
      text: 'pw',
    }),
    /sender/
  );
  assert.throws(
    () => encodeTextPacket({
      type: MessageType.MSG_LOGIN,
      sender: 'alice',
      receiver: '',
      text: 'x'.repeat(1024),
    }),
    /data/
  );
  assert.equal(parsePort('19000', 9000), 19000);
  assert.equal(parsePort('0', 9000), 9000);
  assert.equal(parsePort('bad', 9000), 9000);
  assert.equal(parsePort('65536', 9000), 9000);
});

test('encodeFileBeginPayload uses the C payload shape', () => {
  const payload = encodeFileBeginPayload('note.txt', 123n);

  assert.equal(payload.length, 264);
  assert.equal(payload.subarray(0, 256).toString('utf8').replace(/\0+$/, ''), 'note.txt');
  assert.equal(payload.readBigUInt64LE(256), 123n);
});

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

  const eventPayload = Buffer.from(
    ['created', 'g000001', '项目组', 'alice', '3', 'alice', 'bob', 'carol'].join('\0') + '\0',
    'utf8'
  );
  assert.deepEqual(decodeGroupEventPayload(eventPayload), {
    event: 'created',
    group: {
      id: 'g000001',
      name: '项目组',
      creator: 'alice',
      members: ['alice', 'bob', 'carol'],
    },
  });

  const listPayload = Buffer.from(
    ['1', 'g000001', '项目组', 'alice', '3', 'alice', 'bob', 'carol'].join('\0') + '\0',
    'utf8'
  );
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
