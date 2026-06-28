import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import WebSocket from 'ws';

import {
  MessageType,
  PacketDecoder,
  encodeTextPacket,
} from '../lib/protocol.js';

const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const BASE_PORT = 24000 + Math.floor(Math.random() * 1000);
const CLIENT_WEB_PORT = BASE_PORT;
const SERVER_WEB_PORT = BASE_PORT + 1;
const OLD_CHAT_PORT = BASE_PORT + 2;
const NEW_CHAT_PORT = BASE_PORT + 3;

async function listen(server, port) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
}

async function closeServer(server) {
  if (!server || !server.listening) {
    return;
  }
  server.close();
  await once(server, 'close');
}

async function waitUntilListening(server) {
  if (server.listening) {
    return;
  }
  await once(server, 'listening');
}

function createFakeChatServer(label) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));

    const decoder = new PacketDecoder();

    socket.on('data', (chunk) => {
      for (const packet of decoder.push(chunk)) {
        if (packet.type === MessageType.MSG_LOGIN) {
          socket.write(encodeTextPacket({
            type: MessageType.MSG_OK,
            sender: 'server',
            receiver: '',
            text: `登录成功 ${label}`,
          }));
          continue;
        }

        if (packet.type === MessageType.MSG_ONLINE_LIST) {
          socket.write(encodeTextPacket({
            type: MessageType.MSG_ONLINE_LIST,
            sender: 'server',
            receiver: '',
            text: packet.sender,
          }));
          continue;
        }

        socket.write(encodeTextPacket({
          type: MessageType.MSG_OK,
          sender: 'server',
          receiver: '',
          text: `OK ${label}`,
        }));
      }
    });

    socket.on('error', () => {
      // Tests intentionally destroy client sockets while switching endpoints.
    });
  });
  server.destroyConnections = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
  };
  return server;
}

async function connectGateway() {
  const ws = new WebSocket(`ws://127.0.0.1:${CLIENT_WEB_PORT}/ws`);
  const messages = [];
  const seen = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    seen.push(message);
    const index = waiters.findIndex(({ type, predicate }) => {
      return message.type === type && (!predicate || predicate(message));
    });
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });

  await once(ws, 'open');
  return {
    seen,
    send(action, payload = {}) {
      ws.send(JSON.stringify({ action, ...payload }));
    },
    waitFor(type, predicate) {
      const foundIndex = messages.findIndex((message) => {
        return message.type === type && (!predicate || predicate(message));
      });
      if (foundIndex >= 0) {
        const [message] = messages.splice(foundIndex, 1);
        return Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000);
        waiters.push({ type, predicate, resolve, timer });
      });
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}

