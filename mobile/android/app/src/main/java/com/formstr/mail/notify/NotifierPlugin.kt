package com.formstr.mail.notify

import android.Manifest
import android.content.Context
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import java.util.concurrent.TimeUnit

/**
 * JS bridge for background mail notifications. The web app calls `start` after
 * login with the account pubkey and its resolved kind-10050 DM relays; the
 * plugin schedules a periodic [MailPollWorker] via WorkManager (battery-friendly
 * — no foreground service). `stop` cancels it (e.g. on logout).
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

        // Baseline `since` to now on first enable, so we only alert on mail that
        // arrives *after* the user turned notifications on — never the backlog.
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val sinceKey = "since_$pubkey"
        if (!prefs.contains(sinceKey)) {
            prefs.edit().putLong(sinceKey, System.currentTimeMillis() / 1000).apply()
        }

        val data = Data.Builder()
            .putString(MailPollWorker.KEY_PUBKEY, pubkey)
            .putStringArray(MailPollWorker.KEY_RELAYS, relays.toTypedArray())
            .build()
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val wm = WorkManager.getInstance(context)
        // 15 min is WorkManager's minimum period; the OS batches it with other
        // wakeups and defers under Doze, which is exactly the battery win.
        val periodic = PeriodicWorkRequestBuilder<MailPollWorker>(15, TimeUnit.MINUTES)
            .setInputData(data)
            .setConstraints(constraints)
            .build()
        wm.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, periodic)

        // Poll once right away so the first check isn't up to 15 min out.
        val immediate = OneTimeWorkRequestBuilder<MailPollWorker>()
            .setInputData(data)
            .setConstraints(constraints)
            .build()
        wm.enqueue(immediate)

        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        call.resolve()
    }

    companion object {
        private const val WORK_NAME = "mail-poll"
        private const val PREFS = "notifier"
    }
}
