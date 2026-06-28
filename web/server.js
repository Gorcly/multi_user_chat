import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

import {
  FILE_NAME_MAX_LEN,
  FILE_TRANSFER_MAX_BYTES,
  MessageType,
  PACKET_DATA_MAX,
  PASSWORD_MAX_LEN,
  PacketDecoder,
  USERNAME_MAX_LEN,
  decodeFileBeginPayload,
  decodeGroupEventPayload,
  decodeGroupListPayload,
  decodeGroupMessagePayload,
  encodeFileBeginPayload,
  encodeGroupCreatePayload,
  encodeGroupMessagePayload,
  encodePacket,
  encodeTextPacket,
  parsePort,
  packetText,
} from './lib/protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientPublicDir = path.join(__dirname, 'public');
const serverPublicDir = path.join(__dirname, 'server-public');

const CLIENT_WEB_PORT = parsePort(process.env.CLIENT_WEB_PORT || process.env.WEB_PORT, 8080);
const SERVER_WEB_PORT = parsePort(process.env.SERVER_WEB_PORT, 8081);
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';
const DEFAULT_CHAT_HOST = process.env.CHAT_HOST || '127.0.0.1';
const DEFAULT_CHAT_PORT = parsePort(process.env.CHAT_PORT, 9000);
const DEFAULT_UDP_PORT = parsePort(process.env.UDP_PORT, 9001);
const execFileAsync = promisify(execFile);
let cachedWslHost = null;

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

function sendJson(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function safeJoin(base, requestPath) {
  const decodedPath = decodeURIComponent(requestPath.split('?')[0]);
  const relativePath = decodedPath.replace(/^[/\\]+/, '') || 'index.html';
  const normalizedPath = path.normalize(relativePath);
  const filePath = path.join(base, normalizedPath);
  const relative = path.relative(base, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return filePath;
}

function createStaticServer(rootDir) {
  return http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const filePath = safeJoin(rootDir, req.url);
    if (!filePath) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath);
      res.writeHead(200, { 'content-type': mimeTypes.get(ext) || 'application/octet-stream' });
      res.end(data);
    });
  });
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function uncDistroFromPath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const match = normalized.match(/^\/\/wsl(?:\.localhost)?\/([^/]+)\//i);
  return match?.[1] || null;
}

async function detectWslHost() {
  if (cachedWslHost !== null) {
    return cachedWslHost;
  }
  cachedWslHost = '';
  if (process.platform !== 'win32') {
    return cachedWslHost;
  }

  const distro = uncDistroFromPath(__dirname) || uncDistroFromPath(process.cwd());
  if (!distro) {
    return cachedWslHost;
  }
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['-d', distro, 'hostname', '-I'], {
      timeout: 2000,
      windowsHide: true,
    });
    cachedWslHost = stdout.trim().split(/\s+/).find((item) => /^\d+\.\d+\.\d+\.\d+$/.test(item)) || '';
  } catch {
    cachedWslHost = '';
  }
  return cachedWslHost;
}

function isLocalhost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function validateAuth(username, password) {
  if (!username || byteLength(username) >= USERNAME_MAX_LEN || username.includes(':') || username.includes('\n')) {
    return '用户名不能为空，长度需小于 32 字节，且不能包含冒号或换行';
  }
  if (!password || byteLength(password) >= PASSWORD_MAX_LEN || password.includes('\n')) {
    return '密码不能为空，长度需小于 64 字节，且不能包含换行';
  }
  return null;
}

function validatePeerName(receiver) {
  if (!receiver || byteLength(receiver) >= USERNAME_MAX_LEN || receiver.includes(':') || receiver.includes('\n')) {
    return '接收者不能为空，长度需小于 32 字节，且不能包含冒号或换行';
  }
  return null;
}

function validateText(text) {
  if (!text || byteLength(text) + 1 > PACKET_DATA_MAX) {
    return `消息不能为空，且不能超过 ${PACKET_DATA_MAX - 1} 字节`;
  }
  return null;
}

function validateGroupName(name) {
  if (!name || byteLength(name) >= 64 || name.includes('\0') || name.includes('\n')) {
    return '群名不能为空，长度需小于 64 字节，且不能包含换行';
  }
  return null;
}

class ClientSession {
  constructor(ws) {
    this.ws = ws;
    this.tcpSocket = null;
    this.tcpConfig = null;
    this.tcpDecoder = new PacketDecoder();
    this.udpSocket = null;
    this.udpPort = null;
    this.username = '';
    this.loggedIn = false;
    this.pendingResponses = [];
    this.incomingFile = null;
    this.closing = false;
    this.groupsById = new Map();
  }

