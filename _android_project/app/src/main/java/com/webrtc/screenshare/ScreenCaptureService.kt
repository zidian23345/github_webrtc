package com.webrtc.screenshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.emitter.Emitter
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * 屏幕捕获前台服务（稳定性增强版）
 *
 * 防止被 OPPO/小米/华为 等国产 ROM 杀掉的策略：
 * 1. 使用 WakeLock 保持 CPU 唤醒
 * 2. 通知优先级提升到 HIGH（高可见度，系统不易清理）
 * 3. 持久化 MediaProjection 状态（resultCode + data），服务被杀重启后可恢复
 * 4. onTaskRemoved 时重启服务
 * 5. START_STICKY + 状态恢复机制
 * 6. socket.io 自动重连
 *
 * 性能优化：
 * - 帧率限制：约 8-10 FPS（屏幕共享不需要高帧率）
 * - JPEG 压缩：质量 60%（平衡画质和带宽）
 * - 分辨率：宽度 720px（保持宽高比）
 */
class ScreenCaptureService : Service() {

    companion object {
        private const val TAG = "ScreenCapture"
        private const val NOTIFICATION_ID = 1001
        private const val TARGET_WIDTH = 720  // 目标宽度，按比例缩放
        private const val JPEG_QUALITY = 60   // JPEG 压缩质量
        private const val MIN_FRAME_INTERVAL_MS = 100L  // 最小帧间隔（10 FPS）

        // ===== 持久化状态：服务被杀重启后可以恢复 =====
        @Volatile
        var savedResultCode: Int = 0
        @Volatile
        var savedData: Intent? = null
        @Volatile
        var savedRoomId: String? = null
        @Volatile
        var savedSocketUrl: String? = null
        @Volatile
        var isRunning = false  // 标记服务是否正在运行

        private const val CHANNEL_ID = "screen_capture_channel"
    }

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var socket: Socket? = null
    private var roomId: String? = null
    private var socketUrl: String? = null

    private val handler = Handler(Looper.getMainLooper())
    private var lastFrameTime = 0L
    private var isCapturing = false

