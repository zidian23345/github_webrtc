# WebRTC 在线通讯应用

基于 [zoom-like](https://github.com/) 底层框架二次开发的实时通讯应用，集成了视频通话、语音通话、群聊、私聊、好友系统、屏幕共享等完整功能，并提供 Android 客户端。

## 功能特性

### 视频通话
- 基于 WebRTC + Socket.IO 信令，支持 1v1 视频通话
- 通话质量可调（低 300kbps / 中 1Mbps / 高 2.5Mbps）
- 通话记录同步到聊天会话
- 来电铃声 + 震动反馈（Android）

### 语音通话
- 支持私聊语音通话，独立的通话记录
- 通话状态实时推送（呼叫中 / 被拒 / 已取消 / 已完成）

### 聊天系统
- **群聊**：公用聊天室，支持文本、图片、语音、视频消息
- **私聊**：好友 1v1 私聊，支持文本、图片、语音、视频、通话记录
- **消息撤回**：2 分钟内可撤回
- **消息隐藏**：管理员可隐藏违规消息
- **时间分隔符**：私聊每 5 分钟显示时间分隔
- **客户端 Canvas 压缩图片**：最大 1280px，JPEG 0.8 质量
- **视频消息走 HTTP 上传**：避免 base64 撑爆 WebView

### 好友系统
- 搜索用户 / 发送好友请求 / 同意 / 拒绝 / 删除好友
- 好友在线状态实时推送
- 私聊消息服务端持久化（每对好友最近 50 条），客户端全量缓存

### 屏幕共享
- **Web 端**：使用 `getDisplayMedia` API
- **Android 端**：通过 MediaProjection 原生捕获，socket.io 转发帧
- 共享结束自动切回摄像头，保留摄像头开关状态

### Android 客户端
- WebView 容器加载 Web 应用，原生桥接增强能力
- 后台常驻服务保活（类似微信），收到消息/来电显示系统通知
- 应用内更新（versionCode 检测 + 下载安装）
- 自签名证书自动信任
- 振动权限、前台服务权限适配

### 管理员后台
- 访问 `/zidian` 进入（密码通过环境变量 `ADMIN_PASSWORD` 配置）
- 查看在线用户、历史用户、消息管理、好友关系、私聊记录
- 消息撤回 / 隐藏 / 删除
- 用户封禁（禁言 / 禁会议）

### 稳定性机制
- **HTTP 兜底**：Socket.IO 断连时通过 `/api/chat/history?after=<ts>` 增量同步消息
- **待处理来电队列**：服务端 `pendingCallInvites` 按被叫 userName 索引，客户端 4 秒轮询兜底
- **callId 去重**：socket 推送 + HTTP 轮询可能重复触发，基于 callId 去重
- **僵尸状态清理**：`currentCall` 残留 15 秒后自动清理，避免新来电被误拒

## 技术栈

| 层 | 技术 |
|---|---|
| 服务端 | Node.js + Express + Socket.IO + EJS |
| 信令 | Socket.IO（polling 优先，可升级到 websocket） |
| 媒体 | 原生 WebRTC API（已替换 PeerJS） |
| 前端 | Bootstrap + jQuery + Font Awesome |
| Android | Kotlin + WebView + MediaProjection + Foreground Service |
| 持久化 | JSON 文件按 userName 索引 |

## 目录结构

```
.
├── server.js                  # 服务端入口
├── generate-cert.js           # 生成自签名证书
├── start.bat                  # Windows 启动脚本
├── package.json
├── views/                     # EJS 页面
│   ├── home.ejs                # 主聊天界面
│   ├── room.ejs                # 通话房间
│   ├── admin.ejs              # 管理员后台
│   └── admin_login.ejs        # 管理员登录
├── public/
│   ├── scripts/               # 前端 JS
│   ├── styles/                # CSS + Bootstrap + FontAwesome
│   └── sounds/ring.mp3        # 来电铃声
├── data/                      # 运行时数据（已清空为示例结构）
│   ├── chat-history.json      # 群聊历史（最多 500 条）
│   ├── friends.json           # 好友关系
│   ├── friend-requests.json   # 好友请求
│   ├── user-avatars.json      # 用户头像
│   ├── banned-users.json      # 封禁用户
│   ├── hidden-messages.json   # 隐藏的消息
│   ├── app-version.json       # Android 版本信息
│   └── private-messages/      # 私聊消息目录
├── _android_project/          # Android 客户端源码
│   ├── app/src/main/java/com/webrtc/screenshare/
│   │   ├── MainActivity.kt
│   │   ├── SettingsActivity.kt
│   │   ├── ServerConfig.kt
│   │   ├── ScreenCaptureService.kt
│   │   └── ChatNotificationService.kt
│   ├── app/src/main/res/      # 布局、字符串、图标
│   └── gradle/wrapper/        # Gradle Wrapper
└── cert/                      # 证书目录（需自行生成，不入库）
```

## 部署步骤

### 1. 准备环境
- Node.js 16+
- Android Studio（如需编译客户端）

### 2. 克隆并安装依赖
```bash
git clone <your-repo-url>
cd webrtc
npm install
```

### 3. 生成自签名 HTTPS 证书
```bash
node generate-cert.js
```
证书会生成到 `cert/` 目录（已被 .gitignore 排除）。

### 4. 配置管理员密码
推荐通过环境变量配置，避免硬编码：
```bash
# Windows PowerShell
$env:ADMIN_PASSWORD="your-strong-password"
# Linux/macOS
export ADMIN_PASSWORD="your-strong-password"
```

或直接修改 `server.js` 顶部的 `ADMIN_PASSWORD` 默认值。

### 5. 启动服务
```bash
npm start
# 或
npm run dev   # 使用 nodemon 热重载
# 或
start.bat     # Windows 一键启动
```

服务默认监听 HTTPS 3030 端口。

### 6. 访问
- 主聊天界面：`https://<your-ip>:3030/`
- 管理员后台：`https://<your-ip>:3030/zidian`
- 通话房间：`https://<your-ip>:3030/room/<6位数字>`

### 7. Android 客户端编译
1. 用 Android Studio 打开 `_android_project/`
2. 修改 `app/src/main/java/com/webrtc/screenshare/ServerConfig.kt` 中的 `DEFAULT_SERVER_URL` 为你的服务器地址
3. 编译 APK 安装到手机

## 安全提示

- **部署前必改** `server.js` 中的 `ADMIN_PASSWORD` 默认值（`change-me`）
- 自签名证书仅适用于开发/内网，公网部署建议使用 Let's Encrypt 等正规证书
- `cert/` 目录已加入 .gitignore，证书不会被提交
- `data/` 目录下的 JSON 文件包含用户数据，生产环境请做好备份和权限控制

## 致谢

本项目基于 [omept/zoomlike-server](https://github.com/omept/zoomlike-server) 教程项目二次开发。

感谢原作者 [@omept](https://github.com/omept) 提供的 WebRTC + Socket.IO + NodeJS 基础框架（视频会议、屏幕共享、聊天功能原型），本项目在此基础上扩展了以下能力：

- 完整的聊天系统（群聊 + 私聊 + 好友系统）
- 语音通话 + 私聊通话记录
- 管理员后台
- Android 客户端（WebView + 原生桥接）
- HTTP 兜底机制（外网 socket 不稳定场景）
- 通话状态管理优化（僵尸状态检测、callId 去重）

原项目为教程性质，本项目对其进行了大幅修改和功能扩展。

## License

[MIT License](LICENSE) - Copyright (c) 2026 郭子琦 (zidian23345)
