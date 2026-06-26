# WSL Web UI Skeleton

该目录用于替代 Tauri 桌面壳。运行方式是在 WSL 中启动一个 Web 服务，然后从 Windows 浏览器访问。

## 启动

```bash
cd web
npm install
npm run dev
```

Windows 浏览器访问：

```text
http://localhost:8080
```

## 与现有 C 服务端配合

另一个 WSL 终端启动：

```bash
cd ~/multi_user_chat
make clean && make
./server_app 9000 9001
```

Web 页面中点击“连接 TCP”即可测试 Node 网关是否能连接到现有 C 服务端。

## 当前状态

当前版本只完成：

- 静态页面服务；
- 浏览器到 WSL 网关的 WebSocket 通道；
- WSL 网关到 C 服务端的 TCP 连接测试；
- 可选 UDP 监听测试。

注册、登录、私聊、群聊、文件发送仍需要根据 `include/protocol.h` 的真实协议格式继续接入。