    // WakeLock：防止 CPU 休眠导致帧捕获停止
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        acquireWakeLock()
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "onStartCommand, intent=$intent, isCapturing=$isCapturing")

        // 停止服务
        if (intent?.action == "STOP") {
            stopScreenCapture()
            return START_NOT_STICKY
        }

        // ===== 情况 1：正常启动（带参数）=====
        if (intent != null) {
            val resultCode = intent.getIntExtra("resultCode", 0)
            val data = intent.getParcelableExtra<Intent>("data")
            roomId = intent.getStringExtra("roomId")
            socketUrl = intent.getStringExtra("socketUrl")

            if (data != null && resultCode != 0 && roomId != null) {
                // 持久化状态（用于服务被杀后恢复）
                savedResultCode = resultCode
                savedData = data
                savedRoomId = roomId
                savedSocketUrl = socketUrl

                Log.d(TAG, "正常启动: room=$roomId, socketUrl=$socketUrl")

                // 启动前台通知（必须最先调用）
                startForegroundNotification()

                // 如果已经初始化过 socket 且连接正常，直接重启捕获
                if (socket?.connected() == true && isCapturing) {
                    Log.d(TAG, "socket 已连接且正在捕获，忽略重复启动")
                    return START_STICKY
                }

                // 初始化 socket.io
                initSocket(socketUrl ?: ServerConfig.DEFAULT_SERVER_URL) {
                    joinRoom(roomId!!)
                    // 如果尚未捕获，启动捕获
                    if (!isCapturing) {
                        startCapture(resultCode, data)
                    }
                }
                return START_STICKY
            }
        }

        // ===== 情况 2：服务被系统重启（intent == null），使用持久化状态恢复 =====
        if (intent == null && savedData != null && savedResultCode != 0 && savedRoomId != null) {
            Log.d(TAG, "服务被系统重启，尝试恢复: room=$savedRoomId")
            roomId = savedRoomId
            socketUrl = savedSocketUrl

            startForegroundNotification()

            initSocket(socketUrl ?: ServerConfig.DEFAULT_SERVER_URL) {
                joinRoom(roomId!!)
                if (!isCapturing) {
                    startCapture(savedResultCode, savedData!!)
                }
            }
            return START_STICKY
        }

        // ===== 情况 3：无法恢复，停止 =====
        Log.e(TAG, "缺少必要参数且无持久化状态，停止服务")
        stopSelf()
        return START_NOT_STICKY
    }

    /**
     * 获取 WakeLock 防止 CPU 休眠
     */
    private fun acquireWakeLock() {
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "WebRTC::ScreenCaptureWakeLock"
            )
            wakeLock?.setReferenceCounted(false)
            wakeLock?.acquire(10 * 60 * 60 * 1000L) // 最多持有 10 小时，防止泄漏
            Log.d(TAG, "WakeLock 已获取")
        } catch (e: Exception) {
            Log.e(TAG, "获取 WakeLock 失败", e)
        }
    }

    /**
     * 释放 WakeLock
     */
    private fun releaseWakeLock() {
        try {
            wakeLock?.let {
                if (it.isHeld) {
                    it.release()
                }
            }
            wakeLock = null
        } catch (e: Exception) {
            Log.e(TAG, "释放 WakeLock 失败", e)
        }
    }

    /**
     * 启动前台通知（兼容 Android 14+ 的 foregroundServiceType）
     */
    private fun startForegroundNotification() {
        val notification = createNotification()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ 必须指定 foregroundServiceType
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /**
     * 创建通知渠道（Android 8.0+ 必需）
     * 提升优先级到 HIGH，减少被系统清理的概率
     */
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // 删除旧的低优先级渠道
            val manager = getSystemService(NotificationManager::class.java)
            manager.deleteNotificationChannel(getString(R.string.notification_channel_id))

            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_HIGH  // 提升到 HIGH
            ).apply {
                description = "屏幕共享服务运行中"
                setShowBadge(false)
                enableVibration(false)
            }
            manager.createNotificationChannel(channel)
        }
    }

    /**
     * 创建前台通知
     * 带点击返回应用的 PendingIntent
     */
    private fun createNotification(): Notification {
        // 点击通知返回主界面
        val contentIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, contentIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH)
        }

        return builder
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build()
    }

    /**
     * 初始化 socket.io 连接（带自签名证书支持）
     * 使用 OkHttp 客户端信任所有证书
     */
    private fun initSocket(socketUrl: String, onConnected: () -> Unit) {
        // 如果 socket 已存在且已连接，直接回调
        if (socket?.connected() == true) {
            onConnected()
            return
        }

        try {
            val okHttpClient = createTrustingHttpClient()

            val options = IO.Options().apply {
                reconnection = true
                reconnectionAttempts = Int.MAX_VALUE  // 无限重连
                reconnectionDelay = 1000
                reconnectionDelayMax = 5000
                timeout = 10000
                callFactory = okHttpClient
            }
            socket = IO.socket(socketUrl, options)

            var hasConnectedOnce = false
            socket?.on(Socket.EVENT_CONNECT, Emitter.Listener {
                Log.d(TAG, "socket.io 已连接")
                if (!hasConnectedOnce) {
                    hasConnectedOnce = true
                    onConnected()
                }
            })

            socket?.on("reconnect", Emitter.Listener {
                Log.d(TAG, "socket.io 已重连")
                // 重连后重新加入房间
                roomId?.let { joinRoom(it) }
                // 通知服务器重新开始屏幕共享
                socket?.emit("native-screen-share-start", JSONObject().apply {
                    put("roomID", roomId)
                })
            })

            socket?.on(Socket.EVENT_DISCONNECT, Emitter.Listener {
                Log.w(TAG, "socket.io 已断开")
            })

            socket?.on(Socket.EVENT_CONNECT_ERROR, Emitter.Listener { args ->
                Log.e(TAG, "socket.io 连接错误: ${args[0]}")
            })

            socket?.connect()

        } catch (e: Exception) {
            Log.e(TAG, "初始化 socket.io 失败", e)
        }
    }

    /**
     * 创建信任所有证书的 OkHttpClient（用于自签名 HTTPS 服务器）
     */
    private fun createTrustingHttpClient(): OkHttpClient {
        val trustManager = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }

        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf<TrustManager>(trustManager), java.security.SecureRandom())

        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .hostnameVerifier { _, _ -> true }
            .build()
    }

    /**
     * 加入 socket.io 房间
     */
    private fun joinRoom(roomId: String) {
        if (socket?.connected() == true) {
            val data = JSONObject().apply {
                put("roomID", roomId)
                put("peerUserId", "android-screen-share")
                put("isNative", true)
                put("isScreenShareSource", true)
            }
            socket?.emit("join-room", data)
            Log.d(TAG, "已加入房间: $roomId")
        }
    }

    /**
     * 开始屏幕捕获
     */
    private fun startCapture(resultCode: Int, data: Intent) {
        try {
            // 清理旧的 MediaProjection
            if (mediaProjection != null) {
                Log.d(TAG, "清理旧的 MediaProjection")
                virtualDisplay?.release()
                virtualDisplay = null
                imageReader?.setOnImageAvailableListener(null, null)
                imageReader?.close()
                imageReader = null
                mediaProjection?.stop()
                mediaProjection = null
            }

            val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            mediaProjection = projectionManager.getMediaProjection(resultCode, data)

            mediaProjection?.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.d(TAG, "MediaProjection 已停止")
                    // 不要立即停止服务，让 socket 重连逻辑处理
                    isCapturing = false
                }
            }, handler)

            // 获取屏幕尺寸
            val metrics = resources.displayMetrics
            val screenWidth = metrics.widthPixels
            val screenHeight = metrics.heightPixels

            // 按目标宽度等比缩放
            val targetWidth = TARGET_WIDTH
            val targetHeight = (screenHeight.toFloat() / screenWidth.toFloat() * targetWidth).toInt()

            Log.d(TAG, "屏幕尺寸: ${screenWidth}x${screenHeight}, 捕获尺寸: ${targetWidth}x${targetHeight}")

            // 创建 ImageReader
            imageReader = ImageReader.newInstance(
                targetWidth,
                targetHeight,
                PixelFormat.RGBA_8888,
                2  // 最多缓存 2 帧
            )

            imageReader?.setOnImageAvailableListener({ reader ->
                val now = System.currentTimeMillis()
                if (now - lastFrameTime < MIN_FRAME_INTERVAL_MS) {
                    // 帧率限制：跳过这一帧
                    val image = reader.acquireLatestImage()
                    image?.close()
                    return@setOnImageAvailableListener
                }
                lastFrameTime = now

                if (!isCapturing) return@setOnImageAvailableListener

                val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                try {
                    processAndSendFrame(image)
                } catch (e: Exception) {
                    Log.e(TAG, "处理帧失败", e)
                } finally {
                    image.close()
                }
            }, handler)

            // 创建 VirtualDisplay
            virtualDisplay = mediaProjection?.createVirtualDisplay(
                "ScreenCapture",
                targetWidth,
                targetHeight,
                metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader?.surface,
                null,
                handler
            )

            isCapturing = true
            Log.d(TAG, "屏幕捕获已启动")

            // 通知服务器开始屏幕共享
            socket?.emit("native-screen-share-start", JSONObject().apply {
                put("roomID", roomId)
            })

        } catch (e: Exception) {
            Log.e(TAG, "启动屏幕捕获失败", e)
            // 不要立即停止服务，让重连逻辑处理
            isCapturing = false
        }
    }

    /**
     * 处理帧：转为 JPEG 并发送
     */
    private fun processAndSendFrame(image: Image) {
        val planes = image.planes
        val buffer = planes[0].buffer
        val pixelStride = planes[0].pixelStride
        val rowStride = planes[0].rowStride
        val rowPadding = rowStride - pixelStride * image.width

        // 创建 Bitmap
        val bitmap = Bitmap.createBitmap(
            image.width + rowPadding / pixelStride,
            image.height,
            Bitmap.Config.ARGB_8888
        )
        bitmap.copyPixelsFromBuffer(buffer)

        // 裁剪掉 padding 部分
        val croppedBitmap = if (rowPadding > 0) {
            Bitmap.createBitmap(bitmap, 0, 0, image.width, image.height)
        } else {
            bitmap
        }

        // 转为 JPEG
        val outputStream = ByteArrayOutputStream()
        croppedBitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, outputStream)
        val jpegBytes = outputStream.toByteArray()

        // 释放 Bitmap
        if (croppedBitmap != bitmap) {
            croppedBitmap.recycle()
        }
        bitmap.recycle()

        // 发送到服务器
        sendFrame(jpegBytes)
    }

    /**
     * 发送帧到服务器
     */
    private fun sendFrame(jpegBytes: ByteArray) {
        if (socket?.connected() != true || roomId == null) return

        // 用 base64 编码发送
        val base64 = android.util.Base64.encodeToString(jpegBytes, android.util.Base64.NO_WRAP)

        val data = JSONObject().apply {
            put("roomID", roomId)
            put("frame", base64)
            put("timestamp", System.currentTimeMillis())
        }

        socket?.emit("native-screen-frame", data)
    }

    /**
     * 停止屏幕捕获
     * 确保先通知服务器停止，再清理资源
     */
    private fun stopScreenCapture() {
        isCapturing = false
        isRunning = false

        // 先通知服务器停止屏幕共享（在 socket 断开之前）
        try {
            if (socket?.connected() == true && roomId != null) {
                socket?.emit("native-screen-share-stop", JSONObject().apply {
                    put("roomID", roomId)
                })
                Log.d(TAG, "已发送 native-screen-share-stop")
            }
        } catch (e: Exception) {
            Log.e(TAG, "发送停止通知失败", e)
        }

        virtualDisplay?.release()
        virtualDisplay = null

        imageReader?.setOnImageAvailableListener(null, null)
        imageReader?.close()
        imageReader = null

        mediaProjection?.stop()
        mediaProjection = null

        // 延迟断开 socket，确保停止事件已发送
        handler.postDelayed({
            socket?.disconnect()
            socket?.off()
            socket = null
        }, 500)

        // 清理持久化状态
        savedData = null
        savedResultCode = 0
        savedRoomId = null
        savedSocketUrl = null

        releaseWakeLock()

        Log.d(TAG, "屏幕捕获已停止")
        stopForeground(true)
        stopSelf()
    }

    /**
     * 当用户从最近任务列表划掉应用时调用
     * 重新启动服务以保持屏幕共享继续
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.d(TAG, "onTaskRemoved, 重启服务")
        // 重启服务
        if (isCapturing && savedData != null) {
            val restartIntent = Intent(applicationContext, ScreenCaptureService::class.java).apply {
                action = "RESTART"
                putExtra("resultCode", savedResultCode)
                putExtra("data", savedData)
                putExtra("roomId", savedRoomId)
                putExtra("socketUrl", savedSocketUrl)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(restartIntent)
            } else {
                startService(restartIntent)
            }
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        Log.d(TAG, "服务 onDestroy")
        // 如果不是因为主动停止而销毁，保留状态以便系统重启
        if (isCapturing) {
            Log.d(TAG, "服务被系统销毁，状态已保留，等待系统重启")
            // 不调用 stopScreenCapture，让系统重启后恢复
            releaseWakeLock()
        } else {
            stopScreenCapture()
        }
    }
}
