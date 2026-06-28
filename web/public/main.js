const $ = (selector) => document.querySelector(selector);

const PACKET_DATA_MAX = 1024;
const FILE_TRANSFER_MAX_BYTES = 10 * 1024 * 1024;
const KNOWN_CONTACTS_KEY = 'multiUserChatKnownContacts';
const DEFAULT_CHAT_HOST = '127.0.0.1';
const DEFAULT_TCP_PORT = 9000;
const DEFAULT_UDP_PORT = 9001;

const authView = $('#authView');
const chatView = $('#chatView');
const authMessage = $('#authMessage');
const currentUserEl = $('#currentUser');
const connectionStatusEl = $('#connectionStatus');
const targetNameEl = $('#chatTargetName');
const targetDotEl = $('#targetDot');
const rosterListEl = $('#rosterList');
const messageFeed = $('#messageFeed');
const systemFeed = $('#systemFeed');
const contactSearchEl = $('#contactSearch');
const friendTabEl = $('#friendTab');
const groupTabEl = $('#groupTab');
const navFriendsEl = $('#navFriends');
const navGroupsEl = $('#navGroups');
const messageInputEl = $('#messageInput');
const fileInputEl = $('#fileInput');
const filePreviewEl = $('#filePreview');
const newGroupBtnEl = $('#newGroupBtn');
const groupDialogEl = $('#groupDialog');
const groupFormEl = $('#groupForm');
const groupNameInputEl = $('#groupNameInput');
const groupMemberListEl = $('#groupMemberList');
const groupFormMessageEl = $('#groupFormMessage');
const createGroupBtnEl = $('#createGroupBtn');

let ws;
let currentUsername = '';
let currentTab = 'friends';
let onlineUsers = [];
let groups = [];
let knownContacts = loadKnownContacts();
let selectedFile = null;
let onlineRefreshTimer = null;
let selectedConversation = {
  mode: 'none',
  id: '',
  name: '请选择会话',
  online: false,
};
const conversations = new Map();

function emptyConversation() {
  return {
    mode: 'none',
    id: '',
    name: '请选择会话',
    online: false,
  };
}

function loadKnownContacts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KNOWN_CONTACTS_KEY) || '[]');
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === 'string' && item.trim()).slice(0, 80);
    }
  } catch {
    // Ignore malformed localStorage entries.
  }
  return ['user1', 'user2', 'user3'];
}

function saveKnownContacts() {
  const unique = Array.from(new Set(knownContacts.filter(Boolean)));
  knownContacts = unique;
  localStorage.setItem(KNOWN_CONTACTS_KEY, JSON.stringify(unique.slice(0, 80)));
}

function nowText() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function todayText() {
  return new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replaceAll('/', '-');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeText(text) {
  return String(text ?? '').replace(/[&<>"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[ch]));
}

function conversationKey(conversation = selectedConversation) {
  return `${conversation.mode}:${conversation.id}`;
}

function getConversationMessages(conversation = selectedConversation) {
  const key = conversationKey(conversation);
  if (!conversations.has(key)) {
    conversations.set(key, []);
  }
  return conversations.get(key);
}

function pushMessage(message, conversation = selectedConversation) {
  getConversationMessages(conversation).push({
    time: nowText(),
    ...message,
  });
  if (conversationKey(conversation) === conversationKey(selectedConversation)) {
    renderMessages();
  }
}

function initials(name) {
  const text = String(name || '?').trim();
  if (!text) return '?';
  const chars = Array.from(text);
  if (/^[A-Za-z0-9_\-]+$/.test(text)) {
    return text.slice(0, 2).toUpperCase();
  }
  return chars.slice(0, 2).join('');
}

function setAuthMessage(text, level = 'info') {
  authMessage.textContent = text;
  authMessage.className = `form-message ${level}`;
}

function setConnectionStatus(text, online = false) {
  connectionStatusEl.textContent = text;
  if (selectedConversation.mode === 'friend') {
    targetDotEl.className = `presence-dot ${online ? 'online' : ''}`;
  }
}

function addToast(text, level = 'info', link) {
  const row = document.createElement('div');
  row.className = `toast ${level}`;
  const prefix = document.createElement('span');
  prefix.textContent = `${nowText()}  ${text}`;
  row.appendChild(prefix);
  if (link) {
    row.appendChild(document.createTextNode(' '));
    row.appendChild(link);
  }
  systemFeed.appendChild(row);
  while (systemFeed.children.length > 4) {
    systemFeed.removeChild(systemFeed.firstElementChild);
  }
  window.setTimeout(() => row.remove(), 8000);
}

function appendEntry(container, text, level = 'info', link) {
  if (container === systemFeed) {
    addToast(text, level, link);
    return;
  }
  pushMessage({ direction: 'system', text });
}

function updateTabs() {
  const friends = currentTab === 'friends';
  friendTabEl.classList.toggle('active', friends);
  groupTabEl.classList.toggle('active', !friends);
  friendTabEl.setAttribute('aria-selected', String(friends));
  groupTabEl.setAttribute('aria-selected', String(!friends));
  navFriendsEl.classList.toggle('active', friends);
  navGroupsEl.classList.toggle('active', !friends);
}

function setTab(tab) {
  currentTab = tab;
  updateTabs();
  newGroupBtnEl.hidden = currentTab !== 'groups';
  renderRoster();
}

function authPayload() {
  return {
    host: DEFAULT_CHAT_HOST,
    port: DEFAULT_TCP_PORT,
    udpPort: DEFAULT_UDP_PORT,
    username: $('#username').value.trim(),
    password: $('#password').value,
  };
}

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return ws;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    setAuthMessage('网关已连接');
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    handleGatewayMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (!chatView.hidden) {
      addToast('WebSocket 已关闭', 'warn');
      setConnectionStatus('连接已关闭', false);
    } else {
      setAuthMessage('网关连接已关闭', 'warn');
    }
  });

  ws.addEventListener('error', () => {
    if (!chatView.hidden) {
      addToast('WebSocket 连接异常', 'error');
    } else {
      setAuthMessage('网关连接异常', 'error');
    }
  });

  return ws;
}