  send(type, payload = {}) {
    sendJson(this.ws, type, payload);
  }

  async ensureTcp(host, port) {
    const nextConfig = { host: host || DEFAULT_CHAT_HOST, port: parsePort(port, DEFAULT_CHAT_PORT) };
    if (
      this.tcpSocket &&
      !this.tcpSocket.destroyed &&
      this.tcpConfig?.host === nextConfig.host &&
      this.tcpConfig?.port === nextConfig.port
    ) {
      return;
    }

    this.closeTcp(false);
    try {
      await this.connectTcp(nextConfig, nextConfig.host);
    } catch (err) {
      const wslHost = isLocalhost(nextConfig.host) ? await detectWslHost() : '';
      if (!wslHost || wslHost === nextConfig.host) {
        throw err;
      }
      await this.connectTcp(nextConfig, wslHost);
    }
  }

  connectTcp(logicalConfig, connectHost) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.createConnection({ host: connectHost, port: logicalConfig.port });
      socket.setTimeout(5000);

      socket.once('connect', () => {
        settled = true;
        socket.setTimeout(0);
        socket.setNoDelay(true);
        this.tcpSocket = socket;
        this.tcpConfig = logicalConfig;
        this.tcpDecoder = new PacketDecoder();
        this.send('status', {
          status: 'tcp_connected',
          message: `已连接聊天服务 ${logicalConfig.host}:${logicalConfig.port}`,
        });
        resolve();
      });

