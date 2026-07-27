package com.webrtc.screenshare

import android.content.Context
import android.content.SharedPreferences

/**
 * 服务器配置管理
 *
 * 使用 SharedPreferences 保存服务器地址，用户可以在设置界面修改。
 *
 * 地址推导规则：
 * - 用户输入 HTTPS 地址（例如 https://your-server:3030）
 * - WebView 加载该地址
 * - Socket.io 连接该地址
 * - HTTP 跳转地址自动推导：把 https 换成 http，端口 3030 换成 8080
 */
object ServerConfig {

    private const val PREF_NAME = "server_config"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_FIRST_RUN = "first_run"
    private const val KEY_USER_NAME = "user_name"

    // 默认服务器地址（部署时请修改为你自己的服务器地址）
    // 首次启动时 app 会引导用户到设置页面填写，这里仅作为占位符
    // 示例：内网 https://192.168.1.100:3030 / 公网 IPv6 https://[2001:db8::1]:3030
    const val DEFAULT_SERVER_URL = "https://192.168.1.100:3030"

    /**
     * 获取 SharedPreferences
     */
    private fun getPrefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
    }

    /**
     * 获取服务器地址（HTTPS）
     */
    fun getServerUrl(context: Context): String {
        return getPrefs(context).getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
    }

    /**
     * 保存服务器地址
     */
    fun setServerUrl(context: Context, url: String) {
        getPrefs(context).edit().putString(KEY_SERVER_URL, url).apply()
    }

    /**
     * 是否首次运行
     */
    fun isFirstRun(context: Context): Boolean {
        return getPrefs(context).getBoolean(KEY_FIRST_RUN, true)
    }

    /**
     * 标记已运行过
     */
    fun setFirstRunDone(context: Context) {
        getPrefs(context).edit().putBoolean(KEY_FIRST_RUN, false).apply()
    }

    /**
     * 从 HTTPS 地址推导 HTTP 跳转地址
     * 例如：https://your-server:3030 -> http://your-server:8080
     */
    fun deriveHttpUrl(httpsUrl: String): String {
        var url = httpsUrl
        // 把 https 换成 http
        url = url.replaceFirst("https://", "http://", ignoreCase = true)
        // 把端口 3030 换成 8080
        url = url.replaceFirst(":3030", ":8080", ignoreCase = true)
        return url
    }

    /**
     * 获取用户名称
     */
    fun getUserName(context: Context): String {
        return getPrefs(context).getString(KEY_USER_NAME, "") ?: ""
    }

    /**
     * 保存用户名称
     */
    fun setUserName(context: Context, name: String) {
        getPrefs(context).edit().putString(KEY_USER_NAME, name).apply()
    }

    /**
     * 验证 URL 格式是否合法
     */
    fun isValidUrl(url: String): Boolean {
        return try {
            val lower = url.lowercase().trim()
            if (!lower.startsWith("https://") && !lower.startsWith("http://")) {
                return false
            }
            val uri = android.net.Uri.parse(url)
            uri.host != null
        } catch (e: Exception) {
            false
        }
    }
}
