package com.webrtc.screenshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.emitter.Emitter
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * 聊天消息后台常驻服务
 *
 * 功能：
 * 1. 保持 socket.io 长连接，即使应用在后台也能接收消息
 * 2. 收到消息时显示系统通知（类似微信）
 * 3. 前台服务保活，防止被系统杀死
 *
 * 工作原理：
 * - MainActivity 在 onResume 时绑定此服务（不启动新连接）
 * - MainActivity 在 onPause 时解绑但服务继续运行（保持连接）
 * - 只有用户主动退出应用时才停止服务
 */
class ChatNotificationService : Service() {

    companion object {
        private const val TAG = "ChatService"
        private const val NOTIFICATION_ID = 2001
        private const val CALL_NOTIFICATION_ID = 8888  // 来电通知专用 ID（固定，便于取消）
        private const val CHANNEL_ID = "chat_message_channel"
        private const val CHANNEL_ID_SILENT = "chat_message_silent"

        @Volatile
        var isRunning = false
            private set

        @Volatile
        var socket: Socket? = null
            private set

        @Volatile
        var currentUserName: String = ""
            private set

        @Volatile
        var isAppInForeground = false  // 应用是否在前台
            private set

        /**
         * 通知服务应用的前后台状态
         * MainActivity 在 onResume/onPause 时调用
         */
        fun setAppInForeground(value: Boolean) {
            isAppInForeground = value
            Log.d(TAG, "应用前台状态: $value")
        }

        /**
         * 静态清除来电通知（无需 service 实例）
         */
        fun dismissCallNotification(context: Context) {
            try {
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                manager.cancel(CALL_NOTIFICATION_ID)
                Log.d(TAG, "已清除来电通知（静态）")
            } catch (e: Exception) {
                Log.e(TAG, "清除来电通知失败", e)
            }
        }
    }

    /**
     * 显示来电通知（用固定 ID，新通知覆盖旧的）
     */
    private fun showCallNotification(fromName: String, content: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(fromName)
            .setContentText(content)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setSound(soundUri)
            .setDefaults(Notification.DEFAULT_VIBRATE or Notification.DEFAULT_LIGHTS)
            .setOngoing(true)  // 来电通知常驻，直到用户操作
            .build()

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(CALL_NOTIFICATION_ID, notification)
        Log.d(TAG, "显示来电通知: $fromName - $content")
    }

    /**
     * 清除来电通知（通话结束/取消/拒绝/接听时调用）
     */
    fun dismissCallNotification() {
        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.cancel(CALL_NOTIFICATION_ID)
            Log.d(TAG, "已清除来电通知")
        } catch (e: Exception) {
            Log.e(TAG, "清除来电通知失败", e)
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var serverUrl: String = ""

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        createNotificationChannels()
        Log.d(TAG, "聊天服务已创建")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "onStartCommand")

        if (intent?.action == "STOP") {
            stopSelf()
            return START_NOT_STICKY
        }

        // 获取服务器地址
        serverUrl = ServerConfig.getServerUrl(this)
        currentUserName = ServerConfig.getUserName(this)

        // 启动前台通知
        startForegroundNotification("聊天服务运行中")

        // 初始化 socket 连接
        if (socket == null || socket?.connected() != true) {
            initSocket()
        }