      socket.on('data', (chunk) => this.handleTcpData(chunk));
      socket.on('timeout', () => socket.destroy(new Error('TCP 连接超时')));
      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        if (this.tcpSocket !== socket) {
          return;
        }
        this.send('error', { message: `TCP 连接异常：${err.message}` });
      });
      socket.on('close', () => {
        if (this.tcpSocket !== socket) {
          return;
        }
        this.tcpSocket = null;
        this.tcpConfig = null;
        const pendingAuth = this.pendingResponses.find((pending) => pending?.kind === 'auth');
        const wasLoggedIn = this.loggedIn && this.username;
        this.pendingResponses = [];
        if (!this.closing) {
          this.loggedIn = false;
          this.username = '';
          this.groupsById.clear();
          this.closeUdp();
          if (pendingAuth) {
            this.send('auth_result', {
              action: pendingAuth.action,
              ok: false,
              message: 'TCP 连接已关闭，请检查聊天服务后重试',
              username: pendingAuth.username,
            });
            return;
          }
          if (wasLoggedIn) {
            this.send('status', {
              status: 'logged_out',
              ok: false,
              reason: 'tcp_closed',
              message: 'TCP 连接已关闭，请重新登录',
            });
            return;
          }
          this.send('status', { status: 'tcp_closed', message: 'TCP 连接已关闭' });
        }
      });
    });
  }

  closeTcp(sendLogout) {
    if (this.tcpSocket && !this.tcpSocket.destroyed) {
      if (sendLogout && this.loggedIn) {
        try {
          this.tcpSocket.write(encodePacket({
            type: MessageType.MSG_LOGOUT,
            sender: this.username,
            receiver: '',
          }));
        } catch {
          // Socket cleanup must not fail because logout packet construction failed.
        }
      }
      this.tcpSocket.destroy();
    }
    this.tcpSocket = null;
    this.tcpConfig = null;
  }

  closeUdp() {
    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
      this.udpPort = null;
    }
  }

  cleanup() {
    this.closing = true;
    this.closeTcp(true);
    this.closeUdp();
  }

  sendPacket(packet) {
    if (!this.tcpSocket || this.tcpSocket.destroyed) {
      throw new Error('尚未连接聊天服务');
    }
    this.tcpSocket.write(packet);
  }

  handleTcpData(chunk) {
    let packets;
    try {
      packets = this.tcpDecoder.push(chunk);
    } catch (err) {
      this.send('error', { message: `协议解析失败：${err.message}` });
      this.closeTcp(false);
      return;
    }
    for (const packet of packets) {
      this.handlePacket(packet);
    }
  }

  handlePacket(packet) {
    switch (packet.type) {
      case MessageType.MSG_OK:
      case MessageType.MSG_ERROR:
        this.handleCommandResponse(packet);
        break;
      case MessageType.MSG_ONLINE_LIST:
        this.send('online_list', {
          users: packet.text === '当前没有在线用户'
            ? []
            : packet.text.split('\n').filter(Boolean),
        });
        break;
      case MessageType.MSG_PRIVATE:
        this.send('chat_message', {
          mode: 'private',
          sender: packet.sender,
          receiver: packet.receiver,
          text: packet.text,
        });
        break;
      case MessageType.MSG_GROUP:
        this.send('chat_message', {
          mode: 'group',
          sender: packet.sender,
          receiver: packet.receiver,
          text: packet.text,
        });
        break;
      case MessageType.MSG_GROUP_LIST: {
        const groups = decodeGroupListPayload(packet.data);
        this.groupsById = new Map(groups.map((group) => [group.id, group]));
        this.send('group_list', { groups });
        break;
      }
      case MessageType.MSG_GROUP_EVENT: {
        const { event, group } = decodeGroupEventPayload(packet.data);
        this.groupsById.set(group.id, group);
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
      case MessageType.MSG_FILE_BEGIN:
        this.handleIncomingFileBegin(packet);
        break;
      case MessageType.MSG_FILE_CHUNK:
        this.handleIncomingFileChunk(packet);
        break;
      case MessageType.MSG_FILE_END:
        this.handleIncomingFileEnd(packet);
        break;
      default:
        this.send('status', { status: 'packet_received', message: `收到消息类型 ${packet.type}` });
        break;
    }
  }

  handleCommandResponse(packet) {
    const pending = this.pendingResponses.shift();
    const ok = packet.type === MessageType.MSG_OK;
    const message = packetText(packet);

    if (pending?.kind === 'auth') {
      if (ok && pending.action === 'login') {
        this.groupsById.clear();
        this.loggedIn = true;
        this.username = pending.username;
      }
      this.send('auth_result', {
        action: pending.action,
        ok,
        message,
        username: pending.username,
      });
      return;
    }

    if (pending?.action === 'logout') {
      this.loggedIn = false;
      this.username = '';
      this.groupsById.clear();
      this.send('status', { status: 'logged_out', ok, message });
      this.closeTcp(false);
      this.closeUdp();
      return;
    }

    this.send(ok ? 'status' : 'error', {
      status: pending?.action || 'server_response',
      ok,
      message,
    });
  }

  handleIncomingFileBegin(packet) {
    try {
      const payload = decodeFileBeginPayload(packet.data);
      if (payload.filesize > FILE_TRANSFER_MAX_BYTES) {
        this.send('error', { message: '收到的文件超过 10 MiB 限制，已拒绝' });
        return;
      }
      this.incomingFile = {
        sender: packet.sender,
        filename: payload.filename,
        expectedSize: payload.filesize,
        receivedSize: 0,
        chunks: [],
      };
      this.send('file_progress', {
        sender: packet.sender,
        filename: payload.filename,
        receivedSize: 0,
        expectedSize: payload.filesize,
      });
    } catch (err) {
      this.send('error', { message: `收到非法文件头：${err.message}` });
    }
  }

  handleIncomingFileChunk(packet) {
    if (!this.incomingFile) {
      return;
    }
    this.incomingFile.chunks.push(packet.data);
    this.incomingFile.receivedSize += packet.data.length;
    this.send('file_progress', {
      sender: this.incomingFile.sender,
      filename: this.incomingFile.filename,
      receivedSize: this.incomingFile.receivedSize,
      expectedSize: this.incomingFile.expectedSize,
    });
  }

  handleIncomingFileEnd() {
    if (!this.incomingFile) {
      return;
    }
    const file = this.incomingFile;
    this.incomingFile = null;
    const data = Buffer.concat(file.chunks);
    if (data.length !== file.expectedSize) {
      this.send('error', {
        message: `文件接收大小不匹配：已收 ${data.length} / 期望 ${file.expectedSize}`,
      });
      return;
    }
    this.send('file_received', {
      sender: file.sender,
      filename: file.filename,
      size: data.length,
      dataBase64: data.toString('base64'),
    });
  }

  async handleRegisterOrLogin(action, msg) {
    const username = String(msg.username || '').trim();
    const password = String(msg.password || '');
    const validationError = validateAuth(username, password);
    if (validationError) {
      this.send('auth_result', { action, ok: false, message: validationError, username });
      return;
    }

    try {
      await this.ensureTcp(msg.host, msg.port);
      this.pendingResponses.push({ kind: 'auth', action, username });
      this.sendPacket(encodeTextPacket({
        type: action === 'register' ? MessageType.MSG_REGISTER : MessageType.MSG_LOGIN,
        sender: username,
        receiver: '',
        text: password,
      }));
    } catch (err) {
      this.send('auth_result', {
        action,
        ok: false,
        message: `连接聊天服务失败：${err.message}`,
        username,
      });
    }
  }

  requireLogin() {
    if (!this.loggedIn || !this.username) {
      this.send('error', { message: '请先登录' });
      return false;
    }
    return true;
  }

  handleOnlineList() {
    if (!this.requireLogin()) {
      return;
    }
    this.sendPacket(encodePacket({
      type: MessageType.MSG_ONLINE_LIST,
      sender: this.username,
      receiver: '',
    }));
  }

  handlePrivate(msg) {
    if (!this.requireLogin()) {
      return;
    }
    const receiver = String(msg.receiver || '').trim();
    const text = String(msg.text || '');
    const error = validatePeerName(receiver) || validateText(text);
    if (error) {
      this.send('error', { message: error });
      return;
    }
    this.pendingResponses.push({ kind: 'status', action: 'send_private' });
    this.sendPacket(encodeTextPacket({
      type: MessageType.MSG_PRIVATE,
      sender: this.username,
      receiver,
      text,
    }));
  }

  handleGroup(msg) {
    if (!this.requireLogin()) {
      return;
    }
    const text = String(msg.text || '');
    const error = validateText(text);
    if (error) {
      this.send('error', { message: error });
      return;
    }
    this.pendingResponses.push({ kind: 'status', action: 'send_group' });
    this.sendPacket(encodeTextPacket({
      type: MessageType.MSG_GROUP,
      sender: this.username,
      receiver: '',
      text,
    }));
  }

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
    const members = Array.isArray(msg.members)
      ? msg.members.map((item) => String(item || '').trim()).filter(Boolean).filter((item) => item !== this.username)
      : [];
    const error = validateGroupName(name);
    if (error) {
      this.send('error', { message: error });
      return;
    }
    for (const member of members) {
      const memberError = validatePeerName(member);
      if (memberError) {
        this.send('error', { message: `群成员 ${member} 不合法：${memberError}` });
        return;
      }
    }
    try {
      const payload = encodeGroupCreatePayload(name, members);
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
    try {
      this.pendingResponses.push({ kind: 'status', action: 'send_group_message' });
      this.sendPacket(encodePacket({
        type: MessageType.MSG_GROUP_MESSAGE,
        sender: this.username,
        receiver: groupId,
        data: encodeGroupMessagePayload(groupId, text),
      }));
    } catch (err) {
      this.pendingResponses = this.pendingResponses.filter((pending) => pending?.action !== 'send_group_message');
      this.send('error', { message: err.message });
    }
  }

  handleSendFileBegin(msg) {
    if (!this.requireLogin()) {
      return;
    }
    const receiver = String(msg.receiver || '').trim();
    const filename = path.basename(String(msg.filename || ''));
    const filesize = Number(msg.filesize);
    const error = validatePeerName(receiver);
    if (error) {
      this.send('error', { message: error });
      return;
    }
    if (!filename || byteLength(filename) >= FILE_NAME_MAX_LEN || filename.includes('\n')) {
      this.send('error', { message: '文件名不能为空，长度需小于 256 字节，且不能包含换行' });
      return;
    }
    if (!Number.isSafeInteger(filesize) || filesize < 0 || filesize > FILE_TRANSFER_MAX_BYTES) {
      this.send('error', { message: '文件大小必须在 10 MiB 以内' });
      return;
    }
    this.sendPacket(encodePacket({
      type: MessageType.MSG_FILE_BEGIN,
      sender: this.username,
      receiver,
      data: encodeFileBeginPayload(filename, BigInt(filesize)),
    }));
  }

  handleSendFileChunk(msg) {
    if (!this.requireLogin()) {
      return;
    }
    const receiver = String(msg.receiver || '').trim();
    const data = Buffer.from(String(msg.dataBase64 || ''), 'base64');
    const error = validatePeerName(receiver);
    if (error) {
      this.send('error', { message: error });
      return;
    }
    if (data.length === 0 || data.length > PACKET_DATA_MAX) {
      this.send('error', { message: `文件分块必须为 1 到 ${PACKET_DATA_MAX} 字节` });
      return;
    }
    this.sendPacket(encodePacket({
      type: MessageType.MSG_FILE_CHUNK,
      sender: this.username,
      receiver,
      data,
    }));
  }

  handleSendFileEnd(msg) {
    if (!this.requireLogin()) {
      return;
    }
    const receiver = String(msg.receiver || '').trim();
    const error = validatePeerName(receiver);
    if (error) {
      this.send('error', { message: error });
      return;
    }
    this.pendingResponses.push({ kind: 'status', action: 'send_file' });
    this.sendPacket(encodePacket({
      type: MessageType.MSG_FILE_END,
      sender: this.username,
      receiver,
    }));
  }

  handleListenUdp(msg) {
    const port = parsePort(msg.port, DEFAULT_UDP_PORT);
    if (this.udpSocket && this.udpPort === port) {
      this.send('status', { status: 'udp_listening', message: `UDP 广播监听已启动 ${port}` });
      return;
    }

    this.closeUdp();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udpSocket = socket;
    this.udpPort = port;
    socket.on('message', (buf, rinfo) => {
      this.send('udp_broadcast', {
        from: `${rinfo.address}:${rinfo.port}`,
        message: buf.toString('utf8'),
      });
    });
    socket.on('error', (err) => {
      this.send('error', { message: `UDP 监听失败：${err.message}` });
      this.closeUdp();
    });
    socket.bind(port, '0.0.0.0', () => {
      this.send('status', { status: 'udp_listening', message: `UDP 广播监听已启动 ${port}` });
    });
  }

  async handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this.send('error', { message: '收到无法解析的 JSON 消息' });
      return;
    }

    try {
      switch (msg.action) {
        case 'check':
          this.send('status', {
            status: 'gateway_ready',
            message: 'Web 网关正常',
            clientWebPort: CLIENT_WEB_PORT,
            serverWebPort: SERVER_WEB_PORT,
          });
          break;
        case 'connect_tcp':
          await this.ensureTcp(msg.host, msg.port);
          break;
        case 'disconnect_tcp':
          this.closeTcp(true);
          this.send('status', { status: 'tcp_closed', message: 'TCP 连接已关闭' });
          break;
        case 'register':
        case 'login':
          await this.handleRegisterOrLogin(msg.action, msg);
          break;
        case 'logout':
          if (this.loggedIn && this.tcpSocket && !this.tcpSocket.destroyed) {
            this.pendingResponses.push({ kind: 'status', action: 'logout' });
            this.sendPacket(encodePacket({
              type: MessageType.MSG_LOGOUT,
              sender: this.username,
              receiver: '',
            }));
          } else {
            this.loggedIn = false;
            this.username = '';
            this.groupsById.clear();
            this.closeTcp(false);
            this.closeUdp();
            this.send('status', { status: 'logged_out', ok: true, message: '已退出登录' });
          }
          break;
        case 'online_list':
          this.handleOnlineList();
          break;
        case 'send_private':
          this.handlePrivate(msg);
          break;
        case 'send_group':
          this.handleGroup(msg);
          break;
        case 'group_list':
          this.handleGroupList();
          break;
        case 'create_group':
          this.handleCreateGroup(msg);
          break;
        case 'send_group_message':
          this.handleGroupMessage(msg);
          break;
        case 'send_file_begin':
          this.handleSendFileBegin(msg);
          break;
        case 'send_file_chunk':
          this.handleSendFileChunk(msg);
          break;
        case 'send_file_end':
          this.handleSendFileEnd(msg);
          break;
        case 'listen_udp':
          this.handleListenUdp(msg);
          break;
        default:
          this.send('error', { message: `未知 action: ${msg.action}` });
          break;
      }
    } catch (err) {
      this.send('error', { message: err.message });
    }
  }
}

function attachGateway(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    const session = new ClientSession(ws);
    session.send('status', { status: 'ws_connected', message: 'WebSocket 已连接' });
    ws.on('message', (raw) => {
      session.handleMessage(raw);
    });
    ws.on('close', () => {
      session.cleanup();
    });
  });

  return wss;
}

export function startServers() {
  const clientServer = createStaticServer(clientPublicDir);
  const serverConsole = createStaticServer(serverPublicDir);
  attachGateway(clientServer);

  clientServer.listen(CLIENT_WEB_PORT, WEB_HOST, () => {
    console.log(`Client Web UI listening on http://${WEB_HOST}:${CLIENT_WEB_PORT}`);
    console.log(`Open client from Windows browser: http://localhost:${CLIENT_WEB_PORT}`);
  });
  serverConsole.listen(SERVER_WEB_PORT, WEB_HOST, () => {
    console.log(`Server Web UI placeholder listening on http://${WEB_HOST}:${SERVER_WEB_PORT}`);
    console.log(`Open server console from Windows browser: http://localhost:${SERVER_WEB_PORT}`);
  });

  return { clientServer, serverConsole };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServers();
}
