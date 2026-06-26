import { invoke } from "@tauri-apps/api/core";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("#app not found");
}

app.innerHTML = `
  <main class="layout">
    <aside class="sidebar">
      <h1>多用户聊天系统</h1>
      <p class="muted">Tauri / WebView2 桌面端骨架</p>

      <section class="card">
        <h2>连接服务器</h2>
        <label>
          主机
          <input id="host" value="127.0.0.1" />
        </label>
        <label>
          TCP 端口
          <input id="tcpPort" value="9000" />
        </label>
        <label>
          UDP 端口
          <input id="udpPort" value="9001" />
        </label>
        <button id="connectBtn">测试 Rust 通道</button>
      </section>

      <section class="card">
        <h2>账号</h2>
        <label>
          用户名
          <input id="username" placeholder="user1" />
        </label>
        <label>
          密码
          <input id="password" type="password" placeholder="pw1" />
        </label>
        <div class="buttonRow">
          <button id="registerBtn" disabled>注册</button>
          <button id="loginBtn" disabled>登录</button>
        </div>
      </section>
    </aside>

    <section class="chatPanel">
      <header class="chatHeader">
        <div>
          <h2>聊天窗口</h2>
          <p class="muted">后续把现有 C 协议映射到 Rust TCP/UDP 客户端。</p>
        </div>
        <button id="onlineBtn" disabled>刷新在线用户</button>
      </header>

      <div id="messages" class="messages">
        <div class="message system">桌面端骨架已创建。当前只验证 Tauri 前端与 Rust 后端 invoke 通道。</div>
      </div>

      <footer class="composer">
        <select id="messageType" disabled>
          <option value="private">私聊</option>
          <option value="group">群聊</option>
        </select>
        <input id="receiver" placeholder="接收者，如 user2" disabled />
        <input id="messageInput" placeholder="输入消息" disabled />
        <button id="sendBtn" disabled>发送</button>
      </footer>
    </section>
  </main>
`;

const messages = document.querySelector<HTMLDivElement>("#messages")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connectBtn")!;

function addMessage(text: string, kind: "system" | "self" | "peer" = "system") {
  const item = document.createElement("div");
  item.className = `message ${kind}`;
  item.textContent = text;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
}

connectBtn.addEventListener("click", async () => {
  const host = document.querySelector<HTMLInputElement>("#host")!.value.trim();
  const tcpPort = document.querySelector<HTMLInputElement>("#tcpPort")!.value.trim();
  const udpPort = document.querySelector<HTMLInputElement>("#udpPort")!.value.trim();

  try {
    const result = await invoke<string>("check_runtime", {
      host,
      tcpPort: Number(tcpPort),
      udpPort: Number(udpPort)
    });
    addMessage(result);
  } catch (error) {
    addMessage(`调用失败: ${String(error)}`);
  }
});
