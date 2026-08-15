package com.formstr.mail.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.formstr.mail.R
import uniffi.notifier.WatchConfig
import uniffi.notifier.pollOnce

/**
 * One periodic poll of the owner's DM relays for new gift-wraps, run by
 * WorkManager (see [NotifierScheduler]). Battery-friendly: no persistent
 * connection or foreground service — it connects, reads stored events up to
 * EOSE via the key-free `notifier` crate, posts a local notification per
 * genuinely-new wrap, and disconnects.
 *
 * De-duplication and the "don't re-notify old mail" guarantee live here, in
 * SharedPreferences: `since_<pubkey>` is the newest timestamp seen, and
 * `seen_<pubkey>` a bounded set of already-notified ids. We poll from
 * `since - SLACK` so a straggler that a slow relay withheld last run is still
 * caught, then rely on the id set to avoid a duplicate alert.
 */
class MailPollWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val pubkey = inputData.getString(KEY_PUBKEY)
        val relays = inputData.getStringArray(KEY_RELAYS)?.toList()
        if (pubkey.isNullOrEmpty() || relays.isNullOrEmpty()) return Result.success()

        val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val since = prefs.getLong(keySince(pubkey), 0L)
        val pollSince = (since - SLACK_SECS).coerceAtLeast(0L)

        val wraps = pollOnce(
            WatchConfig(ownerPubkeyHex = pubkey, relays = relays, sinceSecs = pollSince.toULong()),
            POLL_TIMEOUT_SECS,
        )

        val seen = prefs.getStringSet(keySeen(pubkey), emptySet())!!.toMutableSet()
        var maxTs = since
        var newCount = 0
        for (wrap in wraps) {
            val ts = wrap.createdAt.toLong()
            if (ts > maxTs) maxTs = ts
            if (seen.add(wrap.id)) {
                notifyNewMail(wrap.id)
                newCount++
            }
        }
        if (newCount > 0) {
            android.util.Log.i("notifier", "polled ${wraps.size} wraps, $newCount new")
        }

        // Bound the seen-set so it can't grow without limit.
        val trimmed = if (seen.size > SEEN_CAP) seen.toList().takeLast(SEEN_CAP).toSet() else seen
        prefs.edit()
            .putLong(keySince(pubkey), maxTs)
            .putStringSet(keySeen(pubkey), trimmed)
            .apply()

        return Result.success()
    }

    private fun notifyNewMail(eventId: String) {
        ensureChannel()
        val note = NotificationCompat.Builder(applicationContext, CHANNEL_MAIL)
            .setContentTitle("Mail by Form*")
            .setContentText("You have new mail")
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(launchAppIntent())
            .build()
        manager().notify(eventId.hashCode(), note)
    }

    private fun launchAppIntent(): PendingIntent? {
        val ctx = applicationContext
        val intent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
        return PendingIntent.getActivity(
            ctx,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        manager().createNotificationChannel(
            NotificationChannel(CHANNEL_MAIL, "New mail", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "Alerts when new mail arrives" },
        )
    }

    private fun manager() =
        applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    companion object {
        const val KEY_PUBKEY = "pubkey"
        const val KEY_RELAYS = "relays"

        private const val CHANNEL_MAIL = "mail-new"
        private const val PREFS = "notifier"
        // Poll from a little before `since` so a straggler withheld by a slow
        // relay last run is still fetched; the seen-set dedups the alert.
        private const val SLACK_SECS = 3600L
        private const val POLL_TIMEOUT_SECS = 20UL
        private const val SEEN_CAP = 500

        private fun keySince(pubkey: String) = "since_$pubkey"
        private fun keySeen(pubkey: String) = "seen_$pubkey"
    }
}