        return START_STICKY  // 服务被杀后自动重启
    }

    /**
     * 初始化 socket.io 连接
     */
    private fun initSocket() {
        if (serverUrl.isEmpty()) {
            Log.e(TAG, "服务器地址为空")
            return
        }

        try {
            val okHttpClient = createTrustingHttpClient()

            val options = IO.Options().apply {
                reconnection = true
                reconnectionAttempts = Int.MAX_VALUE
                reconnectionDelay = 1000
                reconnectionDelayMax = 5000
                timeout = 10000
                callFactory = okHttpClient
            }

            socket = IO.socket(serverUrl, options)

            socket?.on(Socket.EVENT_CONNECT, Emitter.Listener {
                Log.d(TAG, "socket.io 已连接")
                if (currentUserName.isNotEmpty()) {
                    val data = JSONObject().apply {
                        put("name", currentUserName)
                    }
                    socket?.emit("chat-login", data)
                }
            })

            socket?.on("chat-message", Emitter.Listener { args ->
                try {
                    val msg = args[0] as JSONObject
                    val type = msg.optString("type")
                    val name = msg.optString("name")
                    val content = msg.optString("content")
                    val socketId = msg.optString("socketId")

                    // 系统消息不通知
                    if (type == "system") return@Listener

                    // 自己发的消息不通知
                    if (socketId == socket?.id()) return@Listener

                    // 应用在前台时不显示通知（WebView 会处理）
                    if (isAppInForeground) return@Listener

                    // 显示通知：对非文本类型做转义，避免语音/视频的 base64 内容显示为乱码
                    val displayContent = when (type) {
                        "image" -> "[图片]"
                        "voice" -> "[语音]"
                        "video" -> "[视频]"
                        "call" -> "[通话记录]"
                        else -> content
                    }
                    showChatNotification(name, displayContent)
                } catch (e: Exception) {
                    Log.e(TAG, "处理消息失败", e)
                }
            })

            // 来电通知：app 在后台时收到呼叫邀请，显示高优先级通知
            socket?.on("call-incoming", Emitter.Listener { args ->
                try {
                    val data = args[0] as JSONObject
                    val fromName = data.optString("fromName")
                    val callType = data.optString("callType", "video")
                    // 前台时 WebView 会处理来电弹窗，不重复通知
                    if (isAppInForeground) return@Listener
                    val typeLabel = if (callType == "video") "视频通话" else "语音通话"
                    showCallNotification(fromName, "来电 · $typeLabel")
                } catch (e: Exception) {
                    Log.e(TAG, "处理来电通知失败", e)
                }
            })

            // 主叫取消呼叫：清除来电通知
            socket?.on("call-cancelled", Emitter.Listener {
                try {
                    dismissCallNotification()
                    Log.d(TAG, "主叫取消呼叫，已清除来电通知")
                } catch (e: Exception) {
                    Log.e(TAG, "处理通话取消失败", e)
                }
            })

            // 通话结束：清除来电通知
            socket?.on("call-ended", Emitter.Listener {
                try {
                    dismissCallNotification()
                } catch (e: Exception) {
                    Log.e(TAG, "处理通话结束失败", e)
                }
            })

            // 私聊消息通知：app 在后台时收到好友私信
            socket?.on("private-message", Emitter.Listener { args ->
                try {
                    val msg = args[0] as JSONObject
                    val type = msg.optString("type")
                    val sender = msg.optString("sender")
                    val fromName = msg.optString("from")
                    val name = if (sender.isNotEmpty()) sender else fromName
                    val content = msg.optString("content")
                    // 前台时 WebView 会处理，不重复通知
                    if (isAppInForeground) return@Listener
                    val displayContent = when (type) {
                        "image" -> "[图片]"
                        "voice" -> "[语音]"
                        "video" -> "[视频]"
                        "call" -> "[通话记录]"
                        else -> content
                    }
                    showChatNotification(name, displayContent)
                } catch (e: Exception) {
                    Log.e(TAG, "处理私聊消息通知失败", e)
                }
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
     * 创建通知渠道
     */
    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)

            // 常驻服务渠道（静默）
            val serviceChannel = NotificationChannel(
                CHANNEL_ID_SILENT,
                "聊天服务",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "保持聊天服务运行"
                setShowBadge(false)
            }
            manager.createNotificationChannel(serviceChannel)

            // 消息通知渠道（有声音）
            val messageChannel = NotificationChannel(
                CHANNEL_ID,
                "聊天消息",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "接收新消息通知"
                enableVibration(true)
                enableLights(true)
                // 设置默认通知铃声（确保有声音提示）
                val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                val attrs = AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build()
                setSound(soundUri, attrs)
                // 锁屏时显示完整内容
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            manager.createNotificationChannel(messageChannel)
        }
    }

    /**
     * 启动前台通知（保活）
     */
    private fun startForegroundNotification(text: String) {
        val notification = Notification.Builder(this, CHANNEL_ID_SILENT)
            .setContentTitle("聊天服务")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /**
     * 显示聊天消息通知
     */
    private fun showChatNotification(senderName: String, content: String) {
        // 点击通知跳转到 MainActivity
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)

        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(senderName)
            .setContentText(content)
            .setSmallIcon(R.mipmap.ic_launcher)  // 用应用图标
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setSound(soundUri)  // 通知声音
            .setDefaults(Notification.DEFAULT_VIBRATE or Notification.DEFAULT_LIGHTS)  // 震动和灯效
            .build()

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // 用消息内容的 hashcode 作为通知 ID，避免覆盖
        manager.notify((senderName + content).hashCode() and 0x7fffffff, notification)

        Log.d(TAG, "显示通知: $senderName - $content")
    }

    /**
     * 创建信任所有证书的 OkHttpClient
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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.d(TAG, "onTaskRemoved, 重启服务")
        // 应用被划掉后肯定不在前台了，必须重置标志，否则后续消息不会通知
        setAppInForeground(false)
        // 用户从最近任务划掉应用时，重启服务保持连接
        val restartIntent = Intent(applicationContext, ChatNotificationService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(restartIntent)
        } else {
            startService(restartIntent)
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        Log.d(TAG, "聊天服务已销毁")
    }
}
