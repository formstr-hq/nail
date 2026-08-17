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
 * SharedPreferences: `seen_<pubkey>` is a bounded set of already-seen wrap ids,
 * and `seeded_<pubkey>` marks that the initial backlog has been recorded.
 *
 * We deliberately do NOT key novelty off the wrap's `created_at`: NIP-59
 * backdates each gift-wrap's timestamp by up to two days to thwart timing
 * analysis, so a just-arrived mail can carry a `created_at` up to 2 days in the
 * past. A `since`-based watermark therefore silently dropped freshly-arrived
 * mail (the relay's `since` filter excluded it, and so did the crate) — which
 * is exactly why alerts never fired. Instead every poll fetches the last ~2
 * days by wall clock and decides novelty purely by event id.
 */
class MailPollWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val pubkey = inputData.getString(KEY_PUBKEY)
        val relays = inputData.getStringArray(KEY_RELAYS)?.toList()
        if (pubkey.isNullOrEmpty() || relays.isNullOrEmpty()) return Result.success()

        val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // Fetch the whole backdating window every poll; the seen-id set below,
        // not the timestamp, is what makes a wrap "new".
        val nowSecs = System.currentTimeMillis() / 1000
        val pollSince = (nowSecs - LOOKBACK_SECS).coerceAtLeast(0L)

        val wraps = pollOnce(
            WatchConfig(ownerPubkeyHex = pubkey, relays = relays, sinceSecs = pollSince.toULong()),
            POLL_TIMEOUT_SECS,
        )

        val seen = prefs.getStringSet(keySeen(pubkey), emptySet())!!.toMutableSet()
        // The first poll after enabling only records the existing backlog into
        // `seen` (no alerts), so turning notifications on never dumps the inbox;
        // every poll after that alerts on genuinely-new ids only.
        val seeded = prefs.getBoolean(keySeeded(pubkey), false)
        var newCount = 0
        for (wrap in wraps) {
            val isNew = seen.add(wrap.id)
            if (isNew && seeded) {
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
            .putStringSet(keySeen(pubkey), trimmed)
            .putBoolean(keySeeded(pubkey), true)
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
        // NIP-59 backdates wrap timestamps up to two days; fetch that whole
        // window (plus an hour of clock slack) every poll so a freshly-arrived
        // but backdated wrap is never excluded by the relay's `since` filter.
        private const val LOOKBACK_SECS = 2L * 24 * 3600 + 3600
        private const val POLL_TIMEOUT_SECS = 20UL
        private const val SEEN_CAP = 500

        private fun keySeen(pubkey: String) = "seen_$pubkey"
        private fun keySeeded(pubkey: String) = "seeded_$pubkey"
    }
}