function send(action, payload = {}) {
  const socket = connectWs();
  const sendNow = () => socket.send(JSON.stringify({ action, ...payload }));
  if (socket.readyState === WebSocket.OPEN) {
    sendNow();
  } else {
    socket.addEventListener('open', sendNow, { once: true });
  }
}

function startOnlineRefresh() {
  if (onlineRefreshTimer) {
    clearInterval(onlineRefreshTimer);
  }
  onlineRefreshTimer = window.setInterval(() => {
    if (!chatView.hidden) {
      send('online_list');
      send('group_list');
    }
  }, 10000);
}

function stopOnlineRefresh() {
  if (onlineRefreshTimer) {
    clearInterval(onlineRefreshTimer);
    onlineRefreshTimer = null;
  }
}

function showChat(username) {
  currentUsername = username;
  if (!knownContacts.includes(username)) {
    knownContacts.unshift(username);
  }
  saveKnownContacts();
  currentUserEl.textContent = `当前用户：${username}`;
  authView.hidden = true;
  chatView.hidden = false;
  setConnectionStatus('已登录', true);
  groups = [];
  selectedConversation = emptyConversation();
  updateHeader();
  renderRoster();
  renderMessages();
  startOnlineRefresh();
}

function showAuth(message = '') {
  stopOnlineRefresh();
  currentUsername = '';
  groups = [];
  selectedConversation = emptyConversation();
  currentUserEl.textContent = '未登录';
  authView.hidden = false;
  chatView.hidden = true;
  setAuthMessage(message);
}

function updateHeader() {
  targetNameEl.textContent = selectedConversation.name;
  if (selectedConversation.mode === 'none') {
    targetDotEl.className = 'presence-dot';
    connectionStatusEl.textContent = '请选择好友或群聊';
    return;
  }
  const isOnline = selectedConversation.mode === 'group' || onlineUsers.includes(selectedConversation.id);
  targetDotEl.className = `presence-dot ${isOnline ? 'online' : ''}`;
  connectionStatusEl.textContent = selectedConversation.mode === 'group'
    ? '群组会话'
    : (isOnline ? '在线' : '离线');
}

function makeRosterButton({ mode, id, name, subtitle, icon, online, accent = 'a3' }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'roster-card';
  if (selectedConversation.mode === mode && selectedConversation.id === id) {
    button.classList.add('active');
  }

  const avatar = document.createElement('span');
  avatar.className = `avatar ${mode === 'group' ? 'group' : ''} ${accent}`;
  avatar.textContent = icon || initials(name);
  button.appendChild(avatar);

  const main = document.createElement('span');
  main.className = 'roster-main';
  const title = document.createElement('span');
  title.className = 'roster-name';
  title.textContent = name;
  const sub = document.createElement('span');
  sub.className = `roster-subtitle ${online ? 'online-text' : ''}`;
  sub.textContent = subtitle;
  main.append(title, sub);
  button.appendChild(main);

  const dot = document.createElement('span');
  dot.className = `presence-dot ${online ? 'online' : ''}`;
  button.appendChild(dot);

  button.addEventListener('click', () => {
    selectedConversation = { mode, id, name, online };
    currentTab = mode === 'group' ? 'groups' : 'friends';
    updateHeader();
    updateTabs();
    renderRoster();
    renderMessages();
    messageInputEl.focus();
  });

  return button;
}

