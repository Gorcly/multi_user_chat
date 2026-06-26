const $ = (selector) => document.querySelector(selector);

const logEl = $('#log');
const statusEl = $('#status');
let ws;

function appendLog(message, level = 'info') {
  const row = document.createElement('div');
  row.className = `log-row ${level}`;
  row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function connectWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return ws;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    appendLog('浏览器已连接 WSL WebSocket 网关。');
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'log') appendLog(msg.message, msg.level);
    if (msg.type === 'runtime') appendLog(msg.message);
    if (msg.type === 'tcp_status') {
      statusEl.textContent = msg.connected ? `TCP 已连接 ${msg.host}:${msg.port}` : 'TCP 未连接';
      statusEl.className = `status ${msg.connected ? 'online' : 'offline'}`;
      if (msg.error) appendLog(msg.error, 'error');
    }
    if (msg.type === 'tcp_data') {
      appendLog(`收到 TCP 数据 ${msg.bytes} bytes：${msg.textPreview}`);
    }
    if (msg.type === 'udp_broadcast') {
      appendLog(`[UDP广播] ${msg.message} (${msg.from})`);
    }
  });

  ws.addEventListener('close', () => {
    appendLog('WebSocket 网关连接已关闭。', 'warn');
  });

  ws.addEventListener('error', () => {
    appendLog('WebSocket 网关连接异常。', 'error');
  });

  return ws;
}

function send(action, payload = {}) {
  const socket = connectWs();
  const trySend = () => socket.send(JSON.stringify({ action, ...payload }));

  if (socket.readyState === WebSocket.OPEN) {
    trySend();
  } else {
    socket.addEventListener('open', trySend, { once: true });
  }
}

$('#checkBtn').addEventListener('click', () => send('check'));

$('#connectTcpBtn').addEventListener('click', () => {
  send('connect_tcp', {
    host: $('#host').value.trim() || '127.0.0.1',
    port: Number($('#tcpPort').value || 9000)
  });
});

$('#disconnectTcpBtn').addEventListener('click', () => send('disconnect_tcp'));

$('#listenUdpBtn').addEventListener('click', () => {
  send('listen_udp', { port: Number($('#udpPort').value || 9001) });
});

connectWs();
appendLog('页面已加载。先在 WSL 中启动 ./server_app 9000 9001，再点击连接 TCP。');
