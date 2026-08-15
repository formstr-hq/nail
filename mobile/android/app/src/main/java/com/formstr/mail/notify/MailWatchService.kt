package com.formstr.mail.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.formstr.mail.R
import uniffi.notifier.NotifierDelegate
import uniffi.notifier.WatchConfig
import uniffi.notifier.Watcher

/**
 * Foreground service that keeps the key-free [Watcher] alive while the app is
 * backgrounded or closed, turning each new gift-wrap arrival into a local
 * notification.
 *
 * The watcher never sees a private key: it only reports that a wrap addressed to
 * the owner arrived (see the `notifier` crate). So notifications are
 * metadata-only ("You have new mail") for now; a later phase can unwrap the
 * forwarded `wrapJson` via a NIP-55/NIP-46 signer to add sender/subject.
 */
class MailWatchService : Service() {
    private var watcher: Watcher? = null
    private var ownerPubkey: String? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A foreground service must post its notification promptly, so do it
        // before touching the (slower) relay setup.
        startForegroundStatus(connected = false)

        val pubkey = intent?.getStringExtra(EXTRA_PUBKEY)
        val relays = intent?.getStringArrayExtra(EXTRA_RELAYS)?.toList().orEmpty()
        if (pubkey.isNullOrEmpty() || relays.isEmpty()) {
            // Nothing to watch — stop rather than sit as a zombie foreground.
            stopSelf()
            return START_NOT_STICKY
        }

        // A restart must not re-notify old mail: resume from the newest wrap we
        // have already seen for this owner.
        ownerPubkey = pubkey
        val since = intent.getLongExtra(EXTRA_SINCE, 0L)
            .coerceAtLeast(loadSince(pubkey))

        watcher?.stop()
        watcher = Watcher.start(
            WatchConfig(ownerPubkeyHex = pubkey, relays = relays, sinceSecs = since.toULong()),
            delegate,
        )
        // Survive process death (OS relaunches with a null intent; we simply
        // re-arm the foreground status and wait for the app to re-configure us).
        return START_STICKY
    }

    private val delegate = object : NotifierDelegate {
        override fun onNewMail(eventId: String, createdAt: ULong, wrapJson: String) {
            ownerPubkey?.let { saveSince(it, createdAt.toLong()) }
            notifyNewMail(eventId)
        }

        override fun onConnectivity(anyConnected: Boolean) {
            // Refresh the persistent status line; don't create a new alert.
            startForegroundStatus(connected = anyConnected)
        }
    }

    override fun onDestroy() {
        watcher?.stop()
        watcher = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // --- notifications ------------------------------------------------------

    private fun startForegroundStatus(connected: Boolean) {
        val text = if (connected) "Watching for mail" else "Connecting…"
        val note: Notification = NotificationCompat.Builder(this, CHANNEL_STATUS)
            .setContentTitle("Mail by Form*")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ID_STATUS, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(ID_STATUS, note)
        }
    }

    private fun notifyNewMail(eventId: String) {
        val note = NotificationCompat.Builder(this, CHANNEL_MAIL)
            .setContentTitle("Mail by Form*")
            .setContentText("You have new mail")
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(launchAppIntent())
            .build()
        // Keyed by event id so the same wrap never stacks duplicate alerts.
        manager().notify(eventId.hashCode(), note)
    }

    private fun launchAppIntent() =
        android.app.PendingIntent.getActivity(
            this,
            0,
            packageManager.getLaunchIntentForPackage(packageName),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = manager()
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_STATUS, "Mail watcher", NotificationManager.IMPORTANCE_MIN)
                .apply { description = "Keeps watching your relays for new mail" },
        )
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_MAIL, "New mail", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "Alerts when new mail arrives" },
        )
    }

    private fun manager() =
        getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    // --- since persistence --------------------------------------------------

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun loadSince(pubkey: String) = prefs().getLong(keySince(pubkey), 0L)
    private fun saveSince(pubkey: String, createdAt: Long) {
        val prev = loadSince(pubkey)
        if (createdAt > prev) prefs().edit().putLong(keySince(pubkey), createdAt).apply()
    }

    companion object {
        const val EXTRA_PUBKEY = "pubkey"
        const val EXTRA_RELAYS = "relays"
        const val EXTRA_SINCE = "since"

        private const val CHANNEL_STATUS = "mail-watcher"
        private const val CHANNEL_MAIL = "mail-new"
        private const val ID_STATUS = 1
        private const val PREFS = "notifier"
        private fun keySince(pubkey: String) = "since_$pubkey"
    }
}