function rosterItems() {
  const query = contactSearchEl.value.trim().toLowerCase();
  if (currentTab === 'groups') {
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
  }

  const names = Array.from(new Set([...onlineUsers, ...knownContacts]))
    .filter((name) => name && name !== currentUsername)
    .sort((a, b) => {
      const ao = onlineUsers.includes(a) ? 0 : 1;
      const bo = onlineUsers.includes(b) ? 0 : 1;
      return ao - bo || a.localeCompare(b, 'zh-CN');
    });

  if (currentUsername && names.length === 0) {
    names.push(currentUsername);
  }

  return names
    .filter((name) => !query || name.toLowerCase().includes(query))
    .map((name, index) => {
      const online = onlineUsers.includes(name);
      const self = name === currentUsername;
      return {
        mode: 'friend',
        id: name,
        name: self ? `${name}（我）` : name,
        subtitle: online ? '在线' : '离线',
        icon: initials(name),
        online,
        accent: `a${(index % 6) + 1}`,
      };
    });
}

function renderRoster() {
  updateTabs();
  rosterListEl.replaceChildren();
  const items = rosterItems();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = currentTab === 'groups' ? '还没有在线群聊' : '没有匹配的好友';
    rosterListEl.appendChild(empty);
    return;
  }
  for (const item of items) {
    rosterListEl.appendChild(makeRosterButton(item));
  }
}

function renderOnlineUsers(users) {
  onlineUsers = Array.from(new Set((users || []).filter(Boolean)));
  for (const user of onlineUsers) {
    if (!knownContacts.includes(user)) {
      knownContacts.push(user);
    }
  }
  saveKnownContacts();

  if (selectedConversation.mode === 'friend') {
    selectedConversation.online = onlineUsers.includes(selectedConversation.id);
  }
  if (groupDialogEl.open) {
    renderGroupMemberOptions();
  }
  updateHeader();
  renderRoster();
}

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
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = user;
    const name = document.createElement('span');
    name.textContent = user;
    label.append(checkbox, name);
    groupMemberListEl.appendChild(label);
  }
}

function openGroupDialog() {
  send('online_list');
  groupNameInputEl.value = '';
  setGroupFormMessage('');
  renderGroupMemberOptions();
  groupDialogEl.showModal();
  groupNameInputEl.focus();
}

function closeGroupDialog() {
  if (groupDialogEl.open) {
    groupDialogEl.close();
  }
}

function renderMessages() {
  messageFeed.replaceChildren();
  const divider = document.createElement('div');
  divider.className = 'date-divider';
  divider.textContent = todayText();
  messageFeed.appendChild(divider);

  const messages = getConversationMessages();
  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'message-row system';
    empty.innerHTML = '<div class="system-bubble">选择好友或群组后即可开始聊天</div>';
    messageFeed.appendChild(empty);
    return;
  }

  for (const message of messages) {
    const row = document.createElement('div');
    row.className = `message-row ${message.direction || 'in'}`;

    if (message.direction === 'system') {
      row.innerHTML = `<div class="system-bubble">${escapeText(message.text)}</div>`;
      messageFeed.appendChild(row);
      continue;
    }

    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.textContent = initials(message.direction === 'out' ? currentUsername : message.sender);

    const stack = document.createElement('div');
    stack.className = 'message-stack';

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = message.direction === 'out'
      ? message.time
      : `${message.sender || selectedConversation.name}  ${message.time}`;
    stack.appendChild(meta);

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (message.kind === 'file') {
      const urlPart = message.url
        ? `<a href="${message.url}" download="${escapeText(message.filename)}">下载</a>`
        : '<span>✓</span>';
      bubble.classList.add('file-bubble');
      bubble.innerHTML = `
        <span class="file-icon">PDF</span>
        <span>
          <span class="file-name">${escapeText(message.filename)}</span>
          <span class="file-size">${formatBytes(message.size)}</span>
        </span>
        ${urlPart}
      `;
    } else {
      bubble.textContent = message.text;
    }

    stack.appendChild(bubble);

    if (message.direction === 'out') {
      row.append(stack, avatar);
    } else {
      row.append(avatar, stack);
    }
    messageFeed.appendChild(row);
  }

  messageFeed.scrollTop = messageFeed.scrollHeight;
}

