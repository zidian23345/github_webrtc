package com.webrtc.screenshare

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import android.net.http.SslError
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.ValueCallback
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient.FileChooserParams
import android.widget.Button
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.emitter.Emitter
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.net.URISyntaxException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * 主界面：WebView 显示网页 + 屏幕共享按钮
 *
 * 工作原理：
 * 1. WebView 加载服务器网页（视频通话、聊天功能用网页版）
 * 2. 用户点击"开始共享屏幕"按钮，启动 MediaProjection
 * 3. ScreenCaptureService 捕获屏幕帧，通过 socket.io 发送到服务器
 * 4. 服务器转发帧给房间内其他网页端客户端
 *
 * 稳定性增强：
 * - 请求电池优化白名单（防止 OPPO/小米/华为杀后台）
 * - onResume 时恢复视频轨道（防止屏幕共享后视频冻结）
 * - 注入用户名称到 WebView
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "WebRTC-Main"
        private const val REQ_SETTINGS = 1001
        private const val REQ_BATTERY_OPTIMIZATION = 1002
    }

    private lateinit var webView: WebView
    private lateinit var btnShareScreen: Button
    private lateinit var btnSettings: ImageButton
    private lateinit var connectionStatus: TextView

    // ===== 服务器离线页面相关 =====
    private lateinit var offlinePage: android.view.View
    private lateinit var offlineServerUrl: TextView
    private lateinit var btnRetry: Button
    private lateinit var btnOpenSettings: Button
    private lateinit var autoRetryHint: TextView
    private lateinit var retryingProgress: android.widget.ProgressBar
    private var autoRetryRunnable: Runnable? = null
    private var isPageLoadedSuccess = false  // 标记当前页面是否加载成功
    private var hadLoadError = false  // 标记本次加载是否发生过错误（防止 onPageFinished 误判）

    private var socket: Socket? = null
    private var isSharing = false
    private var currentRoomId: String? = null

    // WebView 文件选择回调（<input type="file"> 触发）
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    // 服务器地址（从配置读取）
    private var serverUrl: String = ""
    private var socketUrl: String = ""

    // MediaProjection 权限请求
    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            startScreenCapture(result.resultCode, result.data!!)
        } else {
            Toast.makeText(this, "屏幕共享需要授权", Toast.LENGTH_SHORT).show()
            updateShareButton()
        }
    }

    // 文件选择器（网页 <input type="file"> 点击时由 WebChromeClient.onShowFileChooser 触发）
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        val uris: Array<Uri>? = if (result.resultCode == Activity.RESULT_OK) {
            val intent = result.data
            if (intent != null && intent.data != null) {
                arrayOf(intent.data!!)
            } else if (intent != null && intent.clipData != null) {
                val count = intent.clipData!!.itemCount
                Array(count) { i -> intent.clipData!!.getItemAt(i).uri }
            } else {
                null
            }
        } else null
        callback.onReceiveValue(uris)
        filePathCallback = null
    }

    // ===== 原生相机拍摄（JS Bridge 调用）=====
    // WebView 不支持 <input capture>，通过 AndroidApp.takePhoto(callbackId) 调起系统相机
    private var takePhotoCallbackId: String? = null
    private val takePhotoLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callbackId = takePhotoCallbackId ?: return@registerForActivityResult
        takePhotoCallbackId = null
        if (result.resultCode != Activity.RESULT_OK) {
            webView.post {
                webView.evaluateJavascript("window.__takePhotoResult && window.__takePhotoResult('$callbackId', null)", null)
            }
            return@registerForActivityResult
        }
        // 相机返回缩略图 Bitmap（未指定 EXTRA_OUTPUT 时）
        val bitmap = result.data?.extras?.get("data") as? Bitmap
        if (bitmap == null) {
            webView.post {
                webView.evaluateJavascript("window.__takePhotoResult && window.__takePhotoResult('$callbackId', null)", null)
            }
            return@registerForActivityResult
        }
        try {
            val baos = java.io.ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 85, baos)
            val base64 = android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP)
            val dataUrl = "data:image/jpeg;base64,$base64"
            webView.post {
                webView.evaluateJavascript("window.__takePhotoResult && window.__takePhotoResult('$callbackId', '$dataUrl')", null)
            }
        } catch (e: Exception) {
            Log.e(TAG, "相机拍照处理失败", e)
            webView.post {
                webView.evaluateJavascript("window.__takePhotoResult && window.__takePhotoResult('$callbackId', null)", null)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // 全屏模式：只隐藏导航栏，保留顶部状态栏（可看到时间/电量/信号）
        // 注意：这里不能调用 setDecorFitsSystemWindows(false)（edge-to-edge 模式会禁用
        // manifest 里的 adjustResize，软键盘弹出时窗口不再缩小，键盘直接盖住网页输入框）。
        // 保持默认 decorFits=true：内容自动避让状态栏，顶部显示时间，
        // 同时键盘弹出时 adjustResize 正常生效，WebView 缩小、输入框抬到键盘上方
        enterImmersiveMode()

        // 初始化视图
        webView = findViewById(R.id.webView)
        btnShareScreen = findViewById(R.id.btnShareScreen)
        btnSettings = findViewById(R.id.btnSettings)
        connectionStatus = findViewById(R.id.connectionStatus)

        // 初始化离线页面视图
        offlinePage = findViewById(R.id.offlinePage)
        offlineServerUrl = findViewById(R.id.offlineServerUrl)
        btnRetry = findViewById(R.id.btnRetry)
        btnOpenSettings = findViewById(R.id.btnOpenSettings)
        autoRetryHint = findViewById(R.id.autoRetryHint)
        retryingProgress = findViewById(R.id.retryingProgress)

        // 默认隐藏屏幕共享按钮，仅在通话中显示（避免在主界面误触）
        btnShareScreen.visibility = android.view.View.GONE

        // 离线页面按钮事件
        btnRetry.setOnClickListener {
            Log.d(TAG, "用户点击重试连接")
            retryLoadServerPage()
        }
        btnOpenSettings.setOnClickListener {
            startActivityForResult(Intent(this, SettingsActivity::class.java), REQ_SETTINGS)
        }

        // 读取服务器配置
        loadServerConfig()

        // 配置 WebView
        setupWebView()

        // 加载服务器页面
        loadServerPage()

        // 初始化 socket.io 连接
        initSocket()

        // 屏幕共享按钮点击事件
        btnShareScreen.setOnClickListener {
            if (isSharing) {
                stopScreenCapture()
            } else {
                requestScreenCapturePermission()
            }
        }

        // 设置按钮（小扳手）：可拖动到屏幕任意位置，轻点仍打开设置
        setupSettingsButtonDrag()

        // 请求运行时权限：摄像头、麦克风、通知（Android 13+）
        requestRuntimePermissions()

        // 请求电池优化白名单（防止服务被杀）
        requestBatteryOptimizationExemption()

        // 启动聊天消息后台常驻服务（类似微信保活）
        startChatService()
    }

    /**
     * 启动聊天消息后台常驻服务
     */
    private fun startChatService() {
        val serviceIntent = Intent(this, ChatNotificationService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
        Log.d(TAG, "已启动聊天后台服务")
    }

    /**
     * 停止聊天服务（用户主动退出时）
     */
    private fun stopChatService() {
        val serviceIntent = Intent(this, ChatNotificationService::class.java).apply {
            action = "STOP"
        }
        startService(serviceIntent)
    }

    override fun onResume() {
        super.onResume()
        // 通知聊天服务应用已回到前台（不显示通知）
        ChatNotificationService.setAppInForeground(true)
        // 回到前台时清除来电通知（WebView 会处理来电弹窗）
        ChatNotificationService.dismissCallNotification(this)
        // 从后台返回时，尝试恢复视频轨道
        if (currentRoomId != null && !isSharing) {
            handler.postDelayed({
                resumeVideoTracks()
            }, 500)
        }
    }

    override fun onPause() {
        super.onPause()
        // 通知聊天服务应用已进入后台（显示通知）
        ChatNotificationService.setAppInForeground(false)
    }

    /**
     * 请求电池优化白名单
     * OPPO/小米/华为 等国产 ROM 会积极杀后台服务，必须加入白名单
     */
    private fun requestBatteryOptimizationExemption() {
        try {
            val powerManager = getSystemService(POWER_SERVICE) as PowerManager
            val packageName = packageName

            // 检查是否已在白名单中
            if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
                Log.d(TAG, "应用未在电池优化白名单中，请求加入")
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivityForResult(intent, REQ_BATTERY_OPTIMIZATION)
            } else {
                Log.d(TAG, "应用已在电池优化白名单中")
            }
        } catch (e: Exception) {
            Log.e(TAG, "请求电池优化白名单失败", e)
            // 某些 ROM 可能不支持此 intent，直接忽略
        }
    }

    /**
     * 请求摄像头、麦克风、通知权限
     * WebRTC 视频通话必须先获得摄像头和麦克风权限
     */
    private fun requestRuntimePermissions() {
        val permissions = mutableListOf<String>()
        permissions.add(Manifest.permission.CAMERA)
        permissions.add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val toRequest = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (toRequest.isNotEmpty()) {
            requestPermissions(toRequest.toTypedArray(), 100)
            Log.d(TAG, "请求权限: $toRequest")
        } else {
            Log.d(TAG, "所有权限已授予")
        }
    }

    /**
     * 读取服务器配置
     * 如果是首次运行或用户名为空，跳转到设置界面强制输入名称
     */
    private fun loadServerConfig() {
        serverUrl = ServerConfig.getServerUrl(this)
        socketUrl = serverUrl
        // 首次运行 或 用户名为空 或 服务器地址为空（未配置）时强制跳设置页
        if (ServerConfig.isFirstRun(this) || ServerConfig.getUserName(this).isEmpty() || serverUrl.isEmpty()) {
            val intent = Intent(this, SettingsActivity::class.java).apply {
                putExtra("FORCE_FIRST_RUN", true)
            }
            startActivityForResult(intent, REQ_SETTINGS)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_SETTINGS -> {
                // 从设置界面返回，重新读取配置并重载页面
                val newUrl = ServerConfig.getServerUrl(this)
                val cacheCleared = data?.getBooleanExtra("CLEAR_CACHE_DONE", false) == true
                if (newUrl != serverUrl) {
                    Log.d(TAG, "服务器地址已更新: $newUrl")
                    serverUrl = newUrl
                    socketUrl = newUrl
                    // 断开旧 socket，重连
                    socket?.disconnect()
                    socket?.off()
                    // 重新加载页面
                    loadServerPage()
                    // 重新初始化 socket
                    initSocket()
                } else if (cacheCleared) {
                    // 缓存已清理，重新加载 WebView 让前端重新读取数据
                    Log.d(TAG, "缓存已清理，重新加载 WebView")
                    socket?.disconnect()
                    socket?.off()
                    loadServerPage()
                    initSocket()
                } else {
                    // 即使 URL 没变，用户名可能变了，重新注入
                    injectUserNameIntoWebView()
                }
            }
            REQ_BATTERY_OPTIMIZATION -> {
                val powerManager = getSystemService(POWER_SERVICE) as PowerManager
                if (powerManager.isIgnoringBatteryOptimizations(packageName)) {
                    Toast.makeText(this, "电池优化白名单已加入，屏幕共享更稳定", Toast.LENGTH_SHORT).show()
                    Log.d(TAG, "已加入电池优化白名单")
                } else {
                    Toast.makeText(this, "建议加入电池优化白名单以保证屏幕共享稳定", Toast.LENGTH_LONG).show()
                    Log.w(TAG, "用户拒绝加入电池优化白名单")
                }
            }
        }
    }

    /**
     * 全屏模式：只隐藏导航栏，保留顶部状态栏（可看到时间/电量/信号）
     */
    private fun enterImmersiveMode() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val lp = window.attributes
                lp.layoutInDisplayCutoutMode =
                    android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                window.attributes = lp
            }
            val controller = WindowInsetsControllerCompat(window, window.decorView)
            // 只隐藏底部导航栏；状态栏保持显示，顶部可看到时间
            controller.hide(WindowInsetsCompat.Type.navigationBars())
            controller.show(WindowInsetsCompat.Type.statusBars())
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } catch (e: Exception) {
            Log.w(TAG, "进入全屏模式失败", e)
        }
    }

    /**
     * 窗口重新获得焦点时保持全屏模式（弹窗、旋转后自动恢复）
     */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersiveMode()
    }

    // ===== 设置按钮（小扳手）拖拽状态 =====
    private var settingsDownRawX = 0f
    private var settingsDownRawY = 0f
    private var settingsStartTX = 0f
    private var settingsStartTY = 0f
    private var settingsMoved = false

    /**
     * 设置按钮可拖动实现：
     * - 按住拖动：通过 translationX/Y 移动到屏幕任意位置（带边界约束，松手后位置持久化）
     * - 轻点（位移小于 8px）：打开设置界面
     */
    @SuppressLint("ClickableViewAccessibility")
    private fun setupSettingsButtonDrag() {
        // 恢复上次保存的位置
        val prefs = getSharedPreferences("server_config", MODE_PRIVATE)
        val savedTX = prefs.getFloat("settings_btn_tx", Float.MIN_VALUE)
        val savedTY = prefs.getFloat("settings_btn_ty", Float.MIN_VALUE)
        if (savedTX != Float.MIN_VALUE && savedTY != Float.MIN_VALUE) {
            btnSettings.translationX = savedTX
            btnSettings.translationY = savedTY
        }

        btnSettings.setOnTouchListener { v, ev ->
            when (ev.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    settingsDownRawX = ev.rawX
                    settingsDownRawY = ev.rawY
                    settingsStartTX = v.translationX
                    settingsStartTY = v.translationY
                    settingsMoved = false
                    true
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    val dx = ev.rawX - settingsDownRawX
                    val dy = ev.rawY - settingsDownRawY
                    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) settingsMoved = true
                    if (settingsMoved) {
                        v.translationX = settingsStartTX + dx
                        v.translationY = settingsStartTY + dy
                    }
                    true
                }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                    if (settingsMoved) {
                        // 边界约束 + 持久化位置
                        clampSettingsButton(v)
                        v.performClick()
                    } else {
                        // 轻点：打开设置界面
                        startActivityForResult(Intent(this, SettingsActivity::class.java), REQ_SETTINGS)
                        v.performClick()
                    }
                    true
                }
                else -> false
            }
        }
    }

    /**
     * 约束设置按钮位置在屏幕范围内，并持久化保存
     */
    private fun clampSettingsButton(v: android.view.View) {
        val dm = resources.displayMetrics
        val margin = 8 * dm.density
        // v.x = left + translationX，left 是布局初始位置（右上角）
        var newX = v.translationX
        var newY = v.translationY
        if (v.x < margin) newX += margin - v.x
        if (v.y < margin) newY += margin - v.y
        if (v.x + v.width > dm.widthPixels - margin) newX -= (v.x + v.width) - (dm.widthPixels - margin)
        if (v.y + v.height > dm.heightPixels - margin) newY -= (v.y + v.height) - (dm.heightPixels - margin)
        v.translationX = newX
        v.translationY = newY
        getSharedPreferences("server_config", MODE_PRIVATE).edit()
            .putFloat("settings_btn_tx", newX)
            .putFloat("settings_btn_ty", newY)
            .apply()
    }

    /**
     * 配置 WebView
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true  // 启用 sessionStorage/localStorage
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            userAgentString = userAgentString + " WebRTC-AndroidApp/1.0"
        }
        // 禁止 WebView 自动暗色化（由前端 CSS data-theme 控制，避免双重暗色化）
        // Android 10-12 默认 FORCE_DARK_AUTO 会反转网页颜色，需关闭；Android 13+ 默认已关闭
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            @Suppress("DEPRECATION")
            webView.settings.setForceDark(android.webkit.WebSettings.FORCE_DARK_OFF)
        }
        // Android 13+ 启用 media queries 暗色支持，让 prefers-color-scheme 能反映系统主题
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13 的 WebView 通过 Algorithmic Darkening 自动适配，需要前端支持 [color-scheme: dark]
            try {
                webView.settings.setAlgorithmicDarkeningAllowed(true)
            } catch (e: NoSuchMethodError) {
                Log.w(TAG, "setAlgorithmicDarkeningAllowed 不可用", e)
            }
        }

        // 允许自签名 HTTPS 证书
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(
                view: WebView?,
                handler: SslErrorHandler?,
                error: SslError?
            ) {
                handler?.proceed()
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                request?.url?.let { url ->
                    extractRoomId(url.toString())?.let { roomId ->
                        currentRoomId = roomId
                        Log.d(TAG, "当前房间号: $roomId")
                        joinSocketRoom(roomId)
                    }
                }
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                // 页面开始加载，重置标记
                isPageLoadedSuccess = false
                hadLoadError = false
                // 在页面开始加载时注入用户名称（在脚本执行前）
                injectUserNameIntoWebView()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // 页面加载完成后再次注入（确保生效）
                injectUserNameIntoWebView()

                // 1. 如果发生过错误（onReceivedError 已触发），强制显示离线页面，不再做内容检测
                //    （WebView 原生错误页 HTML 内容 > 100 字符，会被下面的检测误判为成功）
                if (hadLoadError) {
                    Log.w(TAG, "页面加载完成但之前发生过错误，保持离线页面")
                    showOfflinePage()
                    return
                }

                // 2. 检测 WebView 原生错误页 URL（about:neterror、data:、about:blank）
                if (url == null || url.startsWith("about:neterror") || url.startsWith("data:")
                    || url == "about:blank") {
                    Log.w(TAG, "检测到 WebView 错误页 URL: $url")
                    hadLoadError = true
                    showOfflinePage()
                    return
                }

                // 3. 检查页面是否有实际内容（避免空白页被当成功）
                if (!isPageLoadedSuccess) {
                    view?.evaluateJavascript("(document.body && document.body.innerHTML.length > 100 && !document.title.includes('error') && !document.title.includes('错误')) ? 'OK' : 'EMPTY'") { result ->
                        if (result != null && result.contains("OK")) {
                            isPageLoadedSuccess = true
                            hideOfflinePage()
                            Log.d(TAG, "页面加载成功")
                        } else {
                            Log.w(TAG, "页面加载完成但内容为空，可能服务器离线")
                            showOfflinePage()
                        }
                    }
                }
                url?.let { extractRoomId(it)?.let { roomId ->
                    currentRoomId = roomId
                    joinSocketRoom(roomId)
                }}
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                Log.e(TAG, "WebView 错误: ${error?.description} (主资源: ${request?.isForMainFrame})")
                // 只处理主资源错误（页面加载失败），子资源错误不影响
                if (request?.isForMainFrame == true) {
                    isPageLoadedSuccess = false
                    hadLoadError = true  // 标记发生过错误，阻止 onPageFinished 误判
                    // 立即隐藏 WebView，避免显示原生错误页
                    runOnUiThread {
                        webView.visibility = android.view.View.INVISIBLE
                        showOfflinePage()
                    }
                }
            }
        }

        // 允许 WebView 请求摄像头/麦克风权限（网页调用 getUserMedia 时触发）
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                Log.d(TAG, "WebView 请求权限: ${request?.resources?.joinToString()}")
                runOnUiThread {
                    // 授予所有请求的资源（摄像头、麦克风）
                    request?.grant(request.resources)
                }
            }

            // 处理网页 <input type="file"> 点击，拉起系统文件管理器/相机/相册
            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                // 取消上一次未完成的回调（防止多次点击造成选择器无响应）
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback

                val intent = params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "*/*"
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
                // 允许多选（取决于 input 的 multiple 属性）
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params?.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                try {
                    fileChooserLauncher.launch(intent)
                } catch (e: Exception) {
                    Log.e(TAG, "无法启动文件选择器", e)
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = null
                    return false
                }
                return true
            }
        }

        webView.addJavascriptInterface(WebAppInterface(), "AndroidApp")

        // 修复部分 ROM 上点击输入框键盘不弹出：WebView 需要主动请求焦点
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.setBackgroundColor(android.graphics.Color.BLACK)  // 消除焦点高亮黄框
        webView.setOnTouchListener { v, event ->
            // 只在 WebView 完全没有焦点时才 requestFocus，避免点击 input 时抢焦点导致键盘闪现
            if (event.action == android.view.MotionEvent.ACTION_DOWN && !v.hasFocus()) {
                v.requestFocusFromTouch()
            }
            false
        }
        // 进入页面时主动请求焦点
        webView.requestFocus()
    }

    /**
     * 监听系统配置变化（暗色模式切换等）
     * 当系统主题切换时，主动通知前端重新应用主题
     */
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        // 检测系统暗色模式切换（Android 10+）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val isDark = (newConfig.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
                android.content.res.Configuration.UI_MODE_NIGHT_YES
            // 主动注入 JS 通知前端当前系统主题，避免 WebView 媒体查询失效
            webView.post {
                webView.evaluateJavascript(
                    "if (typeof window.__onSystemThemeChange === 'function') { window.__onSystemThemeChange(${if (isDark) "true" else "false"}); }",
                    null
                )
            }
        }
    }

    /**
     * 注入用户名称到 WebView 的 sessionStorage
     * 在页面脚本执行前调用，确保 util.js 能读取到
     */
    private fun injectUserNameIntoWebView() {
        val userName = ServerConfig.getUserName(this)
        if (userName.isNotEmpty()) {
            // 转义单引号防止注入
            val escapedName = userName.replace("\\", "\\\\").replace("'", "\\'")
            val js = "try { sessionStorage.setItem('meetingUserName', '$escapedName'); } catch(e) {}"
            webView.evaluateJavascript(js, null)
            Log.d(TAG, "已注入用户名称到 sessionStorage")
        }
    }

    /**
     * 从 URL 提取房间号
     * URL 格式：https://192.168.1.100:3030/room/<6位数字>
     */
    private fun extractRoomId(url: String): String? {
        return try {
            val uri = Uri.parse(url)
            val path = uri.path ?: return null
            val parts = path.trimStart('/').split('/')
            if (parts.size >= 2 && parts[0] == "room") {
                val roomId = parts[1]
                if (roomId.matches(Regex("\\d{6}"))) roomId else null
            } else {
                null
            }
        } catch (e: Exception) {
            null
        }
    }

    /**
     * 加载服务器页面
     * 先通过 HTTP 探测服务器是否在线，避免 WebView 直接加载失败显示原生错误页
     */
    private fun loadServerPage() {
        if (serverUrl.isEmpty()) {
            Toast.makeText(this, "请先设置服务器地址", Toast.LENGTH_SHORT).show()
            return
        }
        Log.d(TAG, "加载页面: $serverUrl")
        isPageLoadedSuccess = false
        hadLoadError = false
        // 直接显示离线页面 + 加载动画，等探测结果再决定加载 WebView
        offlineServerUrl.text = "目标服务器: $serverUrl"
        offlinePage.visibility = android.view.View.VISIBLE
        webView.visibility = android.view.View.INVISIBLE
        retryingProgress.visibility = android.view.View.VISIBLE
        autoRetryHint.visibility = android.view.View.INVISIBLE
        btnRetry.isEnabled = false
        btnRetry.text = "正在连接..."
        // 探测服务器健康状态
        checkServerHealthAndLoad()
        Toast.makeText(this, "正在连接服务器...", Toast.LENGTH_SHORT).show()
    }

    /**
     * 显示离线页面（替代 WebView 原生错误页）
     */
    private fun showOfflinePage() {
        runOnUiThread {
            // 取消可能正在进行的自动重试
            autoRetryRunnable?.let { handler.removeCallbacks(it) }
            autoRetryRunnable = null

            // 显示服务器地址
            offlineServerUrl.text = "目标服务器: $serverUrl"
            // 重置按钮状态
            btnRetry.isEnabled = true
            btnRetry.text = "重试连接"
            autoRetryHint.visibility = android.view.View.INVISIBLE
            retryingProgress.visibility = android.view.View.INVISIBLE

            // 显示离线页面，隐藏 WebView
            offlinePage.visibility = android.view.View.VISIBLE
            webView.visibility = android.view.View.INVISIBLE

            // 设置状态栏颜色为深色
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                window.statusBarColor = android.graphics.Color.parseColor("#0d1117")
            }

            Log.d(TAG, "显示离线页面")

            // 启动自动重试倒计时（5 秒后自动重试）
            startAutoRetryCountdown()
        }
    }

    /**
     * 隐藏离线页面
     */
    private fun hideOfflinePage() {
        runOnUiThread {
            // 取消自动重试
            autoRetryRunnable?.let { handler.removeCallbacks(it) }
            autoRetryRunnable = null

            offlinePage.visibility = android.view.View.GONE
            webView.visibility = android.view.View.VISIBLE

            // 恢复状态栏颜色
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                window.statusBarColor = android.graphics.Color.parseColor("#1a1a1a")
            }
            Log.d(TAG, "隐藏离线页面")
        }
    }

    /**
     * 启动自动重试倒计时（5 秒后自动重试）
     */
    private fun startAutoRetryCountdown() {
        autoRetryHint.visibility = android.view.View.VISIBLE
        autoRetryHint.text = "将在 5 秒后自动重试..."

        autoRetryRunnable = Runnable {
            runOnUiThread {
                if (offlinePage.visibility == android.view.View.VISIBLE) {
                    Log.d(TAG, "自动重试连接...")
                    retryLoadServerPage()
                }
            }
        }
        // 5 秒后执行自动重试
        handler.postDelayed(autoRetryRunnable!!, 5000)
    }

    /**
     * 重试加载服务器页面（点击重试按钮或自动重试时调用）
     */
    private fun retryLoadServerPage() {
        runOnUiThread {
            // 禁用按钮，显示加载中
            btnRetry.isEnabled = false
            btnRetry.text = "正在重试..."
            autoRetryHint.visibility = android.view.View.INVISIBLE
            retryingProgress.visibility = android.view.View.VISIBLE

            // 先通过 HTTP 探测服务器是否在线，再加载 WebView
            checkServerHealthAndLoad()
        }
    }

    /**
     * 通过 HTTP 探测服务器是否在线
     * 在线则加载 WebView，离线则重新显示倒计时
     */
    private fun checkServerHealthAndLoad() {
        Thread {
            try {
                val okHttpClient = createTrustingHttpClient()
                val request = okhttp3.Request.Builder()
                    .url(serverUrl)
                    .head()  // HEAD 请求，只取响应头，不下载内容
                    .build()
                val response = okHttpClient.newCall(request).execute()
                val isOnline = response.isSuccessful || response.code in 200..499
                response.close()

                runOnUiThread {
                    retryingProgress.visibility = android.view.View.INVISIBLE
                    if (isOnline) {
                        Log.d(TAG, "服务器探测成功，加载页面")
                        // 服务器在线，先隐藏离线页面再加载 WebView
                        autoRetryRunnable?.let { handler.removeCallbacks(it) }
                        autoRetryRunnable = null
                        offlinePage.visibility = android.view.View.GONE
                        webView.visibility = android.view.View.VISIBLE
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                            window.statusBarColor = android.graphics.Color.parseColor("#1a1a1a")
                        }
                        isPageLoadedSuccess = false
                        hadLoadError = false
                        webView.loadUrl(serverUrl)
                    } else {
                        Log.w(TAG, "服务器探测失败，继续等待")
                        btnRetry.isEnabled = true
                        btnRetry.text = "重试连接"
                        startAutoRetryCountdown()
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "服务器探测异常: ${e.message}")
                runOnUiThread {
                    retryingProgress.visibility = android.view.View.INVISIBLE
                    btnRetry.isEnabled = true
                    btnRetry.text = "重试连接"
                    // 服务器不可达，继续倒计时重试
                    startAutoRetryCountdown()
                }
            }
        }.start()
    }

    /**
     * 初始化 socket.io 连接
     * 使用 OkHttp 客户端信任自签名证书
     */
    private fun initSocket() {
        if (socketUrl.isEmpty()) return
        try {
            // 创建信任所有证书的 OkHttpClient
            val okHttpClient = createTrustingHttpClient()

            val options = IO.Options().apply {
                reconnection = true
                reconnectionAttempts = Int.MAX_VALUE  // 无限重连
                reconnectionDelay = 2000
                timeout = 10000
                callFactory = okHttpClient
            }
            socket = IO.socket(socketUrl, options)

            socket?.on(Socket.EVENT_CONNECT, Emitter.Listener {
                runOnUiThread {
                    connectionStatus.text = "已连接"
                    connectionStatus.setTextColor(getColor(R.color.green_500))
                    Log.d(TAG, "socket.io 已连接")
                }
            })

            socket?.on(Socket.EVENT_DISCONNECT, Emitter.Listener {
                runOnUiThread {
                    connectionStatus.text = "已断开"
                    connectionStatus.setTextColor(getColor(R.color.red_500))
                    Log.d(TAG, "socket.io 已断开")
                }
            })

            socket?.on(Socket.EVENT_CONNECT_ERROR, Emitter.Listener { args ->
                runOnUiThread {
                    connectionStatus.text = "连接错误"
                    connectionStatus.setTextColor(getColor(R.color.red_500))
                    Log.e(TAG, "socket.io 连接错误: ${args[0]}")
                }
            })

            socket?.connect()

        } catch (e: URISyntaxException) {
            Log.e(TAG, "socket.io URL 错误", e)
        } catch (e: Exception) {
            Log.e(TAG, "初始化 socket.io 失败", e)
        }
    }

    /**
     * 创建信任所有证书的 OkHttpClient（用于自签名 HTTPS 服务器）
     * socket.io-client 2.1.0 底层使用 OkHttp，通过 callFactory 注入
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
    private fun joinSocketRoom(roomId: String) {
        if (socket?.connected() == true) {
            val data = JSONObject().apply {
                put("roomID", roomId)
                put("peerUserId", "android-native-${System.currentTimeMillis()}")
                put("isNative", true)
                put("name", ServerConfig.getUserName(this@MainActivity))
            }
            socket?.emit("join-room", data)
            Log.d(TAG, "已加入房间: $roomId")
        } else {
            Log.w(TAG, "socket 未连接，无法加入房间")
        }
    }

    /**
     * 请求屏幕捕获权限
     */
    private fun requestScreenCapturePermission() {
        if (currentRoomId == null) {
            Toast.makeText(this, "请先加入会议房间", Toast.LENGTH_SHORT).show()
            return
        }

        if (socket?.connected() != true) {
            Toast.makeText(this, "服务器未连接，无法共享屏幕", Toast.LENGTH_SHORT).show()
            return
        }

        val projectionManager = getSystemService(android.content.Context.MEDIA_PROJECTION_SERVICE) as android.media.projection.MediaProjectionManager
        val intent = projectionManager.createScreenCaptureIntent()
        screenCaptureLauncher.launch(intent)
    }

    /**
     * 启动屏幕捕获服务
     */
    private fun startScreenCapture(resultCode: Int, data: Intent) {
        val serviceIntent = Intent(this, ScreenCaptureService::class.java).apply {
            putExtra("resultCode", resultCode)
            putExtra("data", data)
            putExtra("roomId", currentRoomId)
            putExtra("socketUrl", socketUrl)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }

        isSharing = true
        updateShareButton()
        Toast.makeText(this, "屏幕共享已开始", Toast.LENGTH_SHORT).show()
    }

    /**
     * 停止屏幕捕获
     */
    private fun stopScreenCapture() {
        val serviceIntent = Intent(this, ScreenCaptureService::class.java).apply {
            action = "STOP"
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
        isSharing = false
        updateShareButton()
        Toast.makeText(this, "屏幕共享已停止", Toast.LENGTH_SHORT).show()

        // 停止屏幕共享后，恢复视频轨道
        handler.postDelayed({
            resumeVideoTracks()
        }, 1000)
    }

    /**
     * 更新共享按钮文本
     */
    private fun updateShareButton() {
        btnShareScreen.text = if (isSharing) "停止共享屏幕" else "开始共享屏幕"
        btnShareScreen.setBackgroundColor(
            getColor(if (isSharing) R.color.red_500 else R.color.purple_500)
        )
    }

    /**
     * 恢复视频轨道（防止屏幕共享后视频冻结）
     * 通过 JavaScript 重新启用 WebRTC 视频轨道
     */
    private fun resumeVideoTracks() {
        val js = """
            (function() {
                try {
                    // 尝试通过全局函数恢复视频
                    if (typeof window.resumeVideoTracks === 'function') {
                        window.resumeVideoTracks();
                        return;
                    }
                    // 备用：触发视频切换（先关再开）
                    if (typeof window.toggleVideo === 'function') {
                        // 检查视频按钮状态
                        var btn = document.getElementById('videoToggle');
                        if (btn && btn.classList.contains('off')) {
                            window.toggleVideo(); // 开启视频
                            setTimeout(function() {
                                if (btn.classList.contains('off')) {
                                    window.toggleVideo(); // 再次切换确保开启
                                }
                            }, 500);
                        }
                    }
                } catch(e) { console.log('resumeVideoTracks error:', e); }
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
        Log.d(TAG, "已尝试恢复视频轨道")
    }

    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    /**
     * JavaScript 接口
     */
    inner class WebAppInterface {
        @JavascriptInterface
        fun isNativeApp(): Boolean = true

        @JavascriptInterface
        fun onRoomJoined(roomId: String) {
            currentRoomId = roomId
            joinSocketRoom(roomId)
            Log.d(TAG, "网页通知房间已加入: $roomId")
        }

        /**
         * 获取用户名称（供网页 util.js 调用）
         */
        @JavascriptInterface
        fun getUserName(): String {
            return ServerConfig.getUserName(this@MainActivity)
        }

        /**
         * 设置用户名称（供网页改名时同步调用，避免刷新后恢复旧名）
         */
        @JavascriptInterface
        fun setUserName(name: String) {
            ServerConfig.setUserName(this@MainActivity, name)
            Log.d(TAG, "用户名称已同步到本地: $name")
        }

        /**
         * 控制屏幕共享按钮显示/隐藏
         * 网页在通话开始时调用 setVisible(true)，通话结束时调用 setVisible(false)
         */
        @JavascriptInterface
        fun setScreenShareButtonVisible(visible: Boolean) {
            handler.post {
                btnShareScreen.visibility = if (visible) android.view.View.VISIBLE else android.view.View.GONE
                Log.d(TAG, "屏幕共享按钮可见性: $visible")
            }
        }

        /**
         * 网页调用启动屏幕共享（替代不支持的 getDisplayMedia）
         */
        @JavascriptInterface
        fun startNativeScreenShare() {
            handler.post {
                if (!isSharing) {
                    requestScreenCapturePermission()
                }
            }
        }

        /**
         * 网页调用停止屏幕共享
         */
        @JavascriptInterface
        fun stopNativeScreenShare() {
            handler.post {
                if (isSharing) {
                    stopScreenCapture()
                }
            }
        }

        /**
         * 查询当前是否正在共享屏幕
         */
        @JavascriptInterface
        fun isScreenSharing(): Boolean = isSharing

        @JavascriptInterface
        fun getAppVersionCode(): Int {
            return try {
                val pInfo = packageManager.getPackageInfo(packageName, 0)
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                    pInfo.longVersionCode.toInt()
                } else {
                    @Suppress("DEPRECATION")
                    pInfo.versionCode
                }
            } catch (e: Exception) { 1 }
        }

        @JavascriptInterface
        fun getAppVersionName(): String {
            return try {
                val pInfo = packageManager.getPackageInfo(packageName, 0)
                pInfo.versionName ?: "1.0"
            } catch (e: Exception) { "1.0" }
        }

        @JavascriptInterface
        fun downloadAndInstallApk(url: String) {
            handler.post {
                try {
                    val serverHost = ServerConfig.getServerUrl(this@MainActivity)
                    val fullUrl = if (url.startsWith("http")) url else "https://$serverHost$url"
                    Log.d(TAG, "下载 APK: $fullUrl")
                    val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(fullUrl))
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(intent)
                } catch (e: Exception) {
                    Log.e(TAG, "下载 APK 失败", e)
                }
            }
        }

        /**
         * 震动（供网页来电时调用）
         * @param durationMs 震动时长（毫秒）
         */
        @JavascriptInterface
        fun vibrate(durationMs: Long) {
            try {
                val vibrator = getSystemService(VIBRATOR_SERVICE) as android.os.Vibrator
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    vibrator.vibrate(
                        android.os.VibrationEffect.createOneShot(
                            durationMs,
                            android.os.VibrationEffect.DEFAULT_AMPLITUDE
                        )
                    )
                } else {
                    @Suppress("DEPRECATION")
                    vibrator.vibrate(durationMs)
                }
            } catch (e: Exception) {
                Log.e(TAG, "vibrate 失败: ${e.message}")
            }
        }

        /**
         * 调用系统相机拍照（WebView 不支持 <input capture>）
         * 拍完后通过 window.__takePhotoResult(callbackId, dataUrl) 回调前端
         * @param callbackId 前端传来的回调标识
         */
        @JavascriptInterface
        fun takePhoto(callbackId: String) {
            handler.post {
                takePhotoCallbackId = callbackId
                try {
                    val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                    takePhotoLauncher.launch(intent)
                } catch (e: Exception) {
                    Log.e(TAG, "调起相机失败", e)
                    takePhotoCallbackId = null
                    webView.post {
                        webView.evaluateJavascript("window.__takePhotoResult && window.__takePhotoResult('$callbackId', null)", null)
                    }
                }
            }
        }

        /**
         * 清除来电通知（前端接听/拒绝来电时调用）
         */
        @JavascriptInterface
        fun dismissCallNotification() {
            ChatNotificationService.dismissCallNotification(this@MainActivity)
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isSharing) {
            stopScreenCapture()
        }
        socket?.disconnect()
        socket?.off()
        // 注意：不停止聊天服务，让它保持后台运行
        // 只有用户主动退出应用时才停止（在 onTaskRemoved 中处理）
    }
}
