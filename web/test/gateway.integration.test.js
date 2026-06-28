import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import WebSocket from 'ws';

const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const PROJECT_ROOT = path.resolve(WEB_ROOT, '..');
const SERVER_APP = path.join(PROJECT_ROOT, 'server_app');
const CLIENT_WEB_PORT = 18080;
const SERVER_WEB_PORT = 18081;
const CHAT_PORT = 19100;
const UDP_PORT = 19101;

function uncToWslPath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const match = normalized.match(/^\/\/wsl(?:\.localhost)?\/([^/]+)(\/.*)$/i);
  if (!match) {
    return null;
  }
  return { distro: match[1], linuxPath: match[2] };
}

function spawnLinuxCommand(command, args, options = {}) {
  if (process.platform !== 'win32') {
    return spawn(command, args, options);
  }

  const cwd = options.cwd ?? process.cwd();
  const converted = uncToWslPath(cwd);
  const convertedCommand = uncToWslPath(command);
  if (!converted || !convertedCommand) {
    throw new Error(`cannot convert ${cwd} or ${command} to a WSL path`);
  }

  return spawn(
    'wsl.exe',
    ['-d', converted.distro, '--cd', converted.linuxPath, convertedCommand.linuxPath, ...args],
    { ...options, cwd: undefined }
  );
}

async function waitForOutput(child, pattern) {
  let output = '';
  const onData = (chunk) => {
    output += chunk.toString('utf8');
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), 5000);
    const check = () => {
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });

  try {
    await started;
  } catch (error) {
    error.message += `\nOutput:\n${output}`;
    throw error;
  } finally {
    child.stdout.off('data', onData);
    child.stderr.off('data', onData);
  }
}

async function waitForHttp(url, getOutput = () => '') {
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const statusCode = await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.setTimeout(1000, () => {
          req.destroy(new Error('HTTP probe timed out'));
        });
        req.on('error', reject);
      });
      if (statusCode >= 200 && statusCode < 300) {
        return;
      }
      lastError = new Error(`HTTP ${statusCode}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message}\nOutput:\n${getOutput()}`);
}

function connectGateway() {
  const ws = new WebSocket(`ws://127.0.0.1:${CLIENT_WEB_PORT}/ws`);
  const messages = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
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

  return once(ws, 'open').then(() => ({
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
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 6000);
        waiters.push({ type, predicate, resolve, timer });
      });
    },
    waitForNoMessage(type, predicate, timeoutMs = 300) {
      const foundIndex = messages.findIndex((message) => {
        return message.type === type && (!predicate || predicate(message));
      });
      if (foundIndex >= 0) {
        throw new Error(`unexpected ${type}: ${JSON.stringify(messages[foundIndex])}`);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          predicate,
          resolve: (message) => {
            clearTimeout(waiter.timer);
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(new Error(`unexpected ${type}: ${JSON.stringify(message)}`));
          },
          timer: null,
        };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          resolve();
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close() {
      ws.close();
    },
  }));
}

function authPayload(username, password) {
  return {
    host: '127.0.0.1',
    port: CHAT_PORT,
    udpPort: UDP_PORT,
    username,
    password,
  };
}