function base64ToBlobUrl(base64) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes]));
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function updateFilePreview() {
  filePreviewEl.replaceChildren();
  if (!selectedFile) {
    filePreviewEl.hidden = true;
    return;
  }

  filePreviewEl.hidden = false;
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.textContent = selectedFile.name.split('.').pop()?.slice(0, 3).toUpperCase() || 'FILE';

  const main = document.createElement('span');
  main.innerHTML = `<span class="file-name">${escapeText(selectedFile.name)}</span><span class="file-size">${formatBytes(selectedFile.size)}</span>`;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = '取消选择';
  remove.addEventListener('click', () => {
    selectedFile = null;
    fileInputEl.value = '';
    updateFilePreview();
  });

  filePreviewEl.append(icon, main, remove);
}

async function submitSelectedFile(receiver) {
  if (!selectedFile) return false;
  if (!receiver || receiver === currentUsername) {
    addToast('文件传输需要先选择一个在线好友，不能发送给自己或群组', 'warn');
    return true;
  }
  if (selectedFile.size > FILE_TRANSFER_MAX_BYTES) {
    addToast('文件超过 10 MiB 限制', 'error');
    return true;
  }

  const file = selectedFile;
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  send('send_file_begin', {
    receiver,
    filename: file.name,
    filesize: file.size,
  });
  for (let offset = 0; offset < bytes.length; offset += PACKET_DATA_MAX) {
    send('send_file_chunk', {
      receiver,
      dataBase64: bytesToBase64(bytes.subarray(offset, offset + PACKET_DATA_MAX)),
    });
  }
  send('send_file_end', { receiver });

  pushMessage({
    direction: 'out',
    kind: 'file',
    filename: file.name,
    size: file.size,
  });
  addToast(`文件发送请求已提交：${file.name}`);
  selectedFile = null;
  fileInputEl.value = '';
  updateFilePreview();
  return true;
}

function upsertGroup(group) {
  if (!group?.id) {
    return;
  }
  const index = groups.findIndex((item) => item.id === group.id);
  if (index >= 0) {
    groups[index] = group;
  } else {
    groups.push(group);
  }
}

