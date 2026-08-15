package com.formstr.mail.notify

import android.Manifest
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission

/**
 * JS bridge for the background mail watcher. The web app calls `start` after
 * login with the account pubkey and its resolved kind-10050 DM relays; the
 * plugin runs [MailWatchService] as a foreground service. `stop` tears it down
 * (e.g. on logout).
 *
 * POST_NOTIFICATIONS (Android 13+) is declared so JS can request it through the
 * standard Capacitor permission API before starting.
 */
@CapacitorPlugin(
    name = "Notifier",
    permissions = [
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
    ],
)
class NotifierPlugin : Plugin() {

    @PluginMethod
    fun start(call: PluginCall) {
        val pubkey = call.getString("pubkey")
        if (pubkey.isNullOrEmpty()) {
            call.reject("pubkey is required")
            return
        }
        val relaysArray = call.getArray("relays")
        val relays = ArrayList<String>()
        if (relaysArray != null) {
            for (i in 0 until relaysArray.length()) {
                relaysArray.optString(i)?.takeIf { it.isNotEmpty() }?.let { relays.add(it) }
            }
        }
        if (relays.isEmpty()) {
            call.reject("at least one relay is required")
            return
        }
        // Unix seconds fit an Int until 2038; the host advances this from what
        // the service has already seen, so 0 (fetch recent history) is fine too.
        val since = (call.getInt("since") ?: 0).toLong()

        val intent = Intent(context, MailWatchService::class.java).apply {
            putExtra(MailWatchService.EXTRA_PUBKEY, pubkey)
            putExtra(MailWatchService.EXTRA_RELAYS, relays.toTypedArray())
            putExtra(MailWatchService.EXTRA_SINCE, since)
        }
        ContextCompat.startForegroundService(context, intent)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        context.stopService(Intent(context, MailWatchService::class.java))
        call.resolve()
    }
}
