const express = require('express');
const app = express();
const { ExpressPeerServer } = require('peer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

// ===== 管理员配置 =====
// 部署前请修改为强密码，或通过环境变量注入：process.env.ADMIN_PASSWORD || 'change-me'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const ADMIN_COOKIE_NAME = 'zidian_admin';
const adminSessions = new Set();

// ===== 聊天功能配置 =====
const MAX_CHAT_HISTORY = 500;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_VOICE_SIZE = 2 * 1024 * 1024;  // 语音最大 2MB
const NAME_LOCK_DURATION = 5 * 60 * 1000;

// ===== 全局状态 =====
const onlineUsers = new Map();
const chatHistory = [];
const userColors = {};
const colorPalette = ['#07c160', '#5765ec', '#fa5151', '#ff9c19', '#00ae9d', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1'];

// ===== 聊天历史持久化（debounce 500ms 写盘）=====
const CHAT_HISTORY_FILE = path.join(__dirname, 'data', 'chat-history.json');
let saveChatHistoryTimer = null;
function saveChatHistory() {
    if (saveChatHistoryTimer) clearTimeout(saveChatHistoryTimer);
    saveChatHistoryTimer = setTimeout(() => {
        try {
            fs.mkdirSync(path.dirname(CHAT_HISTORY_FILE), { recursive: true });
            fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chatHistory), 'utf8');
        } catch (e) {
            console.error('[保存聊天历史失败]', e.message);
        }
        saveChatHistoryTimer = null;
    }, 500);
}
function loadChatHistory() {
    try {
        if (!fs.existsSync(CHAT_HISTORY_FILE)) return;
        const raw = fs.readFileSync(CHAT_HISTORY_FILE, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            // 清理旧版本误存到群聊历史里的私聊通话记录（type=call 且无 peerName，或 target=private）
            const cleaned = arr.filter(m => {
                if (!m) return false;
                if (m.target === 'private') return false;
                // 旧版本没 target 字段但 type=call 的可能是私聊通话记录误发到群聊
                // 保留有明确 peerName 的群聊通话记录（这些是公用聊天室通话）
                return true;
            });
            chatHistory.length = 0;
            chatHistory.push(...cleaned);
            if (cleaned.length !== arr.length) {
                console.log(`[加载聊天历史] 清理 ${arr.length - cleaned.length} 条私聊消息`);
                saveChatHistory();
            }
            console.log(`[加载聊天历史] ${chatHistory.length} 条`);
        }
    } catch (e) {
        console.error('[加载聊天历史失败]', e.message);
    }
}

// ===== 用户头像系统状态（按 userName 索引，持久化）=====
// userAvatarsByName: Map<userName, { data: base64字符串, updatedAt, banned, banReason }>
const userAvatarsByName = new Map();
const MAX_AVATAR_SIZE = 2 * 1024 * 1024;  // 头像最大 2MB
const USER_AVATARS_FILE = path.join(__dirname, 'data', 'user-avatars.json');
let saveUserAvatarsTimer = null;
function saveUserAvatars() {
    if (saveUserAvatarsTimer) clearTimeout(saveUserAvatarsTimer);
    saveUserAvatarsTimer = setTimeout(() => {
        try {
            fs.mkdirSync(path.dirname(USER_AVATARS_FILE), { recursive: true });
            const obj = Object.fromEntries(userAvatarsByName.entries());
            fs.writeFileSync(USER_AVATARS_FILE, JSON.stringify(obj), 'utf8');
        } catch (e) {
            console.error('[保存用户头像失败]', e.message);
        }
        saveUserAvatarsTimer = null;
    }, 1000);
}
function loadUserAvatars() {
    try {
        if (!fs.existsSync(USER_AVATARS_FILE)) return;
        const raw = fs.readFileSync(USER_AVATARS_FILE, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
                userAvatarsByName.set(k, v);
            }
            console.log(`[加载用户头像] ${userAvatarsByName.size} 个`);
        }
    } catch (e) {
        console.error('[加载用户头像失败]', e.message);
    }
}

// ===== 在线用户按名称索引（用于断线去抖动识别快速重连）=====
const onlineUsersByName = new Map();  // userName -> socketId

// ===== 离开消息去抖动时间（毫秒）=====
const LEAVE_DEBOUNCE_MS = 3000;

// ===== 待处理通话邀请队列（按 userName 索引）=====
// 外网 socket 不稳定时，通话邀请通过 HTTP 轮询兜底送达
// pendingCallInvites: Map<userName, Array<{ from, fromName, callType, callId, roomId, timestamp }>>
const pendingCallInvites = new Map();

// ===== 好友系统数据（按 userName 索引，持久化）=====
// friendsByName: Map<userName, Set<peerUserName>>  双向好友关系（双方都存对方）
// friendRequestsByName: Map<toUserName, Array<{ from, fromName, avatar, message, timestamp }>>
// privateMessages: 按 "较小名|较大名" 作为 key 存储最近 50 条消息（避免双向重复）
const friendsByName = new Map();
const friendRequestsByName = new Map();
const privateMessages = new Map();
const MAX_PRIVATE_HISTORY = 50;  // 每对好友服务端只存最近 50 条
const FRIENDS_FILE = path.join(__dirname, 'data', 'friends.json');
const FRIEND_REQUESTS_FILE = path.join(__dirname, 'data', 'friend-requests.json');
const PRIVATE_MSGS_DIR = path.join(__dirname, 'data', 'private-messages');