test('closing a previous TCP socket does not clear the active login session', async () => {
  process.env.CLIENT_WEB_PORT = String(CLIENT_WEB_PORT);
  process.env.SERVER_WEB_PORT = String(SERVER_WEB_PORT);
  process.env.WEB_HOST = '127.0.0.1';

  const oldChatServer = createFakeChatServer('old');
  const newChatServer = createFakeChatServer('new');
  let clientServer;
  let serverConsole;
  let gateway;

  try {
    await listen(oldChatServer, OLD_CHAT_PORT);
    await listen(newChatServer, NEW_CHAT_PORT);

    const serverModule = await import(`${pathToFileURL(path.join(WEB_ROOT, 'server.js')).href}?session=${Date.now()}`);
    ({ clientServer, serverConsole } = serverModule.startServers());

    await waitUntilListening(clientServer);

    gateway = await connectGateway();

    await gateway.waitFor('status', (message) => message.status === 'ws_connected');
    gateway.send('connect_tcp', { host: '127.0.0.1', port: OLD_CHAT_PORT });
    await gateway.waitFor('status', (message) => message.status === 'tcp_connected');

    const beforeLoginMessageCount = gateway.seen.length;
    gateway.send('login', {
      host: '127.0.0.1',
      port: NEW_CHAT_PORT,
      username: 'alice',
      password: 'secret',
    });
    assert.equal((await gateway.waitFor('auth_result', (message) => message.action === 'login')).ok, true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const loginMessages = gateway.seen.slice(beforeLoginMessageCount);
    assert.equal(
      loginMessages.some((message) => message.type === 'status' && message.status === 'tcp_closed'),
      false,
      'stale close event from the previous TCP socket must not report tcp_closed'
    );

    gateway.send('online_list');
    assert.deepEqual((await gateway.waitFor('online_list')).users, ['alice']);
  } finally {
    gateway?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    oldChatServer.destroyConnections();
    newChatServer.destroyConnections();
    await closeServer(clientServer);
    await closeServer(serverConsole);
    await closeServer(oldChatServer);
    await closeServer(newChatServer);
  }
});

test('unexpected active TCP close logs out the web session', async () => {
  process.env.CLIENT_WEB_PORT = String(CLIENT_WEB_PORT);
  process.env.SERVER_WEB_PORT = String(SERVER_WEB_PORT);
  process.env.WEB_HOST = '127.0.0.1';

  const chatServer = createFakeChatServer('active');
  let clientServer;
  let serverConsole;
  let gateway;

  try {
    await listen(chatServer, NEW_CHAT_PORT);

    const serverModule = await import(`${pathToFileURL(path.join(WEB_ROOT, 'server.js')).href}?activeClose=${Date.now()}`);
    ({ clientServer, serverConsole } = serverModule.startServers());

    await waitUntilListening(clientServer);

    gateway = await connectGateway();
    await gateway.waitFor('status', (message) => message.status === 'ws_connected');

    gateway.send('login', {
      host: '127.0.0.1',
      port: NEW_CHAT_PORT,
      username: 'alice',
      password: 'secret',
    });
    assert.equal((await gateway.waitFor('auth_result', (message) => message.action === 'login')).ok, true);

    chatServer.destroyConnections();
    const loggedOut = await gateway.waitFor('status', (message) => message.status === 'logged_out');
    assert.equal(loggedOut.reason, 'tcp_closed');
    assert.match(loggedOut.message, /重新登录/);
  } finally {
    gateway?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    chatServer.destroyConnections();
    await closeServer(clientServer);
    await closeServer(serverConsole);
    await closeServer(chatServer);
  }
});

test('logged-in TCP connection stays alive while idle', async () => {
  process.env.CLIENT_WEB_PORT = String(CLIENT_WEB_PORT);
  process.env.SERVER_WEB_PORT = String(SERVER_WEB_PORT);
  process.env.WEB_HOST = '127.0.0.1';

  const chatServer = createFakeChatServer('idle');
  let clientServer;
  let serverConsole;
  let gateway;

  try {
    await listen(chatServer, NEW_CHAT_PORT);

    const serverModule = await import(`${pathToFileURL(path.join(WEB_ROOT, 'server.js')).href}?idle=${Date.now()}`);
    ({ clientServer, serverConsole } = serverModule.startServers());

    await waitUntilListening(clientServer);

    gateway = await connectGateway();
    await gateway.waitFor('status', (message) => message.status === 'ws_connected');

    gateway.send('login', {
      host: '127.0.0.1',
      port: NEW_CHAT_PORT,
      username: 'alice',
      password: 'secret',
    });
    assert.equal((await gateway.waitFor('auth_result', (message) => message.action === 'login')).ok, true);

    await new Promise((resolve) => setTimeout(resolve, 5500));
    assert.equal(
      gateway.seen.some((message) => message.type === 'status' && message.status === 'logged_out'),
      false,
      'idle connection must not be logged out by the connect timeout'
    );

    gateway.send('online_list');
    assert.deepEqual((await gateway.waitFor('online_list')).users, ['alice']);
  } finally {
    gateway?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    chatServer.destroyConnections();
    await closeServer(clientServer);
    await closeServer(serverConsole);
    await closeServer(chatServer);
  }
});
