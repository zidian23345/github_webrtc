const utils = {
    socket: io('/', { secure: true }),
    ROOM_ID: document.getElementById('roomId').value,
    // 从 URL 参数或 sessionStorage 获取用户名称
    USER_NAME: (function() {
        // 优先从 localStorage 读取（用户改名后这里存的是最新名字）
        const local = localStorage.getItem('meetingUserName');
        if (local && local.trim()) return local;
        // localStorage 没有时从 Android App 获取
        try {
            if (window.AndroidApp && window.AndroidApp.getUserName) {
                const androidName = window.AndroidApp.getUserName();
                if (androidName && androidName.trim()) {
                    localStorage.setItem('meetingUserName', androidName);
                    return androidName;
                }
            }
        } catch(e) {}
        // 兼容旧版 sessionStorage
        const saved = sessionStorage.getItem('meetingUserName');
        if (saved) {
            localStorage.setItem('meetingUserName', saved);
            return saved;
        }
        return '匿名用户' + Math.floor(Math.random() * 1000);
    })(),
    // 是否为管理员隐身监控模式
    IS_GHOST: new URLSearchParams(window.location.search).has('ghost'),
    customlogger: (...args) => {
        console.log(...args);
    },
    peer: function () {
        // configure webrtc，根据当前页面的协议自动判断是否使用安全连接
        const isSecure = window.location.protocol === 'https:';
        let host = window.location.hostname;
        // IPv6 地址在 URL 中需要用方括号包裹，否则 PeerJS 构造 URL 时会出错
        if (host.includes(':') && !host.startsWith('[')) {
            host = '[' + host + ']';
        }
        let peer = new Peer(undefined, {
            path: '/peerjs',
            host: host,
            port: window.location.port || (isSecure ? '443' : '80'),
            secure: isSecure,
            // 添加 ICE 服务器配置（NAT 穿透必需，否则跨网络通话会黑屏）
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' }
                ]
            }
        })
        //webrtc listener for new peers
        peer.on('open', id => {
            this.customlogger("new peer opened", " peerID: ", id);
            // 通知服务器加入房间，同时传 peer id 用于成员管理
            this.socket.emit('join-room', {
                roomID: this.ROOM_ID,
                peerUserId: id,
                name: this.IS_GHOST ? '管理员监控' : this.USER_NAME,
                isGhost: this.IS_GHOST
            });
            // 通知页面自己的 peerUserId
            if (window.updateMyPeerId) {
                window.updateMyPeerId(id);
            }
        });

        return peer;
    }
};
Object.freeze(utils); // make utils immutable
