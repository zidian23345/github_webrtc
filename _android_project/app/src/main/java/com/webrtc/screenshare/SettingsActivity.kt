package com.webrtc.screenshare

import android.content.Intent
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import android.app.AlertDialog
import org.json.JSONObject
import androidx.appcompat.app.AppCompatActivity
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * 服务器设置界面
 *
 * 功能：
 * 1. 输入服务器地址（HTTPS）
 * 2. 快速填充示例
 * 3. 测试连接
 * 4. 保存配置
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var editServerUrl: EditText
    private lateinit var editUserName: EditText
    private lateinit var btnFillIpv6: Button
    private lateinit var btnFillIpv4: Button
    private lateinit var btnTestConnection: Button
    private lateinit var tvTestResult: TextView
    private lateinit var btnSave: Button
    private lateinit var btnCancel: Button
    private lateinit var btnCheckUpdate: Button
    private lateinit var tvUpdateResult: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        // 初始化视图
        editServerUrl = findViewById(R.id.editServerUrl)
        editUserName = findViewById(R.id.editUserName)
        btnFillIpv6 = findViewById(R.id.btnFillIpv6)
        btnFillIpv4 = findViewById(R.id.btnFillIpv4)
        btnTestConnection = findViewById(R.id.btnTestConnection)
        tvTestResult = findViewById(R.id.tvTestResult)
        btnSave = findViewById(R.id.btnSave)
        btnCancel = findViewById(R.id.btnCancel)
        btnCheckUpdate = findViewById(R.id.btnCheckUpdate)
        tvUpdateResult = findViewById(R.id.tvUpdateResult)

        // 显示当前保存的服务器地址和用户名称
        editServerUrl.text = SpannableStringBuilder(ServerConfig.getServerUrl(this))
        editUserName.text = SpannableStringBuilder(ServerConfig.getUserName(this))

        // 首次运行（强制模式）：禁用取消按钮，必须输入名称才能保存退出
        forceFirstRun = intent.getBooleanExtra("FORCE_FIRST_RUN", false)
        if (forceFirstRun) {
            btnCancel.isEnabled = false
            btnCancel.alpha = 0.4f
            title = "首次使用：请输入你的名称"
        }

        // 快速填充 IPv6 示例
        btnFillIpv6.setOnClickListener {
            editServerUrl.text = SpannableStringBuilder(ServerConfig.DEFAULT_SERVER_URL)
            Toast.makeText(this, "已填充 IPv6 示例", Toast.LENGTH_SHORT).show()
        }

        // 快速填充 IPv4 示例
        btnFillIpv4.setOnClickListener {
            editServerUrl.text = SpannableStringBuilder("https://192.168.1.100:3030")
            Toast.makeText(this, "已填充 IPv4 示例", Toast.LENGTH_SHORT).show()
        }

        // 测试连接
        btnTestConnection.setOnClickListener {
            val url = editServerUrl.text.toString().trim()
            if (url.isEmpty()) {
                Toast.makeText(this, "请输入服务器地址", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            if (!ServerConfig.isValidUrl(url)) {
                Toast.makeText(this, "URL 格式不正确", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            testConnection(url)
        }

        // 保存
        btnSave.setOnClickListener {
            val url = editServerUrl.text.toString().trim()
            val userName = editUserName.text.toString().trim()

            if (url.isEmpty()) {
                Toast.makeText(this, "请输入服务器地址", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            if (!ServerConfig.isValidUrl(url)) {
                Toast.makeText(this, "URL 格式不正确", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            if (userName.isEmpty()) {
                Toast.makeText(this, "请输入你的名称", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            ServerConfig.setServerUrl(this, url)
            ServerConfig.setUserName(this, userName)
            ServerConfig.setFirstRunDone(this)
            Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()

            // 返回主界面
            val intent = Intent(this, MainActivity::class.java)
            intent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            startActivity(intent)
            finish()
        }

        // 取消
        btnCancel.setOnClickListener {
            finish()
        }

        // 检查更新
        btnCheckUpdate.setOnClickListener {
            checkAppUpdate()
        }
    }

    /**
     * 检查应用更新
     */
    private fun checkAppUpdate() {
        tvUpdateResult.text = "正在检查更新..."
        tvUpdateResult.setTextColor(getColor(R.color.gray_900))
        btnCheckUpdate.isEnabled = false

        thread {
            try {
                val serverUrl = ServerConfig.getServerUrl(this).trimEnd('/')
                val url = URL(serverUrl + "/api/app/check-update")
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 5000
                    readTimeout = 5000
                    requestMethod = "GET"
                    instanceFollowRedirects = false
                }

                if (conn is HttpsURLConnection) {
                    val trustAllCerts = arrayOf<TrustManager>(
                        object : X509TrustManager {
                            override fun checkClientTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
                            override fun checkServerTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
                            override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
                        }
                    )
                    val sslContext = SSLContext.getInstance("TLS")
                    sslContext.init(null, trustAllCerts, java.security.SecureRandom())
                    conn.sslSocketFactory = sslContext.socketFactory
                    conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
                }

                conn.connect()
                val code = conn.responseCode
                if (code !in 200..399) {
                    runOnUiThread {
                        tvUpdateResult.text = "检查更新失败（HTTP " + code + "）"
                        tvUpdateResult.setTextColor(getColor(R.color.red_500))
                        btnCheckUpdate.isEnabled = true
                    }
                    conn.disconnect()
                    return@thread
                }

                val body = conn.inputStream.bufferedReader().use { it.readText() }
                conn.disconnect()
                val json = JSONObject(body)

                if (!json.optBoolean("hasUpdate", false)) {
                    runOnUiThread {
                        tvUpdateResult.text = "已是最新版本"
                        tvUpdateResult.setTextColor(getColor(R.color.green_500))
                        btnCheckUpdate.isEnabled = true
                    }
                    return@thread
                }

                val versionCode = json.optInt("versionCode", 0)
                val versionName = json.optString("versionName", "")
                val updateContent = json.optString("updateContent", "")
                val apkUrl = json.optString("apkUrl", "")

                val pInfo = packageManager.getPackageInfo(packageName, 0)
                val currentCode = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                    pInfo.longVersionCode.toInt()
                } else {
                    @Suppress("DEPRECATION")
                    pInfo.versionCode
                }

                if (versionCode <= currentCode) {
                    runOnUiThread {
                        tvUpdateResult.text = "已是最新版本（v" + pInfo.versionName + "）"
                        tvUpdateResult.setTextColor(getColor(R.color.green_500))
                        btnCheckUpdate.isEnabled = true
                    }
                    return@thread
                }

                runOnUiThread {
                    tvUpdateResult.text = "发现新版本 v" + versionName
                    tvUpdateResult.setTextColor(getColor(R.color.green_500))
                    btnCheckUpdate.isEnabled = true

                    AlertDialog.Builder(this)
                        .setTitle("发现新版本 v" + versionName)
                        .setMessage(updateContent.ifEmpty { "优化体验，修复问题" })
                        .setPositiveButton("立即更新") { _, _ ->
                            val fullUrl = if (apkUrl.startsWith("http")) apkUrl else serverUrl + apkUrl
                            val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(fullUrl))
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            startActivity(intent)
                            Toast.makeText(this, "正在下载更新...", Toast.LENGTH_SHORT).show()
                        }
                        .setNegativeButton("稍后再说", null)
                        .show()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    tvUpdateResult.text = "检查更新失败：" + e.message
                    tvUpdateResult.setTextColor(getColor(R.color.red_500))
                    btnCheckUpdate.isEnabled = true
                }
            }
        }
    }

    // 首次运行模式下，禁止返回键跳过名称输入
    private var forceFirstRun = false
    override fun onBackPressed() {
        if (forceFirstRun) {
            Toast.makeText(this, "请先输入你的名称并保存", Toast.LENGTH_SHORT).show()
            return
        }
        super.onBackPressed()
    }

    /**
     * 测试服务器连接
     */
    private fun testConnection(url: String) {
        tvTestResult.text = "正在测试..."
        tvTestResult.setTextColor(getColor(R.color.gray_900))

        thread {
            try {
                val urlObj = URL(url)
                val conn = (urlObj.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 5000
                    readTimeout = 5000
                    requestMethod = "GET"
                    instanceFollowRedirects = false
                }

                // 接受自签名证书
                if (conn is HttpsURLConnection) {
                    val trustAllCerts = arrayOf<TrustManager>(
                        object : X509TrustManager {
                            override fun checkClientTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
                            override fun checkServerTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
                            override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
                        }
                    )
                    val sslContext = SSLContext.getInstance("TLS")
                    sslContext.init(null, trustAllCerts, java.security.SecureRandom())
                    conn.sslSocketFactory = sslContext.socketFactory
                    conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
                }

                conn.connect()
                val code = conn.responseCode
                val msg = conn.responseMessage

                runOnUiThread {
                    if (code in 200..399) {
                        tvTestResult.text = "✅ 连接成功（HTTP $code $msg）"
                        tvTestResult.setTextColor(getColor(R.color.green_500))
                    } else {
                        tvTestResult.text = "⚠️ 服务器响应异常（HTTP $code $msg）"
                        tvTestResult.setTextColor(getColor(R.color.red_500))
                    }
                }
                conn.disconnect()
            } catch (e: Exception) {
                runOnUiThread {
                    tvTestResult.text = "❌ 连接失败：${e.message}"
                    tvTestResult.setTextColor(getColor(R.color.red_500))
                }
            }
        }
    }
}