function handleGatewayMessage(msg) {
  if (msg.type === 'auth_result') {
    if (msg.action === 'login' && msg.ok) {
      showChat(msg.username);
      addToast(msg.message);
      send('online_list');
      send('group_list');
      send('listen_udp', { port: DEFAULT_UDP_PORT });
      return;
    }
    setAuthMessage(msg.message, msg.ok ? 'success' : 'error');
    return;
  }

  if (msg.type === 'online_list') {
    renderOnlineUsers(msg.users || []);
    return;
  }

  if (msg.type === 'group_list') {
    const previousConversation = selectedConversation;
    groups = msg.groups || [];
    if (previousConversation.mode === 'group' &&
        !groups.some((group) => group.id === previousConversation.id)) {
      pushMessage({ direction: 'system', text: '当前群聊已结束' }, previousConversation);
      selectedConversation = emptyConversation();
    }
    updateHeader();
    renderRoster();
    renderMessages();
    return;
  }

  if (msg.type === 'group_event') {
    const group = msg.group;
    upsertGroup(group);
    if (selectedConversation.mode === 'group' && selectedConversation.id === group.id) {
      selectedConversation = {
        mode: 'group',
        id: group.id,
        name: group.name,
        online: true,
      };
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

  if (msg.type === 'chat_message') {
    const isGroup = msg.mode === 'group';
    const conversation = isGroup
      ? { mode: 'group', id: msg.groupId || 'legacy-broadcast', name: msg.groupName || '群聊', online: true }
      : { mode: 'friend', id: msg.sender, name: msg.sender, online: onlineUsers.includes(msg.sender) };
    if (isGroup && !groups.some((group) => group.id === conversation.id)) {
      upsertGroup({ id: conversation.id, name: conversation.name, members: [] });
      renderRoster();
    }
    if (!knownContacts.includes(msg.sender)) {
      knownContacts.push(msg.sender);
      saveKnownContacts();
      renderRoster();
    }
    pushMessage({
      direction: msg.sender === currentUsername ? 'out' : 'in',
      sender: msg.sender,
      text: msg.text,
    }, conversation);
    return;
  }

  if (msg.type === 'file_progress') {
    addToast(`文件接收 ${msg.filename}: ${msg.receivedSize} / ${msg.expectedSize} bytes`);
    return;
  }

  if (msg.type === 'file_received') {
    const url = base64ToBlobUrl(msg.dataBase64);
    const conversation = { mode: 'friend', id: msg.sender, name: msg.sender, online: onlineUsers.includes(msg.sender) };
    pushMessage({
      direction: 'in',
      sender: msg.sender,
      kind: 'file',
      filename: msg.filename,
      size: msg.size,
      url,
    }, conversation);
    return;
  }

  if (msg.type === 'udp_broadcast') {
    addToast(`[UDP广播] ${msg.message}`, 'broadcast');
    return;
  }

  if (msg.type === 'status') {
    if (msg.status === 'logged_out') {
      groups = [];
      selectedConversation = emptyConversation();
      conversations.clear();
      messageFeed.replaceChildren();
      systemFeed.replaceChildren();
      rosterListEl.replaceChildren();
      showAuth(msg.message || '已退出登录');
      return;
    }
    if (msg.status === 'tcp_connected') {
      setConnectionStatus(msg.message, true);
    }
    addToast(msg.message || msg.status, msg.ok === false ? 'error' : 'info');
    return;
  }

  if (msg.type === 'error') {
    if (chatView.hidden) {
      setAuthMessage(msg.message, 'error');
    } else {
      addToast(msg.message, 'error');
    }
  }
}

$('#authForm').addEventListener('submit', (event) => {
  event.preventDefault();
  setAuthMessage('正在登录...');
  send('login', authPayload());
});

$('#registerBtn').addEventListener('click', () => {
  setAuthMessage('正在注册...');
  send('register', authPayload());
});

$('#logoutBtn').addEventListener('click', () => send('logout'));

friendTabEl.addEventListener('click', () => setTab('friends'));
groupTabEl.addEventListener('click', () => setTab('groups'));
navFriendsEl.addEventListener('click', () => setTab('friends'));
navGroupsEl.addEventListener('click', () => setTab('groups'));

contactSearchEl.addEventListener('input', renderRoster);
newGroupBtnEl.addEventListener('click', openGroupDialog);
$('#closeGroupDialogBtn').addEventListener('click', closeGroupDialog);
$('#cancelGroupBtn').addEventListener('click', closeGroupDialog);

groupFormEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const members = Array.from(groupMemberListEl.querySelectorAll('input[type="checkbox"]:checked'))
    .map((input) => input.value);
  const name = groupNameInputEl.value.trim();
  if (!name) {
    setGroupFormMessage('请输入群名', 'error');
    return;
  }
  if (members.length === 0) {
    setGroupFormMessage('请至少选择一名在线成员', 'error');
    return;
  }
  setGroupFormMessage('正在创建...');
  send('create_group', { name, members });
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !chatView.hidden) {
    event.preventDefault();
    contactSearchEl.focus();
    contactSearchEl.select();
  }
});

$('#attachBtn').addEventListener('click', () => fileInputEl.click());

fileInputEl.addEventListener('change', () => {
  selectedFile = fileInputEl.files[0] || null;
  updateFilePreview();
});

messageInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.ctrlKey && !event.shiftKey) {
    event.preventDefault();
    $('#composerForm').requestSubmit();
  }
  if (event.key === 'Enter' && event.ctrlKey) {
    const start = messageInputEl.selectionStart;
    const end = messageInputEl.selectionEnd;
    messageInputEl.value = `${messageInputEl.value.slice(0, start)}\n${messageInputEl.value.slice(end)}`;
    messageInputEl.selectionStart = messageInputEl.selectionEnd = start + 1;
  }
});

$('#composerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = messageInputEl.value.trim();

  if (selectedFile) {
    const receiver = selectedConversation.mode === 'friend' ? selectedConversation.id : '';
    await submitSelectedFile(receiver);
    return;
  }

  if (!text) {
    addToast('请输入消息内容或选择文件', 'warn');
    return;
  }

  if (selectedConversation.mode === 'group') {
    if (!selectedConversation.id) {
      addToast('请选择群聊后再发送消息', 'warn');
      return;
    }
    send('send_group_message', { groupId: selectedConversation.id, text });
  } else {
    if (selectedConversation.mode !== 'friend') {
      addToast('请选择一个好友或群聊后再发送消息', 'warn');
      return;
    }
    if (!selectedConversation.id || selectedConversation.id === currentUsername) {
      addToast('请选择一个好友后再发送私聊消息', 'warn');
      return;
    }
    send('send_private', {
      receiver: selectedConversation.id,
      text,
    });
    pushMessage({ direction: 'out', text });
  }

  messageInputEl.value = '';
});

setTab('friends');
connectWs();

window.addEventListener('focus', () => {
  if (!chatView.hidden) {
    send('online_list');
    send('group_list');
  }
});
