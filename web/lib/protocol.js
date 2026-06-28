export const USERNAME_MAX_LEN = 32;
export const PASSWORD_MAX_LEN = 64;
export const FILE_NAME_MAX_LEN = 256;
export const PACKET_DATA_MAX = 1024;
export const FILE_TRANSFER_MAX_BYTES = 10 * 1024 * 1024;
export const WIRE_HEADER_BYTES = 4 + 4 + USERNAME_MAX_LEN + USERNAME_MAX_LEN;

export const MessageType = Object.freeze({
  MSG_REGISTER: 1,
  MSG_LOGIN: 2,
  MSG_PRIVATE: 3,
  MSG_GROUP: 4,
  MSG_ONLINE_LIST: 5,
  MSG_FILE_BEGIN: 6,
  MSG_FILE_CHUNK: 7,
  MSG_FILE_END: 8,
  MSG_LOGOUT: 9,
  MSG_HEARTBEAT: 10,
  MSG_BROADCAST: 11,
  MSG_OK: 12,
  MSG_ERROR: 13,
  MSG_GROUP_CREATE: 14,
  MSG_GROUP_LIST: 15,
  MSG_GROUP_MESSAGE: 16,
  MSG_GROUP_EVENT: 17,
});

export function parsePort(value, fallback) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return fallback;
  }
  return port;
}

function readFixedCString(buffer) {
  const nul = buffer.indexOf(0);
  const end = nul >= 0 ? nul : buffer.length;
  return buffer.subarray(0, end).toString('utf8');
}

function writeFixedCString(target, offset, size, value, fieldName) {
  const text = String(value ?? '');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length >= size) {
    throw new Error(`${fieldName} must be shorter than ${size} bytes`);
  }
  target.fill(0, offset, offset + size);
  bytes.copy(target, offset);
}

export function encodePacket({ type, sender = '', receiver = '', data = Buffer.alloc(0) }) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!Number.isInteger(type)) {
    throw new Error('type must be an integer');
  }
  if (payload.length > PACKET_DATA_MAX) {
    throw new Error(`data must be at most ${PACKET_DATA_MAX} bytes`);
  }

  const header = Buffer.alloc(WIRE_HEADER_BYTES);
  header.writeInt32BE(type, 0);
  header.writeUInt32BE(payload.length, 4);
  writeFixedCString(header, 8, USERNAME_MAX_LEN, sender, 'sender');
  writeFixedCString(header, 40, USERNAME_MAX_LEN, receiver, 'receiver');

  return Buffer.concat([header, payload]);
}

export function encodeTextPacket({ type, sender = '', receiver = '', text = '' }) {
  const data = Buffer.from(`${text}\0`, 'utf8');
  return encodePacket({ type, sender, receiver, data });
}

export function packetText(packet) {
  return readFixedCString(packet.data);
}

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
  const uniqueMembers = Array.from(
    new Set((members || []).map((item) => assertGroupField(item, '群成员').trim()).filter(Boolean))
  );
  if (groupName.length === 0) {
    throw new Error('群名不能为空');
  }
  if (uniqueMembers.length === 0) {
    throw new Error('请至少选择一名在线成员');
  }
  return encodeGroupFields([groupName, ...uniqueMembers]);
}

export function encodeGroupMessagePayload(groupId, text) {
  assertGroupField(groupId, '群 ID');
  return encodeGroupFields([assertGroupField(text, '消息')]);
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

export function encodeFileBeginPayload(filename, filesize) {
  const payload = Buffer.alloc(FILE_NAME_MAX_LEN + 8);
  writeFixedCString(payload, 0, FILE_NAME_MAX_LEN, filename, 'filename');
  payload.writeBigUInt64LE(BigInt(filesize), FILE_NAME_MAX_LEN);
  return payload;
}

export function decodeFileBeginPayload(data) {
  if (!Buffer.isBuffer(data) || data.length !== FILE_NAME_MAX_LEN + 8) {
    throw new Error('invalid file begin payload');
  }
  return {
    filename: readFixedCString(data.subarray(0, FILE_NAME_MAX_LEN)),
    filesize: Number(data.readBigUInt64LE(FILE_NAME_MAX_LEN)),
  };
}

export class PacketDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const packets = [];

    while (this.#buffer.length >= WIRE_HEADER_BYTES) {
      const length = this.#buffer.readUInt32BE(4);
      if (length > PACKET_DATA_MAX) {
        throw new Error(`packet data length exceeds ${PACKET_DATA_MAX} bytes`);
      }
      const totalLength = WIRE_HEADER_BYTES + length;
      if (this.#buffer.length < totalLength) {
        break;
      }

      const frame = this.#buffer.subarray(0, totalLength);
      const data = frame.subarray(WIRE_HEADER_BYTES);
      packets.push({
        type: frame.readInt32BE(0),
        length,
        sender: readFixedCString(frame.subarray(8, 40)),
        receiver: readFixedCString(frame.subarray(40, 72)),
        data,
        text: readFixedCString(data),
      });
      this.#buffer = this.#buffer.subarray(totalLength);
    }

    return packets;
  }
}
