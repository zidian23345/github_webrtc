// ===== 新版原生 WebRTC 实现（替代 PeerJS，解决黑屏问题）=====
// 不再依赖 PeerJS，所有信令通过 Socket.IO 转发
// 事件：webrtc-join / webrtc-peer-joined / webrtc-offer / webrtc-answer /
//       webrtc-ice-candidate / webrtc-peer-left
(() => {
    "use strict";

    const ROOM_ID = document.getElementById('roomId').value;
    // 从 localStorage 读取用户名（与 home.ejs 共享）
    let MY_NAME = '';
    try { MY_NAME = localStorage.getItem('meetingUserName') || ''; } catch(e) {}
    if (!MY_NAME) MY_NAME = '匿名' + Math.floor(Math.random() * 1000);

    const isGhostMode = new URLSearchParams(window.location.search).has('ghost');
    const isVoiceCall = (function() {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const t = (urlParams.get('callType') || urlParams.get('roomType') || '').toLowerCase();
            if (t === 'voice' || t === 'audio') return true;
            const ls = (localStorage.getItem('callType') || '').toLowerCase();
            if (ls === 'voice' || ls === 'audio') return true;
        } catch(e) {}
        return false;
    })();

    // ===== Socket.IO 连接（与 home.ejs 一致配置）=====
    // polling 优先 + 允许升级（内网 websocket，外网 polling）
    const socket = io('/', {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
        transports: ['polling', 'websocket'],  // polling 优先，可升级
        upgrade: true  // 允许升级（内网升级 websocket，外网保持 polling）
    });

    // ===== 全局状态 =====
    let localStream = null;          // 本地媒体流
    let screenShareStream = null;     // 屏幕共享流
    let peerConnections = {};         // socketId -> RTCPeerConnection
    let remoteStreams = {};            // socketId -> MediaStream
    let currentMembers = [];
    let isHost = false;
    let mySocketId = null;
    let micEnabled = true;
    let cameraEnabled = !isVoiceCall;  // 语音通话默认关摄像头
    let currentFacingMode = 'user';
    let voiceCallDurationTimer = null;
    let hasRemotePeer = false;

    // ===== ICE 服务器配置（NAT 穿透）=====
    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ],
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle'
    };

    // ===== UI 辅助函数 =====
    function showToast(msg, type) {
        const toast = document.getElementById('toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.className = 'toast show' + (type === 'error' ? ' error' : '');
        setTimeout(() => { toast.className = 'toast'; }, 2500);
    }

    function copyMeetingCode() {
        const code = ROOM_ID;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(code).then(() => showToast('会议号已复制'));
        } else {
            const ta = document.createElement('textarea');
            ta.value = code;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast('会议号已复制');
        }
    }

    function copyMeetingLink() {
        const link = window.location.href;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(link).then(() => showToast('邀请链接已复制'));
        }
    }

    function hideWaitingScreen() {
        document.getElementById('waitingScreen').style.display = 'none';
        document.getElementById('topBar').style.display = 'flex';
        document.getElementById('controlsBar').style.display = 'flex';
    }

    function showWaitingScreen() {
        document.getElementById('waitingScreen').style.display = 'flex';
        document.getElementById('topBar').style.display = 'none';
        document.getElementById('controlsBar').style.display = 'none';
    }

    // ===== 安全播放（捕获 promise 避免 rejected）=====
    function safePlay(videoEl) {
        if (!videoEl) return;
        try {
            const p = videoEl.play();
            if (p && typeof p.catch === 'function') {
                p.catch((e) => console.log('[视频] play() 被拒绝:', e.name || e.message || e));
            }
        } catch (e) {
            console.log('[视频] play() 异常:', e);
        }
    }

    // ===== 获取本地媒体流 =====
    async function getLocalStream() {
        try {
            if (isGhostMode) {
                // 监控模式：不请求摄像头/麦克风
                localStream = new MediaStream();
                return;
            }
            const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
            // 读取画质设置（与 home 页面共享 localStorage）
            const vq = localStorage.getItem('videoQuality') || 'medium';
            const videoResMap = {
                low: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } },
                medium: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 20 } },
                high: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
            };
            const videoRes = videoResMap[vq] || videoResMap.medium;
            const constraints = isVoiceCall
                ? { audio: true, video: false }
                : {
                    audio: { echoCancellation: true, noiseSuppression: true },
                    video: isMobile
                        ? { facingMode: currentFacingMode, ...videoRes }
                        : videoRes
                };
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            // 显示自己的视频
            const selfContainer = document.getElementById('selfVideo');
            selfContainer.innerHTML = '';
            const selfVideo = document.createElement('video');
            selfVideo.srcObject = localStream;
            selfVideo.muted = true;
            selfVideo.setAttribute('playsinline', '');
            selfVideo.setAttribute('webkit-playsinline', '');
            selfVideo.autoplay = true;
            selfContainer.appendChild(selfVideo);
            selfVideo.addEventListener('loadedmetadata', () => safePlay(selfVideo));
            // 语音通话时隐藏自己的视频小窗
            if (isVoiceCall) {
                selfContainer.style.display = 'none';
            }
        } catch (e) {
            console.error('[获取本地媒体流失败]', e);
            showToast('无法访问摄像头/麦克风：' + (e.message || e.name || ''), 'error');
        }
    }

    // ===== 设置视频发送方最大码率（避免 WebRTC 默认低码率导致画质模糊）=====
    // WebRTC 默认编码码率约 500kbps，1280x720 需要至少 1.5Mbps 才清晰
    async function setVideoSenderMaxBitrate(sender, maxBitrate) {
        try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = maxBitrate;
            await sender.setParameters(params);
            console.log('[WebRTC] 视频码率设置为: ' + (maxBitrate / 1000) + ' kbps');
        } catch (e) {
            console.warn('[WebRTC] 设置码率失败', e.message);
        }
    }

    // ===== 创建 RTCPeerConnection =====
    function createPeerConnection(remoteSocketId) {
        if (peerConnections[remoteSocketId]) {
            return peerConnections[remoteSocketId];
        }
        const pc = new RTCPeerConnection(rtcConfig);

        // 添加本地流轨道
        if (localStream) {
            localStream.getTracks().forEach(track => {
                const sender = pc.addTrack(track, localStream);
                // 视频轨道设置高码率（避免 WebRTC 默认低码率导致高画质被压缩成模糊）
                // 根据画质设置对应 maxBitrate
                if (track.kind === 'video') {
                    const vq = localStorage.getItem('videoQuality') || 'medium';
                    const bitrateMap = { low: 300000, medium: 1000000, high: 2500000 };
                    const maxBitrate = bitrateMap[vq] || 1000000;
                    setVideoSenderMaxBitrate(sender, maxBitrate);
                }
            });
        }

        // 接收远端流
        pc.ontrack = (event) => {
            console.log('[WebRTC] 收到远端轨道:', event.track.kind, 'from', remoteSocketId);
            let stream = remoteStreams[remoteSocketId];
            if (!stream) {
                stream = new MediaStream();
                remoteStreams[remoteSocketId] = stream;
            }
            stream.addTrack(event.track);
            // 显示远端视频
            attachRemoteVideo(remoteSocketId, stream);
        };

        // ICE candidate
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc-ice-candidate', {
                    toSocketId: remoteSocketId,
                    candidate: event.candidate
                });
            }
        };

        // 连接状态监控
        pc.oniceconnectionstatechange = () => {
            console.log('[ICE] 与', remoteSocketId, '状态:', pc.iceConnectionState);
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                // 连接成功，确保视频播放
                setTimeout(() => {
                    const v = document.querySelector('#mainVideo video');
                    if (v) safePlay(v);
                }, 500);
            }
        };

        pc.onconnectionstatechange = () => {
            console.log('[PC] 与', remoteSocketId, '连接状态:', pc.connectionState);
        };

        peerConnections[remoteSocketId] = pc;
        return pc;
    }

    // ===== 显示远端视频 =====
    function attachRemoteVideo(remoteSocketId, stream) {
        const mainContainer = document.getElementById('mainVideo');
        // 检查是否已有 video 元素
        let video = mainContainer.querySelector('video');
        if (!video) {
            mainContainer.innerHTML = '';
            video = document.createElement('video');
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.setAttribute('x-webkit-airplay', 'allow');
            video.autoplay = true;
            video.muted = false;
            video.style.width = '100%';
            video.style.height = '100%';
            video.style.objectFit = 'cover';
            video.style.display = '';
            mainContainer.appendChild(video);
        }
        video.srcObject = stream;
        // 监听事件确保播放
        video.addEventListener('loadedmetadata', () => safePlay(video));
        video.addEventListener('loadeddata', () => safePlay(video));
        video.addEventListener('canplay', () => safePlay(video));
        safePlay(video);
        // 兜底：1秒后再次尝试播放
        setTimeout(() => safePlay(video), 1000);

        // 检测语音通话
        const hasActiveVideo = stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live');
        if (isVoiceCall || !hasActiveVideo) {
            // 语音通话：隐藏 video，显示头像界面
            video.style.display = 'none';
            showVoiceCallView(remoteSocketId);
        } else {
            // 视频通话：正常显示
            video.style.display = '';
            hideVoiceCallView();
        }
        // 隐藏等待界面
        hideWaitingScreen();
        hasRemotePeer = true;
    }

    // ===== 发起 offer（老用户主动发起）=====
    async function makeOffer(remoteSocketId) {
        const pc = createPeerConnection(remoteSocketId);
        try {
            const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
            await pc.setLocalDescription(offer);
            socket.emit('webrtc-offer', { toSocketId: remoteSocketId, sdp: offer });
            console.log('[WebRTC] 已发送 offer 给', remoteSocketId);
        } catch (e) {
            console.error('[WebRTC] 创建 offer 失败:', e);
        }
    }

    // ===== 接收 offer 并回复 answer（新用户被动接收）=====
    socket.on('webrtc-offer', async (data) => {
        const { from, sdp } = data;
        if (!from || !sdp) return;
        console.log('[WebRTC] 收到 offer from', from);
        const pc = createPeerConnection(from);
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('webrtc-answer', { toSocketId: from, sdp: answer });
            console.log('[WebRTC] 已发送 answer 给', from);
        } catch (e) {
            console.error('[WebRTC] 处理 offer 失败:', e);
        }
    });

    // ===== 接收 answer =====
    socket.on('webrtc-answer', async (data) => {
        const { from, sdp } = data;
        if (!from || !sdp) return;
        console.log('[WebRTC] 收到 answer from', from);
        const pc = peerConnections[from];
        if (!pc) return;
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            console.log('[WebRTC] 已设置远端描述');
        } catch (e) {
            console.error('[WebRTC] 设置 answer 失败:', e);
        }
    });

    // ===== 接收 ICE candidate =====
    socket.on('webrtc-ice-candidate', async (data) => {
        const { from, candidate } = data;
        if (!from || !candidate) return;
        const pc = peerConnections[from];
        if (!pc) return;
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('[WebRTC] 添加 ICE candidate 失败:', e);
        }
    });

    // ===== 新用户加入房间（老用户收到通知，主动发起 offer）=====
    socket.on('webrtc-peer-joined', (data) => {
        const { socketId, name, isGhost: peerIsGhost } = data;
        if (socketId === mySocketId) return;
        console.log('[WebRTC] 新用户加入:', name, socketId);
        // 老用户主动发起 offer
        if (!isGhostMode || !peerIsGhost) {
            makeOffer(socketId);
        }
        // 更新成员列表
        if (!currentMembers.find(m => m.socketId === socketId)) {
            currentMembers.push({ socketId, name, peerUserId: socketId, isGhost: peerIsGhost });
            updateMemberCount();
        }
    });

    // ===== 有用户离开 =====
    socket.on('webrtc-peer-left', (data) => {
        const { socketId } = data;
        console.log('[WebRTC] 用户离开:', socketId);
        // 关闭 PeerConnection
        const pc = peerConnections[socketId];
        if (pc) {
            pc.close();
            delete peerConnections[socketId];
        }
        delete remoteStreams[socketId];
        // 清理 video 元素
        const mainContainer = document.getElementById('mainVideo');
        const video = mainContainer.querySelector('video');
        if (video) {
            // 如果还有其他用户，保留；否则清空
            const remaining = Object.keys(peerConnections);
            if (remaining.length === 0) {
                mainContainer.innerHTML = '';
                hideVoiceCallView();
                hasRemotePeer = false;
                // 通话对方已离开，自动返回首页（不再停留在等待界面）
                showToast('对方已结束通话');
                setTimeout(() => {
                    // 停止本地流
                    if (localStream) {
                        localStream.getTracks().forEach(t => t.stop());
                    }
                    if (screenShareStream) {
                        screenShareStream.getTracks().forEach(t => t.stop());
                    }
                    // 对方已挂断，清除通话状态并标记结束，避免 home 页仍显示通话横条
                    localStorage.removeItem('activeCallRoomId');
                    localStorage.removeItem('activeCallPeerName');
                    localStorage.removeItem('activeCallType');
                    localStorage.setItem('callEnded', '1');
                    try { if (window.AndroidApp && window.AndroidApp.setScreenShareButtonVisible) window.AndroidApp.setScreenShareButtonVisible(false); } catch(e) {}
                    window.location.href = '/';
                }, 1500);
            }
        }
        // 从成员列表移除
        currentMembers = currentMembers.filter(m => m.socketId !== socketId);
        updateMemberCount();
    });

    // ===== 成员管理 =====
    function updateMemberCount() {
        document.getElementById('memberCount').textContent = currentMembers.length || 1;
    }

    function showMembers() {
        document.getElementById('membersPanel').classList.add('show');
        renderMembers();
    }

    function hideMembers() {
        document.getElementById('membersPanel').classList.remove('show');
    }

    function renderMembers() {
        const list = document.getElementById('membersList');
        list.innerHTML = '';
        document.getElementById('membersCount').textContent = currentMembers.length || 1;
        currentMembers.forEach(m => {
            const isMe = m.socketId === mySocketId;
            const item = document.createElement('div');
            item.className = 'member-item';
            const avatarLetter = (m.name || '?').charAt(0);
            let tag = '';
            if (isHost) tag = '<div class="member-tag">房主</div>';
            else if (isMe) tag = '<div class="member-tag you">我</div>';
            item.innerHTML = `
                <div class="member-avatar">${avatarLetter}</div>
                <div class="member-info">
                    <div class="member-name">${m.name || '匿名'}${isMe ? ' (我)' : ''}</div>
                    ${tag}
                </div>
            `;
            list.appendChild(item);
        });
    }

    // ===== 语音通话头像界面 =====
    function showVoiceCallView(peerSocketId) {
        const view = document.getElementById('voiceCallView');
        if (!view) return;
        const selfVideo = document.getElementById('selfVideo');
        if (selfVideo) selfVideo.style.display = 'none';
        let peerName = '';
        try { peerName = localStorage.getItem('callPeerName') || ''; } catch(e) {}
        if (!peerName && currentMembers) {
            const m = currentMembers.find(x => x.socketId === peerSocketId);
            if (m) peerName = m.name || '';
        }
        if (!peerName) peerName = '对方';
        const avatarEl = document.getElementById('voiceCallAvatar');
        const initial = (peerName.charAt(0) || '?').toUpperCase();
        let avatarBase64 = '';
        try { avatarBase64 = localStorage.getItem('callPeerAvatar') || ''; } catch(e) {}
        if (avatarBase64) {
            avatarEl.innerHTML = '<img src="' + avatarBase64 + '" alt="">';
        } else {
            avatarEl.textContent = initial;
        }
        document.getElementById('voiceCallName').textContent = peerName;
        view.classList.add('show');
        startVoiceCallDurationTimer();
    }

    function hideVoiceCallView() {
        const view = document.getElementById('voiceCallView');
        if (view) view.classList.remove('show');
        const selfVideo = document.getElementById('selfVideo');
        if (selfVideo && !isGhostMode && !isVoiceCall) selfVideo.style.display = '';
        stopVoiceCallDurationTimer();
    }

    function startVoiceCallDurationTimer() {
        stopVoiceCallDurationTimer();
        const durationEl = document.getElementById('voiceCallDuration');
        if (!durationEl) return;
        let startTime = 0;
        try { startTime = parseInt(localStorage.getItem('callStartTime') || '0', 10); } catch(e) {}
        if (!startTime || isNaN(startTime)) startTime = Date.now();
        const update = () => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            if (elapsed < 0) { durationEl.textContent = '00:00'; return; }
            const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const ss = String(elapsed % 60).padStart(2, '0');
            durationEl.textContent = mm + ':' + ss;
        };
        update();
        voiceCallDurationTimer = setInterval(update, 1000);
    }

    function stopVoiceCallDurationTimer() {
        if (voiceCallDurationTimer) {
            clearInterval(voiceCallDurationTimer);
            voiceCallDurationTimer = null;
        }
    }

    // ===== 控制功能 =====
    window.toggleMute = function() {
        if (!localStream) return;
        const audioTracks = localStream.getAudioTracks();
        if (audioTracks.length === 0) return;
        micEnabled = !micEnabled;
        audioTracks.forEach(t => t.enabled = micEnabled);
        const btn = document.getElementById('muteToggle');
        const icon = btn.querySelector('.control-icon i');
        const label = btn.querySelector('.control-label');
        if (micEnabled) {
            icon.className = 'fa fa-microphone';
            label.textContent = '静音';
            btn.classList.remove('off');
        } else {
            icon.className = 'fa fa-microphone-slash';
            label.textContent = '取消静音';
            btn.classList.add('off');
        }
    };

    window.toggleVideo = function() {
        if (!localStream || isVoiceCall) return;
        const videoTracks = localStream.getVideoTracks();
        if (videoTracks.length === 0) return;
        cameraEnabled = !cameraEnabled;
        videoTracks.forEach(t => t.enabled = cameraEnabled);
        const btn = document.getElementById('videoToggle');
        const icon = btn.querySelector('.control-icon i');
        const label = btn.querySelector('.control-label');
        if (cameraEnabled) {
            icon.className = 'fa fa-video-camera';
            label.textContent = '视频';
            btn.classList.remove('off');
        } else {
            icon.className = 'fa fa-video-camera';
            label.textContent = '已关闭';
            btn.classList.add('off');
        }
    };

    window.switchCamera = async function() {
        if (!localStream || isVoiceCall) return;
        const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
        if (!isMobile) { showToast('仅手机支持翻转摄像头'); return; }
        currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: currentFacingMode },
                audio: true
            });
            // 替换本地流的视频轨道
            const oldVideoTrack = localStream.getVideoTracks()[0];
            const newVideoTrack = newStream.getVideoTracks()[0];
            if (oldVideoTrack) {
                localStream.removeTrack(oldVideoTrack);
                oldVideoTrack.stop();
            }
            localStream.addTrack(newVideoTrack);
            // 替换所有 PeerConnection 的视频轨道
            Object.values(peerConnections).forEach(pc => {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(newVideoTrack);
            });
            // 更新本地预览
            const selfVideo = document.getElementById('selfVideo').querySelector('video');
            if (selfVideo) {
                selfVideo.srcObject = localStream;
                safePlay(selfVideo);
            }
            showToast('已切换摄像头');
        } catch (e) {
            console.error('[切换摄像头失败]', e);
            showToast('切换摄像头失败', 'error');
        }
    };

    window.toggleScreenShare = async function() {
        const btn = document.getElementById('shareScreenToggle');
        // ===== Android 原生屏幕共享（getDisplayMedia 在 WebView 中不支持）=====
        const isAndroidNative = !!(window.AndroidApp && window.AndroidApp.isNativeApp && window.AndroidApp.isNativeApp());
        if (isAndroidNative && window.AndroidApp.startNativeScreenShare) {
            if (window.AndroidApp.isScreenSharing && window.AndroidApp.isScreenSharing()) {
                // 停止共享
                window.AndroidApp.stopNativeScreenShare();
                btn.classList.remove('active');
                const container = document.getElementById('screenShareContainer');
                container.classList.remove('show');
                container.innerHTML = '';
                hideScreenShareBanner();
                showToast('已停止屏幕共享');
            } else {
                // 启动共享
                window.AndroidApp.startNativeScreenShare();
                btn.classList.add('active');
                showToast('屏幕共享已开始');
            }
            return;
        }
        // ===== Web 端 getDisplayMedia =====
        if (screenShareStream) {
            // 先用 replaceTrack 恢复摄像头流（必须先替换再停止屏幕共享 track，否则对端会卡住不动）
            const camTrack = localStream ? localStream.getVideoTracks()[0] : null;
            if (camTrack) {
                // 保持摄像头 enabled 状态（用户可能关了摄像头，恢复后仍保持关闭状态）
                camTrack.enabled = cameraEnabled;
                const replacePromises = Object.values(peerConnections).map(pc => {
                    const senders = pc.getSenders().filter(s => s.track && s.track.kind === 'video');
                    return Promise.all(senders.map(s => s.replaceTrack(camTrack)));
                });
                try { await Promise.all(replacePromises); } catch(e) { console.warn('[屏幕共享停止] replaceTrack 失败', e); }
            }
            // 所有 PeerConnection 已恢复摄像头 track，再停止屏幕共享流
            screenShareStream.getTracks().forEach(t => t.stop());
            screenShareStream = null;
            btn.classList.remove('active');
            const container = document.getElementById('screenShareContainer');
            container.classList.remove('show');
            container.innerHTML = '';
            hideScreenShareBanner();
            showToast('已停止屏幕共享');
            return;
        }
        try {
            // 读取屏幕分享画质设置
            const sq = localStorage.getItem('screenQuality') || 'medium';
            const screenResMap = {
                low: { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 10 } },
                medium: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15 } },
                high: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24 } }
            };
            const screenRes = screenResMap[sq] || screenResMap.medium;
            screenShareStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always', ...screenRes },
                audio: false
            });
            // 替换所有 PeerConnection 的视频轨道为屏幕共享
            const screenTrack = screenShareStream.getVideoTracks()[0];
            Object.values(peerConnections).forEach(pc => {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(screenTrack);
            });
            // 监听用户从浏览器 UI 停止共享
            screenTrack.addEventListener('ended', () => {
                if (screenShareStream) window.toggleScreenShare();
            });
            btn.classList.add('active');
            showScreenShareBanner();
            showToast('屏幕共享已开始');
        } catch (e) {
            console.error('[屏幕共享失败]', e);
            showToast('屏幕共享失败', 'error');
        }
    };

    // ===== 屏幕分享提示条（分享方本地可见，其他人看不到）=====
    function showScreenShareBanner() {
        let banner = document.getElementById('screenShareBanner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'screenShareBanner';
            banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#fa5151;color:#fff;padding:8px 16px;font-size:13px;text-align:center;z-index:9999;display:flex;align-items:center;justify-content:center;gap:8px;';
            document.body.appendChild(banner);
        }
        banner.innerHTML = '<i class="fa fa-desktop"></i> 您正在分享屏幕，其他人可以看见您的屏幕';
        banner.style.display = 'flex';
    }
    function hideScreenShareBanner() {
        const banner = document.getElementById('screenShareBanner');
        if (banner) banner.style.display = 'none';
    }

    window.showMembers = showMembers;
    window.hideMembers = hideMembers;
    window.copyMeetingCode = copyMeetingCode;
    window.copyMeetingLink = copyMeetingLink;

    window.leaveMeeting = function() {
        if (!confirm('确定要离开会议吗？')) return;
        socket.emit('webrtc-leave', { roomId: ROOM_ID });
        // 关闭所有 PeerConnection
        Object.values(peerConnections).forEach(pc => pc.close());
        peerConnections = {};
        // 停止本地流
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
        }
        if (screenShareStream) {
            screenShareStream.getTracks().forEach(t => t.stop());
        }
        // 清除通话状态（已挂断）
        localStorage.removeItem('activeCallRoomId');
        localStorage.removeItem('activeCallPeerName');
        localStorage.removeItem('activeCallType');
        // 标记通话已结束，让 home 页发送通话总结消息
        localStorage.setItem('callEnded', '1');
        try { if (window.AndroidApp && window.AndroidApp.setScreenShareButtonVisible) window.AndroidApp.setScreenShareButtonVisible(false); } catch(e) {}
        window.location.href = '/';
    };

    // 返回聊天（在 room 页面内显示聊天 overlay，不跳转页面，保持通话）
    window.backToChat = function() {
        showChatOverlay();
    };

    // ===== 聊天 overlay（通话时返回聊天，不跳转页面保持 PeerConnection）=====
    let chatOverlayLoaded = false;
    let chatOverlayTimer = null;
    let chatOverlayStartTime = 0;
    let chatOverlayMyName = MY_NAME;

    function showChatOverlay() {
        const overlay = document.getElementById('chatOverlay');
        overlay.classList.add('show');
        // 更新通话状态文本
        const peerName = localStorage.getItem('activeCallPeerName') || '对方';
        const callType = localStorage.getItem('activeCallType') || 'voice';
        const typeLabel = callType === 'video' ? '视频通话' : '语音通话';
        document.getElementById('chatOverlayCallStatus').textContent = `正在和 ${peerName} ${typeLabel}中`;
        const icon = document.querySelector('.chat-overlay-call-icon');
        if (icon) icon.className = callType === 'video' ? 'fa fa-video-camera chat-overlay-call-icon' : 'fa fa-phone chat-overlay-call-icon';
        // 启动计时器
        const startTimeStr = localStorage.getItem('callStartTime');
        chatOverlayStartTime = startTimeStr ? parseInt(startTimeStr) : Date.now();
        updateChatOverlayTime();
        if (chatOverlayTimer) clearInterval(chatOverlayTimer);
        chatOverlayTimer = setInterval(updateChatOverlayTime, 1000);
        // 首次打开时注册用户并加载历史消息
        if (!chatOverlayLoaded) {
            chatOverlayLoaded = true;
            // 注册用户信息（chat-login 会自动返回 chat-history 和 chat-online-users）
            socket.emit('chat-login', { name: MY_NAME });
        }
        // 滚动到底部
        setTimeout(() => {
            const list = document.getElementById('chatOverlayList');
            list.scrollTop = list.scrollHeight;
        }, 100);
    }

    window.hideChatOverlay = function() {
        document.getElementById('chatOverlay').classList.remove('show');
        if (chatOverlayTimer) { clearInterval(chatOverlayTimer); chatOverlayTimer = null; }
    };

    function updateChatOverlayTime() {
        const elapsed = Math.floor((Date.now() - chatOverlayStartTime) / 1000);
        const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
        const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
        const s = String(elapsed % 60).padStart(2, '0');
        const el = document.getElementById('chatOverlayCallTime');
        if (el) el.textContent = `${h}:${m}:${s}`;
    }

    // 发送聊天消息
    window.sendChatOverlayMsg = function() {
        const input = document.getElementById('chatOverlayInput');
        const content = input.value.trim();
        if (!content) return;
        socket.emit('chat-send-message', { type: 'text', content });
        input.value = '';
    };

    // 监听聊天历史
    socket.on('chat-history', (data) => {
        const list = document.getElementById('chatOverlayList');
        if (!list) return;
        list.innerHTML = '';
        if (data && data.messages) {
            data.messages.forEach(msg => appendChatOverlayMsg(msg));
        }
        list.scrollTop = list.scrollHeight;
    });

    // 监听新消息
    socket.on('chat-message', (msg) => {
        appendChatOverlayMsg(msg);
        const list = document.getElementById('chatOverlayList');
        list.scrollTop = list.scrollHeight;
    });

    function appendChatOverlayMsg(msg) {
        const list = document.getElementById('chatOverlayList');
        if (!list) return;
        const isSelf = (msg.name === chatOverlayMyName) || (msg.senderName === chatOverlayMyName);
        const name = msg.senderName || msg.name || '匿名';
        const div = document.createElement('div');
        div.className = 'chat-overlay-msg' + (isSelf ? ' self' : '');
        // 头像
        const firstChar = (name || '?').charAt(0).toUpperCase();
        const colors = ['#07c160','#5765ec','#fa7268','#ff9c19','#00ae9d','#722ed1'];
        const colorIdx = name.charCodeAt(0) % colors.length;
        // 内容
        let contentHtml = '';
        if (msg.recalled) {
            contentHtml = '<span style="color:#999;font-style:italic;">消息已撤回</span>';
        } else if (msg.type === 'image') {
            contentHtml = '[图片]';
        } else if (msg.type === 'voice') {
            contentHtml = '[语音]';
        } else if (msg.type === 'video') {
            contentHtml = '[视频]';
        } else if (msg.type === 'call') {
            contentHtml = '[通话记录]';
        } else {
            contentHtml = (msg.content || '').replace(/</g,'&lt;').replace(/\n/g,'<br>');
        }
        const time = new Date(msg.timestamp || Date.now());
        const timeStr = `${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`;
        div.innerHTML = `
            <div class="chat-overlay-msg-avatar" style="background:${colors[colorIdx]}">${firstChar}</div>
            <div class="chat-overlay-msg-content">
                ${!isSelf ? `<div class="chat-overlay-msg-name">${name}</div>` : ''}
                <div class="chat-overlay-msg-bubble">${contentHtml}</div>
                <div class="chat-overlay-msg-time">${timeStr}</div>
            </div>
        `;
        list.appendChild(div);
    }

    // ===== 监听被移除 =====
    socket.on('kicked', (data) => {
        alert(data.reason);
        // 清除通话状态（被踢出时通话已结束）
        localStorage.removeItem('activeCallRoomId');
        localStorage.removeItem('activeCallPeerName');
        localStorage.removeItem('activeCallType');
        localStorage.setItem('callEnded', '1');
        window.location.href = '/';
    });

    socket.on('error-message', (data) => {
        showToast(data.message, 'error');
    });

    // ===== Socket.IO 连接 =====
    socket.on('connect', async () => {
        console.log('[Socket] 已连接, socketId:', socket.id);
        mySocketId = socket.id;
        // 获取本地媒体流
        await getLocalStream();
        // 加入 WebRTC 房间
        socket.emit('webrtc-join', {
            roomId: ROOM_ID,
            name: MY_NAME,
            isGhost: isGhostMode
        }, (res) => {
            if (res && res.error) {
                console.error('[加入房间失败]', res.error);
                showToast('加入房间失败', 'error');
                return;
            }
            console.log('[已加入房间]', ROOM_ID, '其他成员:', res?.members?.length || 0);
            // 同时加入 socket.io 原始房间（用于接收 native-screen-frame 广播）
            socket.emit('join-room', {
                roomID: ROOM_ID,
                peerUserId: 'web-' + mySocketId,
                isNative: false,
                name: MY_NAME
            });
            // 添加自己到成员列表
            currentMembers = [{
                socketId: mySocketId,
                name: MY_NAME,
                peerUserId: mySocketId,
                isGhost: isGhostMode
            }];
            // 添加已有成员（这些成员会主动向我们发起 offer）
            if (res && res.members) {
                res.members.forEach(m => {
                    if (!currentMembers.find(c => c.socketId === m.socketId)) {
                        currentMembers.push(m);
                    }
                });
            }
            updateMemberCount();
            // 如果房间内没有其他人，显示等待界面
            const others = currentMembers.filter(m => m.socketId !== mySocketId);
            if (others.length === 0 && !isGhostMode) {
                showWaitingScreen();
            } else {
                hideWaitingScreen();
            }
        });
    });

    // ===== 监听 Android 原生屏幕共享事件 =====
    socket.on('native-screen-share-start', (data) => {
        console.log('[屏幕共享] Android 端开始共享', data);
        const container = document.getElementById('screenShareContainer');
        if (container) {
            container.classList.add('show');
            container.innerHTML = '<div class="screen-share-label">📱 Android 屏幕共享中</div>';
        }
        showToast('对方正在共享屏幕');
    });

    socket.on('native-screen-frame', (data) => {
        if (!data || !data.frame) return;
        const container = document.getElementById('screenShareContainer');
        if (!container) return;
        // 显示/更新屏幕共享画面（base64 JPEG）
        let img = container.querySelector('img.screen-share-img');
        if (!img) {
            container.classList.add('show');
            container.innerHTML = '<div class="screen-share-label">📱 Android 屏幕共享中</div>';
            img = document.createElement('img');
            img.className = 'screen-share-img';
            img.style.cssText = 'width:100%;height:auto;max-height:70vh;object-fit:contain;';
            container.appendChild(img);
        }
        // 加 data: 前缀，避免浏览器把纯 base64 当作 URL 请求服务器（431 错误）
        img.src = (data.frame.indexOf('data:') === 0) ? data.frame : ('data:image/jpeg;base64,' + data.frame);
    });

    socket.on('native-screen-share-stop', (data) => {
        console.log('[屏幕共享] Android 端停止共享', data);
        const container = document.getElementById('screenShareContainer');
        if (container) {
            container.classList.remove('show');
            // 清除画面，避免最后一帧卡住
            const img = container.querySelector('img.screen-share-img');
            if (img) {
                img.src = '';
                img.remove();
            }
            container.innerHTML = '';
        }
        showToast('对方已停止共享屏幕');
    });

    socket.on('disconnect', () => {
        console.log('[Socket] 已断开');
    });

    socket.on('reconnect', () => {
        console.log('[Socket] 已重连');
    });

    // ===== 监控模式特殊处理 =====
    if (isGhostMode) {
        document.getElementById('selfVideo').style.display = 'none';
        document.getElementById('waitingScreen').style.display = 'none';
        document.getElementById('topBar').style.display = 'flex';
        document.getElementById('controlsBar').style.display = 'flex';
        const topBar = document.getElementById('topBar');
        const ghostTag = document.createElement('div');
        ghostTag.style.cssText = 'background:#722ed1;color:#fff;padding:4px 10px;border-radius:10px;font-size:11px;margin-left:8px;';
        ghostTag.textContent = '隐身监控中';
        topBar.querySelector('.top-bar-left').appendChild(ghostTag);
    }

    // ===== 页面卸载时清理 =====
    window.addEventListener('beforeunload', () => {
        socket.emit('webrtc-leave', { roomId: ROOM_ID });
        Object.values(peerConnections).forEach(pc => pc.close());
        if (localStream) localStream.getTracks().forEach(t => t.stop());
    });

    console.log('[WebRTC] 脚本已加载, roomId:', ROOM_ID, 'name:', MY_NAME, 'voice:', isVoiceCall);
})();