test('web gateway supports auth, chat, file transfer, and UDP broadcast', async () => {
  const tmpDir = path.join(PROJECT_ROOT, 'test', 'tmp', 'web-gateway');
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });

  const chatServer = spawnLinuxCommand(SERVER_APP, [String(CHAT_PORT), String(UDP_PORT)], {
    cwd: tmpDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let webOutput = '';
  const webServer = spawn(process.execPath, ['server.js'], {
    cwd: WEB_ROOT,
    env: {
      ...process.env,
      CLIENT_WEB_PORT: String(CLIENT_WEB_PORT),
      SERVER_WEB_PORT: String(SERVER_WEB_PORT),
      WEB_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  webServer.stdout.on('data', (chunk) => {
    webOutput += chunk.toString('utf8');
  });
  webServer.stderr.on('data', (chunk) => {
    webOutput += chunk.toString('utf8');
  });

  test.after(async () => {
    chatServer.stdin.write('/quit\n');
    chatServer.stdin.end();
    webServer.kill();
    await Promise.race([once(chatServer, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
    await Promise.race([once(webServer, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  });

  await waitForOutput(chatServer, /服务器已启动/);
  await waitForHttp(`http://127.0.0.1:${CLIENT_WEB_PORT}/`, () => webOutput);
  await waitForHttp(`http://127.0.0.1:${SERVER_WEB_PORT}/`, () => webOutput);

  const user1 = await connectGateway();
  const user2 = await connectGateway();
  let user3 = null;
  const suffix = Date.now().toString(36);
  const user1Name = `u1_${suffix}`;
  const user2Name = `u2_${suffix}`;
  const user3Name = `u3_${suffix}`;

  user1.send('register', authPayload(user1Name, 'pw1'));
  assert.deepEqual(
    await user1.waitFor('auth_result', (message) => message.action === 'register'),
    { type: 'auth_result', action: 'register', ok: true, message: '注册成功', username: user1Name }
  );

  user2.send('register', authPayload(user2Name, 'pw2'));
  assert.equal((await user2.waitFor('auth_result', (message) => message.action === 'register')).ok, true);

  user1.send('login', authPayload(user1Name, 'pw1'));
  assert.equal((await user1.waitFor('auth_result', (message) => message.action === 'login')).ok, true);
  user2.send('login', authPayload(user2Name, 'pw2'));
  assert.equal((await user2.waitFor('auth_result', (message) => message.action === 'login')).ok, true);

  user1.send('online_list');
  const online = await user1.waitFor('online_list');
  assert.deepEqual(new Set(online.users), new Set([user1Name, user2Name]));

  user1.send('send_private', { receiver: user2Name, text: 'hello-private' });
  assert.equal((await user2.waitFor('chat_message')).text, 'hello-private');

  user1.send('send_group', { text: 'hello-group' });
  assert.equal((await user2.waitFor('chat_message')).text, 'hello-group');

  user1.send('send_file_begin', {
    receiver: user2Name,
    filename: 'sample.txt',
    filesize: Buffer.byteLength('file from web'),
  });
  user1.send('send_file_chunk', {
    receiver: user2Name,
    dataBase64: Buffer.from('file from web').toString('base64'),
  });
  user1.send('send_file_end', { receiver: user2Name });
  const file = await user2.waitFor('file_received');
  assert.equal(file.filename, 'sample.txt');
  assert.equal(Buffer.from(file.dataBase64, 'base64').toString('utf8'), 'file from web');

  user1.send('listen_udp', { port: UDP_PORT });
  user2.send('listen_udp', { port: UDP_PORT });
  await user1.waitFor('status', (message) => message.message.includes('UDP'));
  await user2.waitFor('status', (message) => message.message.includes('UDP'));
  chatServer.stdin.write('/broadcast web-broadcast\n');
  assert.equal((await user1.waitFor('udp_broadcast')).message, 'web-broadcast');
  assert.equal((await user2.waitFor('udp_broadcast')).message, 'web-broadcast');

  user3 = await connectGateway();
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
  const groupList = await user1.waitFor('group_list');
  assert.equal(groupList.groups[0].id, createEvent1.group.id);

  user1.send('send_group_message', { groupId: createEvent1.group.id, text: 'hello-real-group' });
  assert.equal((await user1.waitFor('chat_message', (message) => message.mode === 'group')).text, 'hello-real-group');
  assert.equal((await user2.waitFor('chat_message', (message) => message.mode === 'group')).text, 'hello-real-group');
  await user3.waitForNoMessage('chat_message', (message) => message.text === 'hello-real-group');

  user2.send('logout');
  assert.equal((await user2.waitFor('status', (message) => message.status === 'logged_out')).status, 'logged_out');
  const leaveEvent = await user1.waitFor('group_event', (message) => message.event === 'member_left');
  assert.deepEqual(leaveEvent.group.members, [user1Name]);

  user1.send('logout');
  assert.equal((await user1.waitFor('status', (message) => message.status === 'logged_out')).status, 'logged_out');
  user1.close();
  user2.close();
  user3.close();
});
