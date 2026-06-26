import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const WEB_PORT = Number(process.env.WEB_PORT || 8080);
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

function sendJson(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function safeJoin(base, requestPath) {
  const decodedPath = decodeURIComponent(requestPath.split('?')[0]);
  const normalizedPath = path.normalize(decodedPath).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.join(base, normalizedPath === '/' ? 'index.html' : normalizedPath);
  if (!filePath.startsWith(base)) return null;
  return filePath;
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const filePath = safeJoin(publicDir, req.url);
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

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let tcpSocket = null;
  let udpSocket = null;

  sendJson(ws, 'log', { level: 'info', message: 'WebSocket 已连接。' });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, 'log', { level: 'error', message: '收到无法解析的 JSON 消息。' });
      return;
    }

    if (msg.action === 'check') {
      sendJson(ws, 'runtime', {
        message: 'WSL Web 网关正常。Windows 可通过浏览器访问该页面。',
        webHost: WEB_HOST,
        webPort: WEB_PORT
      });
      return;
    }

    if (msg.action === 'connect_tcp') {
      const host = msg.host || '127.0.0.1';
      const port = Number(msg.port || 9000);

      if (tcpSocket) {
        tcpSocket.destroy();
        tcpSocket = null;
      }

      tcpSocket = net.createConnection({ host, port }, () => {
        sendJson(ws, 'tcp_status', { connected: true, host, port });
        sendJson(ws, 'log', { level: 'info', message: `已连接聊天 TCP 服务 ${host}:${port}` });
      });

      tcpSocket.on('data', (chunk) => {
        sendJson(ws, 'tcp_data', {
          bytes: chunk.length,
          textPreview: chunk.toString('utf8')
        });
      });

      tcpSocket.on('error', (err) => {
        sendJson(ws, 'tcp_status', { connected: false, host, port, error: err.message });
        sendJson(ws, 'log', { level: 'error', message: `TCP 连接失败：${err.message}` });
      });

      tcpSocket.on('close', () => {
        sendJson(ws, 'tcp_status', { connected: false, host, port });
        sendJson(ws, 'log', { level: 'warn', message: 'TCP 连接已关闭。' });
      });
      return;
    }

    if (msg.action === 'disconnect_tcp') {
      if (tcpSocket) {
        tcpSocket.destroy();
        tcpSocket = null;
      }
      sendJson(ws, 'tcp_status', { connected: false });
      return;
    }

    if (msg.action === 'listen_udp') {
      const port = Number(msg.port || 9001);
      if (udpSocket) {
        udpSocket.close();
        udpSocket = null;
      }

      udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      udpSocket.on('message', (buf, rinfo) => {
        sendJson(ws, 'udp_broadcast', {
          from: `${rinfo.address}:${rinfo.port}`,
          message: buf.toString('utf8')
        });
      });
      udpSocket.on('error', (err) => {
        sendJson(ws, 'log', { level: 'error', message: `UDP 监听失败：${err.message}` });
      });
      udpSocket.bind(port, '0.0.0.0', () => {
        sendJson(ws, 'log', { level: 'info', message: `已监听 UDP 广播端口 ${port}` });
      });
      return;
    }

    sendJson(ws, 'log', { level: 'warn', message: `未知 action: ${msg.action}` });
  });

  ws.on('close', () => {
    if (tcpSocket) tcpSocket.destroy();
    if (udpSocket) udpSocket.close();
  });
});

server.listen(WEB_PORT, WEB_HOST, () => {
  console.log(`WSL Web UI listening on http://${WEB_HOST}:${WEB_PORT}`);
  console.log(`Open from Windows browser: http://localhost:${WEB_PORT}`);
});