function loadFriends() {
    try {
        if (!fs.existsSync(FRIENDS_FILE)) return;
        const raw = fs.readFileSync(FRIENDS_FILE, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
                friendsByName.set(k, new Set(v || []));
            }
            console.log(`[加载好友关系] ${friendsByName.size} 个用户`);
        }
    } catch (e) { console.error('[加载好友关系失败]', e.message); }
}
let saveFriendsTimer = null;
function saveFriends() {
    if (saveFriendsTimer) clearTimeout(saveFriendsTimer);
    saveFriendsTimer = setTimeout(() => {
        try {
            fs.mkdirSync(path.dirname(FRIENDS_FILE), { recursive: true });
            const obj = {};
            for (const [k, v] of friendsByName.entries()) obj[k] = Array.from(v);
            fs.writeFileSync(FRIENDS_FILE, JSON.stringify(obj), 'utf8');
        } catch (e) { console.error('[保存好友关系失败]', e.message); }
        saveFriendsTimer = null;
    }, 500);
}
function loadFriendRequests() {
    try {
        if (!fs.existsSync(FRIEND_REQUESTS_FILE)) return;
        const raw = fs.readFileSync(FRIEND_REQUESTS_FILE, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) friendRequestsByName.set(k, v || []);
            console.log(`[加载好友请求] ${friendRequestsByName.size} 个用户有待处理请求`);
        }
    } catch (e) { console.error('[加载好友请求失败]', e.message); }
}
let saveFriendRequestsTimer = null;
function saveFriendRequests() {
    if (saveFriendRequestsTimer) clearTimeout(saveFriendRequestsTimer);
    saveFriendRequestsTimer = setTimeout(() => {
        try {
            fs.mkdirSync(path.dirname(FRIEND_REQUESTS_FILE), { recursive: true });
            const obj = Object.fromEntries(friendRequestsByName.entries());
            fs.writeFileSync(FRIEND_REQUESTS_FILE, JSON.stringify(obj), 'utf8');
        } catch (e) { console.error('[保存好友请求失败]', e.message); }
        saveFriendRequestsTimer = null;
    }, 500);
}
// 私聊消息文件名：按字典序排列两个 userName，确保 A-B 和 B-A 落到同一文件
function getPrivateMsgKey(userA, userB) {
    return userA < userB ? `${userA}|${userB}` : `${userB}|${userA}`;
}
function loadPrivateMessages(userA, userB) {
    try {
        fs.mkdirSync(PRIVATE_MSGS_DIR, { recursive: true });
        const key = getPrivateMsgKey(userA, userB);
        const file = path.join(PRIVATE_MSGS_DIR, key.replace(/[|/\\:*?"<>]/g, '_') + '.json');
        if (!fs.existsSync(file)) return [];
        const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(arr) ? arr : [];
    } catch (e) { console.error('[加载私聊消息失败]', e.message); return []; }
}
let savePrivateTimers = {};
function savePrivateMessages(userA, userB, msgs) {
    const key = getPrivateMsgKey(userA, userB);
    if (savePrivateTimers[key]) clearTimeout(savePrivateTimers[key]);
    savePrivateTimers[key] = setTimeout(() => {
        try {
            fs.mkdirSync(PRIVATE_MSGS_DIR, { recursive: true });
            const file = path.join(PRIVATE_MSGS_DIR, key.replace(/[|/\\:*?"<>]/g, '_') + '.json');
            fs.writeFileSync(file, JSON.stringify(msgs), 'utf8');
        } catch (e) { console.error('[保存私聊消息失败]', e.message); }
        savePrivateTimers[key] = null;
    }, 500);
}
// 添加私聊消息到存储（去重 by id）
function addPrivateMessage(fromUser, toUser, msg) {
    const key = getPrivateMsgKey(fromUser, toUser);
    let msgs = privateMessages.get(key);
    if (!msgs) { msgs = loadPrivateMessages(fromUser, toUser); privateMessages.set(key, msgs); }
    if (!msgs.some(m => m.id === msg.id)) {
        msgs.push(msg);
        if (msgs.length > MAX_PRIVATE_HISTORY) msgs = msgs.slice(msgs.length - MAX_PRIVATE_HISTORY);
        privateMessages.set(key, msgs);
        savePrivateMessages(fromUser, toUser, msgs);
    }
}
function getPrivateMessages(userA, userB) {
    const key = getPrivateMsgKey(userA, userB);
    let msgs = privateMessages.get(key);
    if (!msgs) { msgs = loadPrivateMessages(userA, userB); privateMessages.set(key, msgs); }
    return msgs;
}
// 双向添加好友关系
function addFriendship(userA, userB) {
    if (!friendsByName.has(userA)) friendsByName.set(userA, new Set());
    if (!friendsByName.has(userB)) friendsByName.set(userB, new Set());
    friendsByName.get(userA).add(userB);
    friendsByName.get(userB).add(userA);
    saveFriends();
}
// 双向删除好友关系
function removeFriendship(userA, userB) {
    if (friendsByName.has(userA)) { friendsByName.get(userA).delete(userB); saveFriends(); }
    if (friendsByName.has(userB)) { friendsByName.get(userB).delete(userA); saveFriends(); }
}
// 判断是否好友
function areFriends(userA, userB) {
    return friendsByName.has(userA) && friendsByName.get(userA).has(userB);
}
// 检查 userName 是否在线（返回 socketId 或 null）
function getSocketIdByUserName(userName) {
    return onlineUsersByName.get(userName) || null;
}
// 通知某用户的所有好友其在线状态变化（上线/下线）
function notifyFriendsStatusChange(userName, online) {
    const friends = friendsByName.get(userName);
    if (!friends || friends.size === 0) return;
    for (const friendName of friends) {
        const sid = getSocketIdByUserName(friendName);
        if (sid) {
            io.to(sid).emit('friend-status-change', { friendName: userName, online });
        }
    }
}

// ===== 管理员管理状态 =====
// bannedUsersByName: Map<userName, { reason, bannedAt, bannedFromChat, bannedFromMeeting, bannedBy }>
// 按 userName 索引，避免用户刷新（socketId 变化）就解除禁言
const bannedUsersByName = new Map();
const BANNED_USERS_FILE = path.join(__dirname, 'data', 'banned-users.json');
function loadBannedUsers() {
    try {
        if (!fs.existsSync(BANNED_USERS_FILE)) return;
        const raw = fs.readFileSync(BANNED_USERS_FILE, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
                bannedUsersByName.set(k, v);
            }
            console.log(`[加载封禁用户] ${bannedUsersByName.size} 个`);
        }
    } catch (e) {
        console.error('[加载封禁用户失败]', e.message);
    }
}
function saveBannedUsers() {
    try {
        fs.mkdirSync(path.dirname(BANNED_USERS_FILE), { recursive: true });
        const obj = Object.fromEntries(bannedUsersByName.entries());
        fs.writeFileSync(BANNED_USERS_FILE, JSON.stringify(obj), 'utf8');
    } catch (e) {
        console.error('[保存封禁用户失败]', e.message);
    }
}

// hiddenMessages: Map<msgId, { hiddenAt, hiddenBy }>
const hiddenMessages = new Set();
const HIDDEN_MESSAGES_FILE = path.join(__dirname, 'data', 'hidden-messages.json');
function loadHiddenMessages() {
    try {
        if (!fs.existsSync(HIDDEN_MESSAGES_FILE)) return;
        const raw = fs.readFileSync(HIDDEN_MESSAGES_FILE, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            for (const id of arr) hiddenMessages.add(id);
            console.log(`[加载隐藏消息] ${hiddenMessages.size} 条`);
        }
    } catch (e) {
        console.error('[加载隐藏消息失败]', e.message);
    }
}
function saveHiddenMessages() {
    try {
        fs.mkdirSync(path.dirname(HIDDEN_MESSAGES_FILE), { recursive: true });
        fs.writeFileSync(HIDDEN_MESSAGES_FILE, JSON.stringify(Array.from(hiddenMessages)), 'utf8');
    } catch (e) {
        console.error('[保存隐藏消息失败]', e.message);
    }
}
// 违禁词列表
let bannedWords = ['傻逼', '操你', '草泥马', 'fuck', 'shit', '废物', '去死'];
// 所有用户历史（用于管理员查看，即使离线也保留）
// 注意：以 name 作为 key，避免同一用户每次重连（socketId 变化）产生重复条目
const allUsersHistory = new Map();  // name -> { socketId, name, firstSeen, lastSeen }

// 读取 HTTPS 证书
const certDir = path.join(__dirname, 'cert');
const tlsOptions = {
    key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    requestCert: false,
    rejectUnauthorized: false,
    ALPNProtocols: ['http/1.1']
};
console.log('已加载 HTTPS 证书（强制 TLS 1.2）');

// ===== Socket.IO 服务器（稳定性配置）=====
// 采用 polling 优先 + 允许升级：内网可升级到 websocket（实时），外网自签名证书 wss 升级失败则保持 polling
// 这样既保证内网实时性，又保证外网可用性。HTTP 兜底接口保证消息不丢
const io = require('socket.io')({
    pingTimeout: 60000,   // 心跳超时：60秒（温和值，避免 WebView 频繁断连）
    pingInterval: 25000, // 心跳间隔：25秒（默认值，不要太频繁）
    upgradeTimeout: 30000,
    maxHttpBufferSize: 1e8,
    transports: ['polling', 'websocket'],  // polling 优先，可升级
    cookie: false,
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = new Map();
// ===== 原生 WebRTC 房间（替代 PeerJS）=====
// webrtcRooms: roomId -> Map<socketId, { socketId, name, isGhost }>
const webrtcRooms = new Map();

const generateUserName = () => {
    const adjectives = ['快乐的', '勇敢的', '聪明的', '友善的', '可爱的', '神秘的'];
    const nouns = ['小猫', '小狗', '熊猫', '老虎', '小鹿', '海豚', '蝴蝶', '凤凰'];
    return adjectives[Math.floor(Math.random() * adjectives.length)] + nouns[Math.floor(Math.random() * nouns.length)];
};

const getUserColor = (socketId) => {
    // 按 socketId 兼容旧调用，但优先用 userName 索引（避免刷新后颜色变化）
    const user = onlineUsers.get(socketId);
    const key = (user && user.name) ? user.name : socketId;
    if (!userColors[key]) {
        userColors[key] = colorPalette[Object.keys(userColors).length % colorPalette.length];
    }
    return userColors[key];
};

// 按 userName 获取颜色（HTTP 兜底发送消息时使用，因为 HTTP 没有 socket.id）
const getUserColorByName = (userName) => {
    if (!userColors[userName]) {
        userColors[userName] = colorPalette[Object.keys(userColors).length % colorPalette.length];
    }
    return userColors[userName];
};

// ===== 检查违禁词 =====
function containsBannedWord(content) {
    if (!content || typeof content !== 'string') return false;
    const lower = content.toLowerCase();
    for (const word of bannedWords) {
        if (lower.includes(word.toLowerCase())) return word;
    }
    return false;
}

// ===== 添加聊天消息到历史记录 =====
function addChatMessage(msg) {
    chatHistory.push(msg);
    if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();
    saveChatHistory();
}

// ===== 广播成员列表更新 =====
function broadcastMembersUpdate(room, roomID) {
    const visibleMembers = Array.from(room.members.entries())
        .filter(([sid, m]) => !m.isGhost)
        .map(([sid, m]) => ({ socketId: sid, name: m.name, isHost: m.isHost, isNative: m.isNative, peerUserId: m.peerUserId }));
    io.to(roomID).emit("members-update", { members: visibleMembers, memberCount: visibleMembers.length });
}

// ===== 获取指定 socketId 的头像（通过 onlineUsers 反查 name，再查 userAvatarsByName）=====
function getAvatarBySocketId(socketId) {
    const user = onlineUsers.get(socketId);
    if (!user || !user.name) return null;
    const av = userAvatarsByName.get(user.name);
    return av && av.data ? av.data : null;
}

// ===== 构造完整在线成员列表（含头像）=====
function buildOnlineMembersList() {
    return Array.from(onlineUsers.entries()).map(([sid, u]) => ({
        socketId: sid,
        name: u.name,
        color: getUserColor(sid),
        joinedAt: u.joinedAt,
        avatar: getAvatarBySocketId(sid)
    }));
}

// ===== 广播 online-members-update 事件给所有人 =====
function broadcastOnlineMembersUpdate() {
    const users = buildOnlineMembersList();
    io.emit('online-members-update', { users, count: users.length });
}

const main = async () => {
    // ===== 启动时加载数据（确保 data 目录存在）=====
    try {
        fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    } catch (e) {
        console.error('[创建 data 目录失败]', e.message);
    }
    loadChatHistory();
    loadBannedUsers();
    loadUserAvatars();
    loadHiddenMessages();
    loadFriends();
    loadFriendRequests();

    app.set('view engine', 'ejs');
    app.use(express.static('public'));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use(express.json({ limit: '50mb' }));

    // ===== 管理员 Cookie 解析中间件 =====
    app.use((req, res, next) => {
        req.adminAuthed = false;
        const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
        for (const c of cookies) {
            const [k, v] = c.split('=');
            if (k === ADMIN_COOKIE_NAME && v && adminSessions.has(v)) {
                req.adminAuthed = true;
                break;
            }
        }
        next();
    });

    app.get("/", (req, res) => res.render('home'));
    app.get("/create", (req, res) => res.redirect(`/room/${String(Math.floor(100000 + Math.random() * 900000))}`));
    app.get("/room/:room", (req, res) => res.render('room', { roomId: req.params.room }));

    // ===== 聊天 API：获取历史消息（支持增量同步：after 参数返回此时间之后的消息）=====
    app.get("/api/chat/history", (req, res) => {
        const before = parseInt(req.query.before) || Date.now();
        const limit = parseInt(req.query.limit) || 50;
        const after = parseInt(req.query.after) || 0;  // 增量同步：返回此时间戳之后的消息
        let msgs = chatHistory.filter(m => m.timestamp < before);
        if (after > 0) msgs = msgs.filter(m => m.timestamp > after);
        const result = msgs.slice(-limit).map(m => {
            if (m.avatar) { const { avatar, ...rest } = m; return rest; }
            return m;
        });
        res.json({ messages: result, total: chatHistory.length, serverTime: Date.now() });
    });

    // ===== 聊天 API：HTTP 兜底发送消息（当 Socket.IO 断连时使用）=====
    // 复用与 socket.on('chat-send-message') 相同的处理逻辑
    app.post("/api/chat/send", (req, res) => {
        const { type, content, duration, userName, userId, callType, peerName, callDuration, quote, target } = req.body || {};
        if (!userName) return res.status(400).json({ error: '缺少 userName' });
        if (content === undefined || content === null) return res.status(400).json({ error: '缺少 content' });
        // 防御：群聊通道不接收 target=private 的消息
        if (target === 'private') {
            console.log(`[群聊过滤] 拒绝私聊消息进入 HTTP 群聊通道: ${userName} ${type || 'text'}`);
            return res.status(400).json({ error: '私聊消息不应走群聊通道' });
        }

        // 检查是否被禁言（按 userName 索引）
        const banInfo = bannedUsersByName.get(userName);
        if (banInfo && banInfo.bannedFromChat) {
            return res.status(403).json({ error: `你已被禁言：${banInfo.reason}` });
        }

        // 仅文本消息检查违禁词
        const msgType = type || 'text';
        if (msgType === 'text') {
            const bannedWord = containsBannedWord(content);
            if (bannedWord) {
                return res.status(403).json({ error: `消息包含违禁词"${bannedWord}"，无法发送` });
            }
        }

        // 视频消息大小检查
        if (msgType === 'video' && content && content.length > 40 * 1024 * 1024) {
            return res.status(413).json({ error: '视频太大（超过 30MB）' });
        }

        // 生成消息（HTTP 兜底场景下没有 socket.id，用 userName 作为识别）
        const msg = {
            id: crypto.randomUUID(),
            type: msgType,
            name: userName,
            senderName: userName,
            userId: userId || null,
            content: content,
            socketId: 'http-fallback',  // 标记为 HTTP 兜底发送
            color: getUserColorByName(userName),
            timestamp: Date.now(),
            target: 'group'  // 目标：group=群聊（默认），private=私聊
        };
        if (msgType === 'voice' && duration) msg.duration = duration;
        if (msgType === 'call') {
            msg.callType = callType || 'voice';
            msg.peerName = peerName || '';
            msg.callDuration = parseInt(callDuration) || 0;
        }
        if (quote && quote.content) {
            msg.quote = {
                id: quote.id || '',
                name: quote.name || '',
                content: String(quote.content).slice(0, 200)
            };
        }
        addChatMessage(msg);
        io.emit('chat-message', msg);  // 广播给所有在线 socket 客户端

        console.log(`[HTTP兜底消息] ${userName}: ${msgType === 'image' ? '[图片]' : msgType === 'video' ? '[视频]' : msgType === 'voice' ? '[语音]' : msgType === 'call' ? '[通话记录]' : String(content).substring(0, 50)}`);
        res.json({ success: true, msgId: msg.id, msg });
    });

    // ===== 聊天 API：HTTP 获取在线用户列表（通话前兜底，当 socket 事件丢失时使用）=====
    app.get("/api/chat/online-users", (req, res) => {
        const users = Array.from(onlineUsers.entries()).map(([sid, u]) => ({
            socketId: sid,
            name: u.name,
            color: getUserColor(sid),
            joinedAt: u.joinedAt,
            avatar: userAvatarsByName.get(u.name)?.data || null
        }));
        res.json({ users, count: users.length, serverTime: Date.now() });
    });

    // ===== 通话 API：HTTP 兜底发起通话邀请（socket 断连时使用）=====
    app.post("/api/call/invite", (req, res) => {
        const { toUserName, fromUserName, fromUserId, callType, callId, roomId, isPrivateCall } = req.body || {};
        if (!toUserName || !fromUserName || !callId) {
            return res.status(400).json({ error: '缺少 toUserName/fromUserName/callId' });
        }
        // 查找目标用户的 socketId（外网重连后 socketId 会变，所以按 userName 查找）
        const targetSocketId = onlineUsersByName.get(toUserName);
        const inviteData = {
            from: targetSocketId || 'http-fallback',
            fromName: fromUserName,
            callType: callType || 'video',
            callId,
            roomId: roomId || null,
            isPrivateCall: !!isPrivateCall,  // 透传私聊通话标记
            timestamp: Date.now()
        };
        // 存入待处理邀请队列（按被叫 userName 索引）
        if (!pendingCallInvites.has(toUserName)) {
            pendingCallInvites.set(toUserName, []);
        }
        const invites = pendingCallInvites.get(toUserName);
        if (!invites.some(i => i.callId === callId)) {
            invites.push(inviteData);
        }
        // 尝试 socket 推送（如果目标用户在线）
        if (targetSocketId) {
            io.to(targetSocketId).emit('call-incoming', inviteData);
            console.log(`[HTTP通话邀请] ${fromUserName} -> ${toUserName} (${targetSocketId}), callId=${callId}`);
        } else {
            console.log(`[HTTP通话邀请] ${fromUserName} -> ${toUserName} (离线，仅存队列), callId=${callId}`);
        }
        res.json({ success: true, callId, targetOnline: !!targetSocketId });
    });

    // ===== 通话 API：HTTP 获取待处理来电（客户端轮询查询）=====
    app.get("/api/call/pending", (req, res) => {
        const userName = req.query.userName;
        if (!userName) return res.status(400).json({ error: '缺少 userName' });
        const invites = pendingCallInvites.get(userName) || [];
        // 清理超过 60 秒的旧邀请
        const now = Date.now();
        const valid = invites.filter(i => (now - i.timestamp) < 60000);
        if (valid.length !== invites.length) {
            pendingCallInvites.set(userName, valid);
        }
        res.json({ invites: valid, serverTime: now });
    });

    // ===== 通话 API：HTTP 兜底接受/拒绝通话（socket 断连时使用）=====
    app.post("/api/call/respond", (req, res) => {
        const { callId, toUserName, fromUserName, action } = req.body || {};
        // action: 'accept' 或 'reject'
        if (!callId || !toUserName || !action) {
            return res.status(400).json({ error: '缺少 callId/toUserName/action' });
        }
        // 清理被叫方的待处理邀请
        if (pendingCallInvites.has(fromUserName)) {
            const invites = pendingCallInvites.get(fromUserName);
            pendingCallInvites.set(fromUserName, invites.filter(i => i.callId !== callId));
        }
        // 查找主叫方 socketId 并推送
        const callerSocketId = onlineUsersByName.get(toUserName);
        if (callerSocketId) {
            if (action === 'accept') {
                io.to(callerSocketId).emit('call-accepted', { callId, from: callerSocketId });
                console.log(`[HTTP通话接受] callId=${callId}, ${fromUserName} -> ${toUserName}`);
            } else {
                io.to(callerSocketId).emit('call-rejected', { callId, reason: '被叫拒绝' });
                console.log(`[HTTP通话拒绝] callId=${callId}, ${fromUserName} -> ${toUserName}`);
            }
        } else {
            console.log(`[HTTP通话${action === 'accept' ? '接受' : '拒绝'}] 主叫 ${toUserName} 已离线, callId=${callId}`);
        }
        res.json({ success: true });
    });

    // ===== 通话 API：HTTP 兜底取消呼叫（主叫方 socket 断连时使用）=====
    app.post("/api/call/cancel", (req, res) => {
        const { callId, toUserName } = req.body || {};
        if (!callId || !toUserName) return res.status(400).json({ error: '缺少 callId/toUserName' });
        // 清理被叫方的待处理邀请
        if (pendingCallInvites.has(toUserName)) {
            const invites = pendingCallInvites.get(toUserName);
            pendingCallInvites.set(toUserName, invites.filter(i => i.callId !== callId));
        }
        // 推送取消通知
        const targetSocketId = onlineUsersByName.get(toUserName);
        if (targetSocketId) {
            io.to(targetSocketId).emit('call-cancelled', { callId });
        }
        console.log(`[HTTP通话取消] callId=${callId} -> ${toUserName}`);
        res.json({ success: true });
    });

    // ===== 好友系统 API =====
    // 搜索用户（按名称模糊匹配，排除自己）
    app.get("/api/friends/search", (req, res) => {
        const q = (req.query.q || '').trim();
        const myName = (req.query.myName || '').trim();
        if (!q) return res.json({ users: [] });
        // 从所有曾经注册过的用户中搜索（持久化的优先：userAvatarsByName + friendsByName + friendRequestsByName，
        // 再加内存中的 onlineUsersByName + allUsersHistory）
        const results = new Map();
        // 1. 在线用户
        for (const [name, sid] of onlineUsersByName.entries()) {
            if (name !== myName && name.includes(q)) {
                results.set(name, { name, online: true });
            }
        }
        // 2. 历史用户（内存，重启后丢失）
        for (const hist of allUsersHistory.values()) {
            if (hist.name && hist.name !== myName && hist.name.includes(q)) {
                results.set(hist.name, { name: hist.name, online: onlineUsersByName.has(hist.name) });
            }
        }
        // 3. 持久化的用户头像表（重启不丢，覆盖所有曾设置过头像的用户）
        for (const name of userAvatarsByName.keys()) {
            if (name !== myName && name.includes(q)) {
                if (!results.has(name)) results.set(name, { name, online: onlineUsersByName.has(name) });
            }
        }
        // 4. 持久化的好友关系表（覆盖所有有好友关系的用户）
        for (const name of friendsByName.keys()) {
            if (name !== myName && name.includes(q)) {
                if (!results.has(name)) results.set(name, { name, online: onlineUsersByName.has(name) });
            }
        }
        // 5. 持久化的好友请求表（覆盖所有发过/收过请求的用户）
        for (const [toName, reqs] of friendRequestsByName.entries()) {
            if (toName !== myName && toName.includes(q)) {
                if (!results.has(toName)) results.set(toName, { name: toName, online: onlineUsersByName.has(toName) });
            }
            for (const r of reqs) {
                if (r.from && r.from !== myName && r.from.includes(q)) {
                    if (!results.has(r.from)) results.set(r.from, { name: r.from, online: onlineUsersByName.has(r.from) });
                }
            }
        }
        // 附加头像、是否已是好友、是否有待处理请求
        const users = Array.from(results.values()).slice(0, 20).map(u => {
            const av = userAvatarsByName.get(u.name);
            return {
                name: u.name,
                online: u.online,
                avatar: av ? av.data : null,
                isFriend: areFriends(myName, u.name)
            };
        });
        res.json({ users });
    });

    // 发送好友请求
    app.post("/api/friends/request", (req, res) => {
        const { from, to, message } = req.body || {};
        if (!from || !to) return res.status(400).json({ error: '缺少 from/to' });
        if (from === to) return res.status(400).json({ error: '不能添加自己为好友' });
        // 已是好友
        if (areFriends(from, to)) return res.json({ success: true, alreadyFriend: true });
        // 已有待处理请求
        const reqs = friendRequestsByName.get(to) || [];
        if (reqs.some(r => r.from === from)) return res.json({ success: true, pending: true });
        const fromAvatar = userAvatarsByName.get(from);
        const reqData = {
            from, fromName: from,
            avatar: fromAvatar ? fromAvatar.data : null,
            message: message || `我是 ${from}，想加你为好友`,
            timestamp: Date.now()
        };
        if (!friendRequestsByName.has(to)) friendRequestsByName.set(to, []);
        friendRequestsByName.get(to).push(reqData);
        saveFriendRequests();
        // 实时推送（在线时）
        const toSid = getSocketIdByUserName(to);
        if (toSid) io.to(toSid).emit('friend-request-incoming', reqData);
        console.log(`[好友请求] ${from} -> ${to}`);
        res.json({ success: true });
    });

    // 获取待处理好友请求列表
    app.get("/api/friends/requests", (req, res) => {
        const userName = req.query.userName;
        if (!userName) return res.json({ requests: [] });
        const reqs = friendRequestsByName.get(userName) || [];
        // 附加发送方在线状态
        const result = reqs.map(r => ({ ...r, fromOnline: onlineUsersByName.has(r.from) }));
        res.json({ requests: result });
    });

    // 接受好友请求
    app.post("/api/friends/accept", (req, res) => {
        const { from, to } = req.body || {};  // from=请求发起方, to=接受方（当前用户）
        if (!from || !to) return res.status(400).json({ error: '缺少 from/to' });
        // 移除请求
        if (friendRequestsByName.has(to)) {
            const arr = friendRequestsByName.get(to).filter(r => r.from !== from);
            friendRequestsByName.set(to, arr);
            saveFriendRequests();
        }
        // 建立双向好友关系
        addFriendship(from, to);
        // 通知发起方（在线时）
        const fromSid = getSocketIdByUserName(from);
        if (fromSid) {
            io.to(fromSid).emit('friend-request-accepted', { from: to, friendName: to });
        }
        console.log(`[好友请求接受] ${from} <-> ${to}`);
        res.json({ success: true });
    });

    // 拒绝好友请求
    app.post("/api/friends/reject", (req, res) => {
        const { from, to } = req.body || {};
        if (friendRequestsByName.has(to)) {
            const arr = friendRequestsByName.get(to).filter(r => r.from !== from);
            friendRequestsByName.set(to, arr);
            saveFriendRequests();
        }
        console.log(`[好友请求拒绝] ${from} -> ${to}`);
        res.json({ success: true });
    });

    // 获取好友列表（含在线状态、头像、最后一条消息）
    app.get("/api/friends/list", (req, res) => {
        const userName = req.query.userName;
        if (!userName) return res.json({ friends: [] });
        const set = friendsByName.get(userName);
        if (!set || set.size === 0) return res.json({ friends: [] });
        const friends = Array.from(set).map(name => {
            const av = userAvatarsByName.get(name);
            const msgs = getPrivateMessages(userName, name);
            const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
            return {
                name,
                online: onlineUsersByName.has(name),
                avatar: av ? av.data : null,
                lastMessage: lastMsg ? {
                    content: lastMsg.type === 'image' ? '[图片]'
                        : lastMsg.type === 'voice' ? '[语音]'
                        : lastMsg.type === 'video' ? '[视频]'
                        : lastMsg.type === 'call' ? (
                            lastMsg.callOutcome === 'rejected' ? '[通话被拒绝]'
                            : lastMsg.callOutcome === 'cancelled' ? '[通话已取消]'
                            : '[通话记录]'
                        )
                        : (lastMsg.content || ''),
                    timestamp: lastMsg.timestamp,
                    sender: lastMsg.sender
                } : null
            };
        }).sort((a, b) => {
            // 在线优先，然后按最后消息时间倒序
            if (a.online !== b.online) return a.online ? -1 : 1;
            const ta = a.lastMessage ? a.lastMessage.timestamp : 0;
            const tb = b.lastMessage ? b.lastMessage.timestamp : 0;
            return tb - ta;
        });
        res.json({ friends });
    });

    // 删除好友
    app.delete("/api/friends/delete", (req, res) => {
        const { from, to } = req.query;  // from=当前用户, to=要删的好友
        if (!from || !to) return res.status(400).json({ error: '缺少 from/to' });
        removeFriendship(from, to);
        // 通知对方（在线时）
        const toSid = getSocketIdByUserName(to);
        if (toSid) io.to(toSid).emit('friend-removed', { by: from });
        console.log(`[删除好友] ${from} -x- ${to}`);
        res.json({ success: true });
    });

    // 发送私聊消息
    app.post("/api/friends/message", (req, res) => {
        const { from, to, type, content, duration, id, timestamp, callType, callOutcome } = req.body || {};
        if (!from || !to || !content) return res.status(400).json({ error: '缺少参数' });
        // 必须是好友
        if (!areFriends(from, to)) return res.status(403).json({ error: '不是好友，无法发送消息' });
        // 使用客户端传来的 id（避免服务端重新生成导致接收方去重失败，出现重复消息）
        const msg = {
            id: id || crypto.randomUUID(),
            type: type || 'text',
            sender: from,
            content,
            duration: duration || 0,
            timestamp: timestamp || Date.now()
        };
        // 通话记录消息：保存通话类型和通话结果（peerName 不存，由前端按私聊上下文渲染，避免双方视角冲突）
        if (type === 'call') {
            msg.callType = callType || 'voice';
            if (callOutcome) msg.callOutcome = callOutcome;  // 透传通话结果：completed/rejected/cancelled
        }
        addPrivateMessage(from, to, msg);
        // 实时推送给接收方（在线时）
        const toSid = getSocketIdByUserName(to);
        if (toSid) {
            io.to(toSid).emit('private-message', { ...msg, from });
            // 顺便把发送方的头像附带给接收方（避免接收方没有发送方头像）
        }
        console.log(`[私聊消息] ${from} -> ${to}: ${type === 'image' ? '[图片]' : type === 'voice' ? '[语音]' : type === 'video' ? '[视频]' : type === 'call' ? '[通话记录 ' + (msg.callType || 'voice') + ' ' + (duration || 0) + 's]' : String(content).substring(0, 30)}`);
        res.json({ success: true, msg });
    });

    // 获取私聊历史消息
    app.get("/api/friends/messages", (req, res) => {
        const { userName, peerName } = req.query;
        if (!userName || !peerName) return res.json({ messages: [] });
        if (!areFriends(userName, peerName)) return res.status(403).json({ error: '不是好友' });
        const msgs = getPrivateMessages(userName, peerName);
        res.json({ messages: msgs });
    });

    // ===== 管理员查询好友关系和私聊记录 =====
    app.get("/api/admin/friends", (req, res) => {
        const cookie = req.headers.cookie || '';
        if (!cookie.includes(ADMIN_COOKIE_NAME + '=')) return res.status(401).json({ error: '未授权' });
        // 返回所有好友关系
        const result = [];
        for (const [userName, friends] of friendsByName.entries()) {
            result.push({ userName, friends: Array.from(friends) });
        }
        res.json({ friends: result });
    });
    app.get("/api/admin/private-messages", (req, res) => {
        const cookie = req.headers.cookie || '';
        if (!cookie.includes(ADMIN_COOKIE_NAME + '=')) return res.status(401).json({ error: '未授权' });
        const { userA, userB } = req.query;
        if (!userA || !userB) return res.json({ messages: [] });
        // 管理员直接读取，不校验是否好友
        const msgs = getPrivateMessages(userA, userB);
        res.json({ messages: msgs });
    });
    // 列出所有私聊会话文件（供管理员选择查看）
    app.get("/api/admin/private-conversations", (req, res) => {
        const cookie = req.headers.cookie || '';
        if (!cookie.includes(ADMIN_COOKIE_NAME + '=')) return res.status(401).json({ error: '未授权' });
        try {
            fs.mkdirSync(PRIVATE_MSGS_DIR, { recursive: true });
            const files = fs.readdirSync(PRIVATE_MSGS_DIR).filter(f => f.endsWith('.json'));
            const conversations = files.map(f => {
                // 文件名格式 "userA_userB.json"（| 被替换为 _）
                const pair = f.replace(/\.json$/, '').split('_');
                let userA = pair[0] || '';
                let userB = pair.length > 1 ? pair.slice(1).join('_') : '';
                let count = 0;
                let lastTime = null;
                try {
                    const arr = JSON.parse(fs.readFileSync(path.join(PRIVATE_MSGS_DIR, f), 'utf8'));
                    if (Array.isArray(arr) && arr.length > 0) {
                        count = arr.length;
                        // 优先从消息内容读取真实发送者（避免文件名解析错误）
                        // 存储的字段是 sender 或 from；接收方为会话另一方
                        const sender = arr[0].sender || arr[0].from;
                        if (sender) {
                            // 文件名 key 为 "较小名|较大名"，| 已被替换为 _
                            // 通过比较确定接收方
                            const allNames = new Set();
                            for (const m of arr) {
                                if (m.sender) allNames.add(m.sender);
                                if (m.from) allNames.add(m.from);
                            }
                            const names = Array.from(allNames);
                            if (names.length >= 2) {
                                userA = names[0];
                                userB = names[1];
                            } else if (names.length === 1) {
                                userA = names[0];
                                // 接收方从文件名另一段推断
                                const fileNamePair = f.replace(/\.json$/, '').split('_');
                                userB = fileNamePair.find(p => p !== userA) || fileNamePair[fileNamePair.length - 1];
                            }
                        }
                        const last = arr[arr.length - 1];
                        if (last && last.timestamp) lastTime = last.timestamp;
                    }
                } catch (e) {}
                return { userA, userB, count, lastTime, fileName: f };
            }).filter(c => c.count > 0);  // 仅列出有消息的会话
            res.json({ conversations });
        } catch (e) {
            res.json({ conversations: [] });
        }
    });

    // ===== 视频/图片上传 API（避免 Socket.IO 传输大 base64 和 data URL 渲染限制）=====
    const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    // 支持的视频格式 -> 扩展名映射
    const videoExtMap = { 'mp4': 'mp4', 'webm': 'webm', '3gpp': '3gp', 'quicktime': 'mov', 'x-matroska': 'mkv' };

    app.post('/api/chat/upload-video', (req, res) => {
        const { data, name } = req.body || {};
        if (!data) return res.status(400).json({ error: '缺少视频数据' });

        // 解析 data URL：data:video/mp4;base64,xxxx
        const matches = data.match(/^data:video\/([\w.-]+);base64,(.+)$/);
        if (!matches) return res.status(400).json({ error: '视频格式错误' });

        const mimeSub = matches[1].toLowerCase();
        const ext = videoExtMap[mimeSub] || 'mp4';
        const base64Data = matches[2];
        let buffer;
        try {
            buffer = Buffer.from(base64Data, 'base64');
        } catch (e) {
            return res.status(400).json({ error: 'base64 解码失败' });
        }

        // 检查大小（30MB 原始文件）
        if (buffer.length > 30 * 1024 * 1024) {
            return res.status(400).json({ error: '视频超过 30MB 限制' });
        }

        const filename = `video-${Date.now()}-${crypto.randomUUID()}.${ext}`;
        const filepath = path.join(UPLOADS_DIR, filename);

        fs.writeFile(filepath, buffer, (err) => {
            if (err) {
                console.error('[视频上传失败]', err.message);
                return res.status(500).json({ error: '保存失败' });
            }
            const url = `/uploads/${filename}`;
            console.log(`[视频上传成功] ${filename} (${Math.round(buffer.length / 1024)}KB)`);
            res.json({ url, size: buffer.length });
        });
    });

    // ===== 聊天 API：获取在线用户列表 =====
    app.get("/api/chat/online", (req, res) => {
        const users = Array.from(onlineUsers.entries()).map(([sid, u]) => ({
            socketId: sid, name: u.name, color: getUserColor(sid), joinedAt: u.joinedAt
        }));
        res.json({ users, count: users.length });
    });

    // ===== 聊天 API：修改名称 =====
    app.post("/api/chat/rename", (req, res) => {
        const { newName, socketId } = req.body || {};
        const targetSocketId = socketId;
        const user = onlineUsers.get(targetSocketId);
        if (!user) return res.status(404).json({ error: '用户不在线' });
        const now = Date.now();
        if (user.nameLockedUntil && now < user.nameLockedUntil) {
            const remaining = Math.ceil((user.nameLockedUntil - now) / 1000);
            return res.status(403).json({ error: `名称修改后 5 分钟内不能再次修改，请等待 ${remaining} 秒`, remaining });
        }
        const oldName = user.name;
        user.name = newName;
        user.nameLockedUntil = now + NAME_LOCK_DURATION;
        user.lastRenameAt = now;
        io.emit('chat-user-renamed', { socketId: targetSocketId, oldName, newName });
        // 维护按名称索引（删除旧名称，添加新名称）
        onlineUsersByName.delete(oldName);
        onlineUsersByName.set(newName, targetSocketId);
        // 同步迁移历史记录（按 name 索引，key 从 oldName 改为 newName，保留 firstSeen）
        if (allUsersHistory.has(oldName)) {
            const hist = allUsersHistory.get(oldName);
            allUsersHistory.delete(oldName);
            hist.name = newName;
            hist.lastSeen = now;
            allUsersHistory.set(newName, hist);
        } else {
            allUsersHistory.set(newName, {
                socketId: targetSocketId, name: newName, firstSeen: now, lastSeen: now
            });
        }
        if (user.roomID) {
            const room = rooms.get(user.roomID);
            if (room) {
                const member = room.members.get(targetSocketId);
                if (member) member.name = newName;
                broadcastMembersUpdate(room, user.roomID);
            }
        }
        res.json({ success: true, oldName, newName, nameLockedUntil: user.nameLockedUntil });
    });

    // ===== 用户 API：获取某用户的头像 =====
    app.get("/api/user/avatar/:socketId", (req, res) => {
        const { socketId } = req.params;
        // 通过 onlineUsers 反查 name，再查 userAvatarsByName
        const onlineUser = onlineUsers.get(socketId);
        let av = null;
        if (onlineUser && onlineUser.name) {
            av = userAvatarsByName.get(onlineUser.name);
        } else {
            // 离线用户：遍历 allUsersHistory 找 name
            for (const hist of allUsersHistory.values()) {
                if (hist.socketId === socketId) {
                    av = userAvatarsByName.get(hist.name);
                    break;
                }
            }
        }
        res.json({
            avatar: av && av.data ? av.data : null,
            banned: !!(av && av.banned)
        });
    });

    // ===== 按 userName 获取头像（不受 socketId 重连变化影响，外网稳定）=====
    app.get("/api/user/avatar-by-name/:userName", (req, res) => {
        const { userName } = req.params;
        if (!userName) return res.json({ avatar: null, banned: false });
        const av = userAvatarsByName.get(userName);
        res.json({
            avatar: av && av.data ? av.data : null,
            banned: !!(av && av.banned)
        });
    });

    // ===== 用户 API：获取某用户的主页信息 =====
    app.get("/api/user/profile/:socketId", (req, res) => {
        const { socketId } = req.params;
        const onlineUser = onlineUsers.get(socketId);
        // allUsersHistory 现按 name 索引，通过在线用户的 name 反查；离线用户用 socketId 反查需要遍历
        const histName = onlineUser?.name || null;
        const historyUser = histName ? allUsersHistory.get(histName) : null;
        // 通过 name 查头像（userAvatarsByName）
        const nameForAvatar = histName || historyUser?.name;
        const av = nameForAvatar ? userAvatarsByName.get(nameForAvatar) : null;
        res.json({
            name: onlineUser?.name || historyUser?.name || '未知用户',
            avatar: av && av.data ? av.data : null,
            avatarBanned: !!(av && av.banned),
            online: !!onlineUser,
            joinedAt: onlineUser?.joinedAt || historyUser?.firstSeen || 0,
            lastSeen: onlineUser ? Date.now() : (historyUser?.lastSeen || 0)
        });
    });

    // ===== 应用版本检查系统 =====
    const APP_VERSION_FILE = path.join(__dirname, 'data', 'app-version.json');
    const APP_APK_DIR = path.join(__dirname, 'public', 'downloads');
    fs.mkdirSync(APP_APK_DIR, { recursive: true });

    function loadAppVersion() {
        try {
            if (!fs.existsSync(APP_VERSION_FILE)) return null;
            return JSON.parse(fs.readFileSync(APP_VERSION_FILE, 'utf8'));
        } catch (e) {
            console.error('[加载版本信息失败]', e.message);
            return null;
        }
    }
    function saveAppVersion(info) {
        try {
            fs.mkdirSync(path.dirname(APP_VERSION_FILE), { recursive: true });
            fs.writeFileSync(APP_VERSION_FILE, JSON.stringify(info, null, 2), 'utf8');
        } catch (e) {
            console.error('[保存版本信息失败]', e.message);
        }
    }

    // 客户端检查更新 API
    app.get('/api/app/check-update', (req, res) => {
        const info = loadAppVersion();
        if (!info) return res.json({ hasUpdate: false });
        res.json({
            hasUpdate: true,
            versionCode: info.versionCode,
            versionName: info.versionName,
            updateContent: info.updateContent,
            apkUrl: info.apkUrl,
            publishedAt: info.publishedAt
        });
    });

    // 语音转文字 API（占位：未配置第三方 ASR 服务时返回明确提示）
    app.post('/api/chat/transcribe', (req, res) => {
        const { audioData } = req.body || {};
        if (!audioData) return res.status(400).json({ success: false, error: '缺少语音数据' });
        // 当前服务端未集成第三方语音识别服务（如阿里云/百度/Whisper）
        // 返回明确提示而非"未能识别"，避免用户误以为是 bug
        res.json({
            success: false,
            error: '服务端未配置语音识别服务，请在浏览器（Chrome）中打开网页版使用转文字功能'
        });
    });

    // ===== 管理员 API：重置某用户头像（删除）=====
    app.post("/api/admin/reset-avatar", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const { userName } = req.body || {};
        if (!userName) return res.status(400).json({ error: '缺少 userName' });
        const existed = userAvatarsByName.has(userName);
        userAvatarsByName.delete(userName);
        saveUserAvatars();
        // 通过 onlineUsersByName 反查在线 socket，通知该用户头像已被重置
        const targetSocketId = onlineUsersByName.get(userName);
        if (targetSocketId) {
            io.to(targetSocketId).emit('avatar-reset', { byAdmin: true });
            // 广播头像变更（清空），使用在线 socketId
            io.emit('user-avatar-changed', { socketId: targetSocketId, avatar: null });
        }
        res.json({ success: true, existed, userName });
    });

    // ===== 管理员 API：禁用某用户换头像 =====
    app.post("/api/admin/ban-avatar", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const { userName, reason } = req.body || {};
        if (!userName) return res.status(400).json({ error: '缺少 userName' });
        const av = userAvatarsByName.get(userName) || { data: null, updatedAt: 0, banned: false, banReason: '' };
        av.banned = true;
        av.banReason = reason || '管理员禁用';
        av.updatedAt = Date.now();
        userAvatarsByName.set(userName, av);
        saveUserAvatars();
        // 通过 onlineUsersByName 反查在线 socket，通知该用户
        const targetSocketId = onlineUsersByName.get(userName);
        if (targetSocketId) {
            io.to(targetSocketId).emit('avatar-banned', { reason: av.banReason });
        }
        res.json({ success: true, userName, banned: true, reason: av.banReason });
    });

    // ===== 管理员 API：解禁某用户换头像 =====
    app.post("/api/admin/unban-avatar", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const { userName } = req.body || {};
        if (!userName) return res.status(400).json({ error: '缺少 userName' });
        const av = userAvatarsByName.get(userName);
        if (!av) {
            saveUserAvatars();
            return res.json({ success: true, userName, banned: false });
        }
        av.banned = false;
        av.banReason = '';
        av.updatedAt = Date.now();
        userAvatarsByName.set(userName, av);
        saveUserAvatars();
        const targetSocketId = onlineUsersByName.get(userName);
        if (targetSocketId) {
            io.to(targetSocketId).emit('avatar-unbanned', {});
        }
        res.json({ success: true, userName, banned: false });
    });

    // ===== 管理员后台 =====
    app.get("/zidian", (req, res) => {
        if (req.adminAuthed) return res.render('admin');
        res.render('admin_login');
    });

    app.post("/zidian", (req, res) => {
        const { password } = req.body || {};
        if (password === ADMIN_PASSWORD) {
            const token = crypto.randomBytes(32).toString('hex');
            adminSessions.add(token);
            res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=${token}; Path=/; HttpOnly; Max-Age=86400`);
            return res.render('admin');
        }
        res.render('admin_login', { error: '密码错误' });
    });

    app.get("/zidian/logout", (req, res) => {
        const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
        for (const c of cookies) {
            const [k, v] = c.split('=');
            if (k === ADMIN_COOKIE_NAME && v) adminSessions.delete(v);
        }
        res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=; Path=/; Max-Age=0`);
        res.redirect('/zidian');
    });

    // ===== 管理员 API：房间列表 =====
    app.get("/api/admin/rooms", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const roomList = [];
        for (const [roomId, room] of rooms.entries()) {
            roomList.push({
                roomId, memberCount: room.members.size,
                hostName: room.members.get(room.hostId)?.name || '未知',
                createdAt: room.createdAt || 0,
                members: Array.from(room.members.entries()).map(([sid, m]) => ({
                    socketId: sid, name: m.name, isHost: m.isHost, isNative: m.isNative,
                    isGhost: !!m.isGhost, peerUserId: m.peerUserId, joinedAt: m.joinedAt
                }))
            });
        }
        res.json({ rooms: roomList, total: roomList.length });
    });

    // ===== 管理员 API：所有消息（含已隐藏的）=====
    app.get("/api/admin/messages", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const limit = parseInt(req.query.limit) || 200;
        const msgs = chatHistory.slice(-limit).map(m => ({
            ...m,
            hidden: hiddenMessages.has(m.id)
        }));
        res.json({ messages: msgs, total: chatHistory.length, hiddenCount: hiddenMessages.size });
    });

    // ===== 管理员 API：所有用户（含离线）=====
    app.get("/api/admin/users", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        // allUsersHistory 以 name 为 key，遍历 values() 即可（同名只保留一条，避免重复）
        const users = Array.from(allUsersHistory.values()).map(u => {
            // 通过 u.name 查 userAvatarsByName / bannedUsersByName
            const av = userAvatarsByName.get(u.name);
            const banInfo = bannedUsersByName.get(u.name) || null;
            return {
                ...u,
                online: onlineUsersByName.has(u.name),
                banned: !!banInfo,
                banInfo: banInfo,
                // 头像相关字段
                avatar: av && av.data ? av.data : null,
                avatarBanned: !!(av && av.banned)
            };
        });
        res.json({ users, total: users.length, onlineCount: onlineUsers.size });
    });

    // ===== 管理员 API：禁言/封禁用户（按 userName，兼容 socketId）=====
    app.post("/api/admin/ban", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        // 兼容管理员页面传的 socketId / banChat / banMeeting 字段名
        let { userName, socketId, reason, banFromChat, banFromMeeting, banChat, banMeeting } = req.body || {};
        // 若未传 userName，通过 socketId 反查在线用户的 name
        if (!userName && socketId) {
            const onlineUser = onlineUsers.get(socketId);
            if (onlineUser && onlineUser.name) {
                userName = onlineUser.name;
            } else {
                // 离线用户：从 allUsersHistory 查 name
                for (const hist of allUsersHistory.values()) {
                    if (hist.socketId === socketId) { userName = hist.name; break; }
                }
            }
        }
        if (!userName) return res.status(400).json({ error: '缺少 userName 或 socketId' });
        // 字段名兼容：banChat/banMeeting → banFromChat/banFromMeeting
        if (banFromChat === undefined && banChat !== undefined) banFromChat = banChat;
        if (banFromMeeting === undefined && banMeeting !== undefined) banFromMeeting = banMeeting;

        const banInfo = {
            reason: reason || '未提供理由',
            bannedAt: Date.now(),
            bannedFromChat: banFromChat !== false,
            bannedFromMeeting: !!banFromMeeting,
            bannedBy: 'admin'
        };
        bannedUsersByName.set(userName, banInfo);
        saveBannedUsers();

        // 通过 onlineUsersByName 反查在线 socketId，以便 emit
        const targetSocketId = onlineUsersByName.get(userName);
        // 通知用户被封禁
        if (targetSocketId) {
            io.to(targetSocketId).emit('user-banned', banInfo);
            // 如果禁用会议功能，强制离开房间
            if (banFromMeeting) {
                const user = onlineUsers.get(targetSocketId);
                if (user?.roomID) {
                    io.to(targetSocketId).emit('kicked', { reason: '你已被管理员禁用会议功能：' + (reason || '') });
                }
            }
        }
        res.json({ success: true, banInfo, userName });
    });

    // ===== 管理员 API：解封用户（按 userName，兼容 socketId）=====
    app.post("/api/admin/unban", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        let { userName, socketId, reason } = req.body || {};
        // 若未传 userName，通过 socketId 反查 name
        if (!userName && socketId) {
            const onlineUser = onlineUsers.get(socketId);
            if (onlineUser && onlineUser.name) {
                userName = onlineUser.name;
            } else {
                for (const hist of allUsersHistory.values()) {
                    if (hist.socketId === socketId) { userName = hist.name; break; }
                }
            }
        }
        if (!userName) return res.status(400).json({ error: '缺少 userName 或 socketId' });
        if (!bannedUsersByName.has(userName)) return res.status(404).json({ error: '该用户未被封禁' });

        bannedUsersByName.delete(userName);
        saveBannedUsers();
        const targetSocketId = onlineUsersByName.get(userName);
        if (targetSocketId) {
            io.to(targetSocketId).emit('user-unbanned', { reason: reason || '已解封', unbannedAt: Date.now() });
        }
        res.json({ success: true, reason: reason || '已解封', userName });
    });

    // ===== 管理员 API：隐藏消息（在消息对象上加 banned 字段持久化）=====
    app.post("/api/admin/hide-message", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const { msgId } = req.body || {};
        if (!msgId) return res.status(400).json({ error: '缺少 msgId' });

        hiddenMessages.add(msgId);
        saveHiddenMessages();
        // 在 chatHistory 中对应消息对象上加 banned 字段并持久化
        const msg = chatHistory.find(m => m.id === msgId);
        if (msg) {
            msg.banned = true;
            msg.bannedAt = Date.now();
            saveChatHistory();
        }
        // 广播隐藏消息通知
        io.emit('message-hidden', { msgId });
        res.json({ success: true, msgId });
    });

    // ===== 管理员 API：删除单条消息（真正从 chatHistory 移除）=====
    app.post("/api/admin/delete-message", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const { msgId } = req.body || {};
        if (!msgId) return res.status(400).json({ error: '缺少 msgId' });
        const idx = chatHistory.findIndex(m => m.id === msgId);
        if (idx === -1) return res.status(404).json({ error: '消息不存在' });
        chatHistory.splice(idx, 1);
        saveChatHistory();
        io.emit('message-deleted', { msgId });
        console.log(`[管理员删除消息] ${msgId}`);
        res.json({ success: true });
    });

    // ===== 管理员 API：清空所有消息 =====
    app.post("/api/admin/clear-messages", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        chatHistory.length = 0;
        hiddenMessages.clear();
        saveHiddenMessages();
        saveChatHistory();
        io.emit('messages-cleared', {});
        console.log('[管理员清空所有消息]');
        res.json({ success: true });
    });

    // ===== 管理员 API：恢复消息显示（移除 banned 字段）=====
    app.post("/api/admin/show-message", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const { msgId } = req.body || {};
        hiddenMessages.delete(msgId);
        saveHiddenMessages();
        // 移除 chatHistory 中对应消息的 banned 字段并持久化
        const msg = chatHistory.find(m => m.id === msgId);
        if (msg) {
            msg.banned = false;
            delete msg.bannedAt;
            saveChatHistory();
        }
        io.emit('message-shown', { msgId });
        res.json({ success: true, msgId });
    });

    // ===== 管理员 API：改名 =====
    app.post("/api/admin/rename", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const { roomId, socketId, newName } = req.body || {};
        const room = rooms.get(roomId);
        if (!room) return res.status(404).json({ error: '房间不存在' });
        const member = room.members.get(socketId);
        if (!member) return res.status(404).json({ error: '成员不存在' });
        const oldName = member.name;
        member.name = newName;
        broadcastMembersUpdate(room, roomId);
        io.to(socketId).emit('name-changed', { oldName, newName });
        const onlineUser = onlineUsers.get(socketId);
        if (onlineUser) {
            onlineUser.name = newName;
            io.emit('chat-user-renamed', { socketId, oldName, newName, byAdmin: true });
            // 维护按名称索引（删除旧名称，添加新名称）
            onlineUsersByName.delete(oldName);
            onlineUsersByName.set(newName, socketId);
            // 同步迁移历史记录（按 name 索引，key 从 oldName 改为 newName，保留 firstSeen）
            if (allUsersHistory.has(oldName)) {
                const hist = allUsersHistory.get(oldName);
                allUsersHistory.delete(oldName);
                hist.name = newName;
                hist.lastSeen = Date.now();
                allUsersHistory.set(newName, hist);
            } else {
                allUsersHistory.set(newName, {
                    socketId, name: newName, firstSeen: Date.now(), lastSeen: Date.now()
                });
            }
        }
        res.json({ success: true, oldName, newName });
    });

    // ===== 管理员 API：获取违禁词 =====
    app.get("/api/admin/banned-words", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        res.json({ words: bannedWords });
    });

    // ===== 管理员 API：更新违禁词 =====
    app.post("/api/admin/banned-words", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const { words } = req.body || {};
        if (!Array.isArray(words)) return res.status(400).json({ error: 'words 必须是数组' });
        bannedWords = words.filter(w => typeof w === 'string' && w.trim()).map(w => w.trim());
        res.json({ success: true, words: bannedWords });
    });

    // ===== 管理员 API：发布应用更新（接收 base64 APK + 版本信息）=====
    app.post('/api/admin/publish-update', (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const { versionCode, versionName, updateContent, apkData } = req.body || {};
        if (!versionCode || !versionName) return res.status(400).json({ error: '缺少版本号' });
        if (!apkData) return res.status(400).json({ error: '缺少 APK 文件' });

        // 解析 base64 APK 数据（兼容各种 MIME 类型的 data URL）
        const matches = apkData.match(/^data:[^;]+;base64,(.+)$/);
        const base64Data = matches ? matches[1] : apkData;
        let buffer;
        try {
            buffer = Buffer.from(base64Data, 'base64');
        } catch (e) {
            return res.status(400).json({ error: 'APK base64 解码失败' });
        }

        // 保存 APK 文件到 public/downloads/
        const filename = `app-v${versionName}-${Date.now()}.apk`;
        const filepath = path.join(APP_APK_DIR, filename);

        fs.writeFile(filepath, buffer, (err) => {
            if (err) {
                console.error('[APK 保存失败]', err.message);
                return res.status(500).json({ error: 'APK 保存失败' });
            }
            const apkUrl = `/downloads/${filename}`;
            // 保存版本信息
            const versionInfo = {
                versionCode: parseInt(versionCode),
                versionName,
                updateContent: updateContent || '',
                apkUrl,
                publishedAt: Date.now()
            };
            saveAppVersion(versionInfo);
            console.log(`[发布更新] v${versionName} (code=${versionCode}), APK: ${filename} (${Math.round(buffer.length / 1024)}KB)`);
            res.json({ success: true, versionInfo });
        });
    });

    // 管理员获取当前版本信息
    app.get('/api/admin/app-version', (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const info = loadAppVersion();
        res.json({ versionInfo: info });
    });

    // ===== 管理员 API：监控房间 =====
    app.get("/api/admin/monitor/:roomId", (req, res) => {
        if (!req.adminAuthed) return res.status(401).json({ error: '未授权' });
        const roomId = req.params.roomId;
        const room = rooms.get(roomId);
        if (!room) return res.status(404).json({ error: '房间不存在' });
        res.json({
            roomId, memberCount: room.members.size,
            members: Array.from(room.members.entries()).map(([sid, m]) => ({
                socketId: sid, name: m.name, isHost: m.isHost, isNative: m.isNative, peerUserId: m.peerUserId
            }))
        });
    });

    app.get("/:room", (req, res) => {
        const roomId = req.params.room;
        if (/^\d{6}$/.test(roomId)) return res.redirect(`/room/${roomId}`);
        res.redirect('/');
    });

    app.get("/api/room/:room/status", (req, res) => {
        const roomInfo = rooms.get(req.params.room);
        res.json({ exists: !!roomInfo, memberCount: roomInfo ? roomInfo.members.size : 0, hostId: roomInfo ? roomInfo.hostId : null });
    });

    const httpsServer = https.createServer(tlsOptions, app);
    httpsServer.on('tlsClientError', (err, socket) => console.log(`[TLS错误] ${socket.remoteAddress}, ${err.code}`));
    httpsServer.on('secureConnection', (tlsSocket) => console.log(`[TLS成功] ${tlsSocket.remoteAddress}, ${tlsSocket.getProtocol()}`));
    io.attach(httpsServer);
    app.use(ExpressPeerServer(httpsServer, { debug: true, path: '/peerjs' }));

    // HTTP 服务器（8080）：跳转到 HTTPS
    const httpApp = express();
    httpApp.get('*', (req, res) => {
        const hostname = (req.hostname || req.headers.host || 'localhost').split(':')[0];
        res.redirect(302, `https://${hostname}:3030${req.originalUrl || req.url}`);
    });
    const httpServer = http.createServer(httpApp);

    // HTTP 服务器（8081）：提供完整服务（用于浏览器测试，绕过证书问题）
    const httpTestServer = http.createServer(app);
    io.attach(httpTestServer);

    // ===== Socket.IO 连接处理 =====
    io.on('connection', (socket) => {
        console.log(`[新连接] ${socket.id}`);

        // ===== 用户上线 =====
        socket.on('chat-login', (data) => {
            const { name, userId } = data || {};
            const userName = name || generateUserName();
            const now = Date.now();

            // ===== 去抖动：检查是否有同名的待离开计时器，若有则取消（快速重连不刷屏）=====
            const pendingLeaveSocketId = onlineUsersByName.get(userName);
            let isQuickReconnect = false;
            if (pendingLeaveSocketId && pendingLeaveSocketId !== socket.id) {
                const pendingUser = onlineUsers.get(pendingLeaveSocketId);
                if (pendingUser && pendingUser.leaveDebounceTimer) {
                    // 取消离开计时器
                    clearTimeout(pendingUser.leaveDebounceTimer);
                    pendingUser.leaveDebounceTimer = null;
                    isQuickReconnect = true;
                    console.log(`[快速重连] ${userName} 在去抖动窗口内重新连接，取消离开消息`);
                    // 头像现在按 userName 索引，无需迁移
                    onlineUsers.delete(pendingLeaveSocketId);
                }
            }

            onlineUsers.set(socket.id, {
                name: userName, userId: userId || null, joinedAt: now,
                nameLockedUntil: 0, lastRenameAt: 0, roomID: null,
                lastJoinAt: now,         // 最近加入时间（用于去抖动判断）
                leaveDebounceTimer: null  // 离开去抖动计时器
            });
            // 维护按名称索引
            onlineUsersByName.set(userName, socket.id);
            if (socket.data) socket.data.chatName = userName;

            // 记录到历史（以 name 为 key，重连不会产生新条目，避免管理员面板重复）
            const oldHistory = allUsersHistory.get(userName);
            allUsersHistory.set(userName, {
                socketId: socket.id, name: userName,
                firstSeen: oldHistory?.firstSeen || now,
                lastSeen: now
            });

            // 发送历史消息（去除 avatar 字段，避免数据过大导致外网 polling 传输失败）
            const historyWithoutAvatar = chatHistory.map(m => {
                if (m.avatar) {
                    const { avatar, ...rest } = m;
                    return rest;
                }
                return m;
            });
            socket.emit('chat-history', { messages: historyWithoutAvatar });
            // 在线用户列表加入 avatar 字段
            const users = Array.from(onlineUsers.entries()).map(([sid, u]) => ({
                socketId: sid, name: u.name, color: getUserColor(sid), joinedAt: u.joinedAt,
                avatar: getAvatarBySocketId(sid)
            }));
            socket.emit('chat-online-users', { users });

            // 仅当不是快速重连时，才广播 chat-user-joined 事件
            // 注意：不再生成"xx 加入了聊天"系统消息（成员面板的在线列表已足够展示）
            if (!isQuickReconnect) {
                // chat-user-joined 事件加入 avatar 字段（按 userName 查头像）
                socket.broadcast.emit('chat-user-joined', {
                    socketId: socket.id, name: userName, color: getUserColor(socket.id), joinedAt: now,
                    avatar: userAvatarsByName.get(userName)?.data || null
                });
            }

            // 广播完整在线成员列表给所有人（含 avatar）
            // 快速重连时也广播，确保其他客户端更新到新的 socketId
            broadcastOnlineMembersUpdate();

            // ===== 好友系统：通知当前用户的所有好友"我上线了" =====
            if (!isQuickReconnect) {
                notifyFriendsStatusChange(userName, true);
            }

            // 发送封禁状态（如果有的话，按 userName 索引）
            if (bannedUsersByName.has(userName)) {
                socket.emit('user-banned', bannedUsersByName.get(userName));
            }

            console.log(`[聊天上线] ${userName} (${socket.id})${isQuickReconnect ? ' [快速重连]' : ''}`);
        });

        // ===== 发送聊天消息 =====
        socket.on('chat-send-message', (data, callback) => {
            const { type, content, duration } = data || {};
            // 防御：群聊通道不接收 target=private 的消息（私聊通话记录应走 /api/friends/message）
            if (data && data.target === 'private') {
                console.log(`[群聊过滤] 拒绝私聊消息进入群聊通道: ${data.type || 'text'}`);
                if (callback) callback({ error: '私聊消息不应走群聊通道' });
                return;
            }
            const user = onlineUsers.get(socket.id);

            // 修复：如果用户未 login，自动用 socket.data.chatName 注册
            if (!user) {
                const userName = (socket.data && socket.data.chatName) || generateUserName();
                onlineUsers.set(socket.id, {
                    name: userName, joinedAt: Date.now(),
                    nameLockedUntil: 0, lastRenameAt: 0, roomID: null,
                    lastJoinAt: Date.now(),
                    leaveDebounceTimer: null
                });
                // 维护按名称索引
                onlineUsersByName.set(userName, socket.id);
                console.log(`[自动注册] ${userName} (${socket.id})`);
            }

            const currentUser = onlineUsers.get(socket.id);
            if (!currentUser) {
                if (callback) callback({ error: '用户未注册' });
                return;
            }

            // 检查是否被禁言（按 userName 索引）
            const banInfo = bannedUsersByName.get(currentUser.name);
            if (banInfo && banInfo.bannedFromChat) {
                socket.emit('message-blocked', {
                    reason: `你已被禁言：${banInfo.reason}`,
                    content
                });
                if (callback) callback({ error: '已被禁言' });
                return;
            }

            // 仅文本消息检查违禁词（图片/视频/语音是二进制 base64，不应做关键词匹配）
            if (type === 'text' || !type) {
                const bannedWord = containsBannedWord(content);
                if (bannedWord) {
                    socket.emit('message-blocked', {
                        reason: `消息包含违禁词"${bannedWord}"，无法发送`,
                        content
                    });
                    if (callback) callback({ error: '包含违禁词' });
                    return;
                }
            }

            // 视频消息大小检查（允许 30MB 原始文件，base64 编码后约 40MB）
            if (type === 'video' && content && content.length > 40 * 1024 * 1024) {
                socket.emit('message-blocked', {
                    reason: '视频太大（超过 30MB），请缩短时长或压缩后发送',
                    content: ''
                });
                if (callback) callback({ error: '视频太大' });
                return;
            }

            // 不在消息中存 avatar（320KB base64 会导致 chat-history 过大，外网 polling 传输失败）
            // 前端通过 chat-online-users / online-members-update 事件获取头像（按 userName 索引）
            const msg = {
                id: crypto.randomUUID(),
                type: type || 'text',
                name: currentUser.name,
                senderName: currentUser.name,  // 持久化发送者名称，刷新后仍可识别自己
                userId: currentUser.userId || null,  // 持久化用户ID（改名/刷新都不变）
                content: content,
                socketId: socket.id,
                color: getUserColor(socket.id),
                timestamp: Date.now(),
                target: 'group'  // 目标：group=群聊（默认），private=私聊（不会显示在群聊）
            };
            // 语音消息保留时长
            if (type === 'voice' && duration) {
                msg.duration = duration;
            }
            // 通话记录消息：保存通话类型、对方名、通话时长
            if (type === 'call') {
                msg.callType = data.callType || 'voice';
                msg.peerName = data.peerName || '';
                msg.callDuration = parseInt(data.callDuration) || 0;
            }
            // 引用消息：保存引用的原消息信息
            if (data.quote && data.quote.content) {
                msg.quote = {
                    id: data.quote.id || '',
                    name: data.quote.name || '',
                    content: String(data.quote.content).slice(0, 200)  // 限制长度
                };
            }
            addChatMessage(msg);
            io.emit('chat-message', msg);

            console.log(`[聊天消息] ${currentUser.name}: ${type === 'image' ? '[图片]' : type === 'video' ? '[视频 ' + Math.round(content.length/1024) + 'KB]' : type === 'voice' ? '[语音]' : type === 'call' ? '[通话记录 ' + (msg.callType || 'voice') + ' ' + msg.callDuration + 's]' : content.substring(0, 50)}`);

            // 发送 ack 确认给发送方
            if (callback) callback({ success: true, msgId: msg.id });
        });

        // ===== 撤回消息（持久化）=====
        socket.on('recall-message', (data) => {
            const { msgId } = data || {};
            if (!msgId) return;
            const currentUser = onlineUsers.get(socket.id);
            if (!currentUser) return;
            const msg = chatHistory.find(m => m.id === msgId);
            if (!msg) return;
            // 校验：只能撤回自己的消息（优先用 userId，其次 socketId，最后 senderName）
            const isOwn = (msg.userId && currentUser.userId && msg.userId === currentUser.userId)
                || msg.socketId === socket.id
                || msg.senderName === currentUser.name;
            if (!isOwn) {
                socket.emit('recall-error', { msgId, reason: '只能撤回自己的消息' });
                return;
            }
            // 校验：撤回时间窗口 2 分钟
            if (Date.now() - msg.timestamp >= 2 * 60 * 1000) {
                socket.emit('recall-error', { msgId, reason: '超过 2 分钟，无法撤回' });
                return;
            }
            msg.recalled = true;
            msg.recalledAt = Date.now();
            saveChatHistory();
            io.emit('message-recalled', { msgId });
            console.log(`[消息撤回] ${currentUser.name} 撤回了消息 ${msgId}`);
        });

        // ===== 加入视频会议房间 =====
        socket.on('join-room', (data) => {
            const { roomID, peerUserId, isNative, isScreenShareSource, name, isGhost } = data;
            if (!roomID) return;

            // 检查是否被禁用会议功能（按 userName 索引）
            const joinUser = onlineUsers.get(socket.id);
            const banInfo = joinUser ? bannedUsersByName.get(joinUser.name) : null;
            if (banInfo && banInfo.bannedFromMeeting && !isGhost) {
                socket.emit('kicked', { reason: '你已被禁用会议功能：' + banInfo.reason });
                return;
            }

            socket.join(roomID);
            const ghostMode = !!isGhost;

            if (!rooms.has(roomID) && !ghostMode) {
                rooms.set(roomID, { hostId: socket.id, members: new Map(), createdAt: Date.now() });
                console.log(`[房间创建] ${roomID}, 房主: ${socket.id}`);
            }

            const room = rooms.get(roomID);
            if (!room) {
                socket.emit('error-message', { message: '房间不存在' });
                return;
            }

            const userName = name || onlineUsers.get(socket.id)?.name || generateUserName();
            const isHost = !ghostMode && room.hostId === socket.id;

            socket.data = { roomID, peerUserId, isNative: !!isNative, isScreenShareSource: !!isScreenShareSource, name: userName, isHost, isGhost: ghostMode };

            const onlineUser = onlineUsers.get(socket.id);
            if (onlineUser) { onlineUser.roomID = roomID; onlineUser.name = userName; }

            room.members.set(socket.id, { peerUserId, name: userName, isHost, joinedAt: Date.now(), isNative: !!isNative, isGhost: ghostMode });

            console.log(`[加入房间] ${roomID}, ${userName} (${socket.id})${ghostMode ? ' [监控]' : ''}`);

            if (ghostMode) {
                const otherMembers = Array.from(room.members.entries())
                    .filter(([sid, m]) => sid !== socket.id && !m.isGhost)
                    .map(([sid, m]) => ({ socketId: sid, peerUserId: m.peerUserId, name: m.name, isHost: m.isHost, isNative: m.isNative }));
                socket.emit("ghost-members", { members: otherMembers });
                socket.to(roomID).emit("ghost-joined", { peerUserId, name: userName });
            } else {
                if (!isNative) socket.to(roomID).emit("user-connected", peerUserId);
                broadcastMembersUpdate(room, roomID);
                socket.emit("host-status", { isHost });
            }
        });

        socket.on('native-screen-share-start', (data) => {
            console.log(`[屏幕共享] start from ${socket.id}, room=${data.roomID}`);
            if (data.roomID) socket.to(data.roomID).emit("native-screen-share-start", data);
        });
        socket.on('native-screen-share-stop', (data) => {
            console.log(`[屏幕共享] stop from ${socket.id}, room=${data.roomID}`);
            if (data.roomID) socket.to(data.roomID).emit("native-screen-share-stop", data);
        });
        socket.on('native-screen-frame', (data) => {
            if (data.roomID && data.frame) {
                // 日志限流：每 60 帧打印一次
                if (!global._screenFrameCount) global._screenFrameCount = 0;
                global._screenFrameCount++;
                if (global._screenFrameCount % 60 === 1) {
                    console.log(`[屏幕共享] frame #${global._screenFrameCount} from ${socket.id}, room=${data.roomID}, size=${data.frame.length}`);
                }
                socket.to(data.roomID).emit("native-screen-frame", { frame: data.frame, timestamp: data.timestamp });
            }
        });

        // ===== 原生 WebRTC 信令（替代 PeerJS，解决黑屏问题）=====
        // webrtcRooms 已在外部声明（全局）

        socket.on('webrtc-join', (data, cb) => {
            const { roomId, name, isGhost } = data || {};
            if (!roomId) { if (cb) cb({ error: 'no roomId' }); return; }
            socket.join(roomId);
            const userObj = { socketId: socket.id, name: name || '匿名', isGhost: !!isGhost };
            if (!webrtcRooms.has(roomId)) webrtcRooms.set(roomId, new Map());
            const members = webrtcRooms.get(roomId);
            // 通知房间内已有用户：有新用户加入（由老用户主动发起 offer）
            socket.to(roomId).emit('webrtc-peer-joined', userObj);
            // 给新用户回传当前房间内其他用户列表（新用户被动等待老用户发起 offer）
            const others = [];
            for (const [sid, m] of members.entries()) {
                if (sid !== socket.id) others.push(m);
            }
            members.set(socket.id, userObj);
            if (cb) cb({ ok: true, members: others });
        });

        socket.on('webrtc-leave', (data) => {
            const { roomId } = data || {};
            if (!roomId) return;
            socket.to(roomId).emit('webrtc-peer-left', { socketId: socket.id });
            const members = webrtcRooms.get(roomId);
            if (members) {
                members.delete(socket.id);
                if (members.size === 0) webrtcRooms.delete(roomId);
            }
        });

        // 转发 offer
        socket.on('webrtc-offer', (data) => {
            const { toSocketId, sdp } = data || {};
            if (!toSocketId || !sdp) return;
            io.to(toSocketId).emit('webrtc-offer', { from: socket.id, sdp });
        });

        // 转发 answer
        socket.on('webrtc-answer', (data) => {
            const { toSocketId, sdp } = data || {};
            if (!toSocketId || !sdp) return;
            io.to(toSocketId).emit('webrtc-answer', { from: socket.id, sdp });
        });

        // 转发 ICE candidate
        socket.on('webrtc-ice-candidate', (data) => {
            const { toSocketId, candidate } = data || {};
            if (!toSocketId || !candidate) return;
            io.to(toSocketId).emit('webrtc-ice-candidate', { from: socket.id, candidate });
        });

        socket.on('kick-member', (data) => {
            const room = rooms.get(data.roomID);
            if (!room || room.hostId !== socket.id) return;
            for (const [sid, member] of room.members) {
                if (member.peerUserId === data.peerUserId) {
                    io.to(sid).emit('kicked', { reason: '你已被房主移除' });
                    io.sockets.sockets.get(sid)?.disconnect(true);
                    break;
                }
            }
        });

        socket.on('leave-room', () => handleLeaveRoom(socket));
        socket.on('message', (data) => { if (data.ROOM_ID) socket.to(data.ROOM_ID).broadcast.emit("new-message", { message: data.message }); });
        socket.on('screen-share-init', (data) => { if (data.roomID && data.peerUserId) socket.to(data.roomID).broadcast.emit("user-screen-share", data); });
        socket.on('error', (reason) => console.log('[socket error]', reason));

        // ===== 用户头像：上传/更新头像（按 userName 索引）=====
        socket.on('set-avatar', (data) => {
            const { avatar } = data || {};
            const currentUser = onlineUsers.get(socket.id);
            if (!currentUser || !currentUser.name) {
                socket.emit('avatar-blocked', { reason: '请先登录' });
                return;
            }
            const userName = currentUser.name;
            // 检查是否被禁用换头像
            const existing = userAvatarsByName.get(userName);
            if (existing && existing.banned) {
                socket.emit('avatar-blocked', { reason: `你已被禁用换头像：${existing.banReason || ''}` });
                return;
            }
            // 头像为空表示清除
            if (!avatar) {
                if (existing) {
                    existing.data = null;
                    existing.updatedAt = Date.now();
                    userAvatarsByName.set(userName, existing);
                    saveUserAvatars();
                }
                io.emit('user-avatar-changed', { socketId: socket.id, avatar: null });
                return;
            }
            // 检查头像大小（base64 字符串长度近似字节数）
            if (typeof avatar !== 'string' || avatar.length > MAX_AVATAR_SIZE) {
                socket.emit('avatar-blocked', { reason: `头像过大，最大允许 ${MAX_AVATAR_SIZE} 字节` });
                return;
            }
            // 存入 userAvatarsByName Map
            userAvatarsByName.set(userName, {
                data: avatar,
                updatedAt: Date.now(),
                banned: existing ? existing.banned : false,
                banReason: existing ? existing.banReason : ''
            });
            saveUserAvatars();
            // 广播头像变更给所有人
            io.emit('user-avatar-changed', { socketId: socket.id, avatar });
            console.log(`[头像更新] ${userName} (${socket.id}) (${avatar.length} 字节)`);
        });

        // ===== 用户主页：请求某用户的主页信息 =====
        socket.on('get-profile', (data) => {
            const { socketId } = data || {};
            if (!socketId) {
                socket.emit('profile-data', { error: '缺少 socketId' });
                return;
            }
            const onlineUser = onlineUsers.get(socketId);
            // allUsersHistory 按 name 索引；在线用户通过 name 反查，离线用户需遍历
            const histName = onlineUser?.name || null;
            const historyUser = histName
                ? allUsersHistory.get(histName)
                : null;
            // 通过 onlineUser.name 反查 userAvatarsByName
            const nameForAvatar = histName || historyUser?.name;
            const av = nameForAvatar ? userAvatarsByName.get(nameForAvatar) : null;
            socket.emit('profile-data', {
                socketId,
                name: onlineUser?.name || historyUser?.name || '未知用户',
                avatar: av && av.data ? av.data : null,
                avatarBanned: !!(av && av.banned),
                online: !!onlineUser,
                joinedAt: onlineUser?.joinedAt || historyUser?.firstSeen || 0,
                lastSeen: onlineUser ? Date.now() : (historyUser?.lastSeen || 0)
            });
        });

        // ===== 视频通话邀请：主叫发起呼叫 =====
        socket.on('call-invite', (data) => {
            const { toSocketId, callType, callId, roomId, isPrivateCall } = data || {};
            if (!toSocketId || !callId) {
                socket.emit('call-error', { callId, message: '缺少 toSocketId 或 callId' });
                return;
            }
            // 检查目标用户在线状态
            const targetUser = onlineUsers.get(toSocketId);
            if (!targetUser) {
                socket.emit('call-error', { callId, message: '目标用户不在线' });
                return;
            }
            // 获取主叫名称
            const caller = onlineUsers.get(socket.id);
            const fromName = caller?.name || '未知用户';
            // 存入待处理邀请队列（按被叫 userName 索引，外网 socket 断连时通过 HTTP 轮询兜底）
            const inviteData = {
                from: socket.id,
                fromName,
                callType: callType || 'video',
                callId,
                roomId: roomId || null,
                isPrivateCall: !!isPrivateCall,  // 透传私聊通话标记，被叫据此设置 privateCallPeer
                timestamp: Date.now()
            };
            if (!pendingCallInvites.has(targetUser.name)) {
                pendingCallInvites.set(targetUser.name, []);
            }
            // 避免重复添加相同 callId
            const invites = pendingCallInvites.get(targetUser.name);
            if (!invites.some(i => i.callId === callId)) {
                invites.push(inviteData);
            }
            // 向目标用户发送来电通知（socket 推送，可能因外网断连而丢失）
            io.to(toSocketId).emit('call-incoming', inviteData);
            console.log(`[通话邀请] ${fromName} (${socket.id}) -> ${targetUser.name} (${toSocketId}), callId=${callId}`);
        });

        // ===== 视频通话：被叫接受 =====
        socket.on('call-accept', (data) => {
            const { callId, toSocketId } = data || {};
            if (!callId || !toSocketId) return;
            // 清理待处理邀请（按被叫 userName 索引）
            const accepter = onlineUsers.get(socket.id);
            if (accepter && pendingCallInvites.has(accepter.name)) {
                const invites = pendingCallInvites.get(accepter.name);
                pendingCallInvites.set(accepter.name, invites.filter(i => i.callId !== callId));
            }
            io.to(toSocketId).emit('call-accepted', { callId, from: socket.id });
            console.log(`[通话接受] callId=${callId}, ${socket.id} -> ${toSocketId}`);
        });

        // ===== 视频通话：被叫拒绝 =====
        socket.on('call-reject', (data) => {
            const { callId, toSocketId, reason } = data || {};
            if (!callId || !toSocketId) return;
            // 清理待处理邀请
            const rejecter = onlineUsers.get(socket.id);
            if (rejecter && pendingCallInvites.has(rejecter.name)) {
                const invites = pendingCallInvites.get(rejecter.name);
                pendingCallInvites.set(rejecter.name, invites.filter(i => i.callId !== callId));
            }
            io.to(toSocketId).emit('call-rejected', { callId, reason: reason || '被叫拒绝' });
            console.log(`[通话拒绝] callId=${callId}, ${socket.id} -> ${toSocketId}`);
        });

        // ===== 视频通话：任意一方挂断 =====
        socket.on('call-end', (data) => {
            const { callId, toSocketId, duration } = data || {};
            if (!callId || !toSocketId) return;
            io.to(toSocketId).emit('call-ended', { callId, duration: duration || 0 });
            console.log(`[通话结束] callId=${callId}, ${socket.id} -> ${toSocketId}, duration=${duration || 0}`);
        });

        // ===== 视频通话：主叫取消呼叫 =====
        socket.on('call-caller-cancel', (data) => {
            const { callId, toSocketId } = data || {};
            if (!callId || !toSocketId) return;
            // 清理待处理邀请
            const targetUser = onlineUsers.get(toSocketId);
            if (targetUser && pendingCallInvites.has(targetUser.name)) {
                const invites = pendingCallInvites.get(targetUser.name);
                pendingCallInvites.set(targetUser.name, invites.filter(i => i.callId !== callId));
            }
            io.to(toSocketId).emit('call-cancelled', { callId });
            console.log(`[通话取消] callId=${callId}, ${socket.id} -> ${toSocketId}`);
        });

        socket.on('disconnect', () => {
            console.log(`[断开连接] ${socket.id}`);
            handleLeaveRoom(socket);
            // ===== 清理原生 WebRTC 房间 =====
            for (const [roomId, members] of webrtcRooms.entries()) {
                if (members.has(socket.id)) {
                    members.delete(socket.id);
                    socket.to(roomId).emit('webrtc-peer-left', { socketId: socket.id });
                    if (members.size === 0) webrtcRooms.delete(roomId);
                }
            }
            const user = onlineUsers.get(socket.id);
            if (user) {
                // 清除已有的计时器（避免重复设置）
                if (user.leaveDebounceTimer) clearTimeout(user.leaveDebounceTimer);
                // ===== 去抖动：延迟 3 秒再发"离开"消息，期间若同名用户重连则取消 =====
                user.leaveDebounceTimer = setTimeout(() => {
                    const u = onlineUsers.get(socket.id);
                    if (!u) return;  // 已经被清理（例如重连时迁移）
                    const leaveName = u.name;
                    // 注意：不再生成"xx 离开了聊天"系统消息（成员面板的在线列表已足够展示）
                    io.emit('chat-user-left', { socketId: socket.id, name: leaveName });
                    onlineUsers.delete(socket.id);
                    // 删除按名称索引（仅当仍指向当前 socket 时）
                    if (onlineUsersByName.get(leaveName) === socket.id) {
                        onlineUsersByName.delete(leaveName);
                    }
                    // 更新历史记录的最后在线时间（按 name 索引）
                    if (allUsersHistory.has(leaveName)) {
                        allUsersHistory.get(leaveName).lastSeen = Date.now();
                    }
                    // 广播完整在线成员列表更新
                    broadcastOnlineMembersUpdate();
                    // 通知该用户的所有好友"我下线了"
                    notifyFriendsStatusChange(leaveName, false);
                    console.log(`[离开聊天] ${leaveName} (${socket.id})`);
                }, LEAVE_DEBOUNCE_MS);
                console.log(`[断开待确认] ${user.name} (${socket.id})，${LEAVE_DEBOUNCE_MS}ms 后发送离开消息`);
            }
        });
    });

    function handleLeaveRoom(socket) {
        const { roomID, peerUserId, name, isNative, isGhost } = socket.data || {};
        if (!roomID) return;
        const room = rooms.get(roomID);
        if (!room) return;
        room.members.delete(socket.id);
        console.log(`[离开房间] ${roomID}, ${name || peerUserId}${isGhost ? ' [监控]' : ''}`);
        socket.leave(roomID);
        const onlineUser = onlineUsers.get(socket.id);
        if (onlineUser) onlineUser.roomID = null;
        if (room.members.size === 0) { rooms.delete(roomID); return; }
        if (isGhost) { socket.to(roomID).emit("ghost-left", { peerUserId }); return; }
        if (room.hostId === socket.id) {
            const firstMember = Array.from(room.members.entries()).find(([sid, m]) => !m.isGhost);
            if (firstMember) {
                room.hostId = firstMember[0];
                firstMember[1].isHost = true;
                io.to(firstMember[0]).emit('host-status', { isHost: true });
            }
        }
        broadcastMembersUpdate(room, roomID);
        if (!isNative && peerUserId) socket.to(roomID).emit("user-disconnected", peerUserId);
    }

    httpServer.on('error', (err) => console.error('HTTP 跳转服务器错误:', err));
    httpServer.listen({ port: 8080, host: '::', ipv6Only: false }, () => console.log('HTTP 跳转服务已启动（端口 8080）'));

    httpTestServer.on('error', (err) => console.error('HTTP 测试服务器错误:', err));
    httpTestServer.listen({ port: 8081, host: '0.0.0.0' }, () => console.log('HTTP 测试服务已启动（端口 8081，完整功能）'));

    httpsServer.listen({ port: 3030, host: '::', ipv6Only: false }, () => {
        // 动态获取本机 IPv4 地址，避免硬编码
        const nets = os.networkInterfaces();
        const localIps = [];
        for (const name of Object.keys(nets)) {
            for (const net of nets[name] || []) {
                if (net.family === 'IPv4' && !net.internal) {
                    localIps.push(net.address);
                }
            }
        }
        const displayIp = localIps[0] || '<your-server-ip>';
        console.log('==================================================');
        console.log('  服务器已启动（聊天+语音+管理员+禁言+违禁词）');
        console.log('--------------------------------------------------');
        if (localIps.length > 0) {
            localIps.forEach(ip => console.log(`  https://${ip}:3030`));
        } else {
            console.log('  https://<your-server-ip>:3030');
        }
        console.log(`  管理员: https://${displayIp}:3030/zidian`);
        console.log('  HTTP 测试: http://localhost:8081');
        console.log('==================================================');
    });
}

main().catch(e => console.log(e));
