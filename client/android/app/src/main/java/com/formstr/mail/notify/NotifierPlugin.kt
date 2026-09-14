package com.formstr.mail.notify

import android.Manifest
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
            android.util.Log.w(TAG, "start rejected: pubkey missing")
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
        // Hardcoded fallback relay (mirrors the client's HARDCODED_RELAY). The
        // notifier's native rustls socket is Cloudflare-fragile on some popular
        // DM relays — the UA spoof in the crate gets most past, but a relay can
        // still be down or a user can have an empty/partial kind-10050 list. We
        // always also poll primal: the bridge force-publishes every mail there,
        // and it accepts rustls, so it is a guaranteed-readable copy. Deduped
        // against whatever JS passed in.
        if (!relays.contains(HARDCODED_RELAY)) relays.add(HARDCODED_RELAY)
        android.util.Log.i(TAG, "start: pubkey=${pubkey.take(8)} relays=${relays.size} ${relays.joinToString { it }}")

        // The backlog baseline (so enabling never dumps the existing inbox) is
        // handled by MailPollWorker's first "seeding" poll — see its `seeded_`
        // flag — because that's where wraps are actually read.
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
        private const val TAG = "notifier"
        private const val WORK_NAME = "mail-poll"
        private const val HARDCODED_RELAY = "wss://relay.primal.net"
    }
}
