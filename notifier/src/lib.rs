//! Key-free Nostr inbox-arrival watcher.
//!
//! The mail app receives mail as NIP-17 **gift-wraps** (kind 1059) addressed to
//! the owner's pubkey (a `p` tag), delivered on the owner's kind-10050 DM
//! relays. Reading a message's *contents* needs the private key, but the mere
//! *arrival* of a p-tagged gift-wrap is already the "you have new mail" signal —
//! and that needs only public data: the pubkey and the relay list.
//!
//! So this crate holds no key material and never decrypts. It keeps a
//! subscription open to each relay for `{kinds:[1059], #p:[owner], since}`,
//! de-duplicates arrivals by event id, and calls back into the host once per
//! genuinely-new wrap. The host (an Android foreground service today, an iOS
//! extension later) turns each callback into a local OS notification.
//!
//! It owns its own Tokio runtime on a dedicated thread, so foreign callers
//! (Kotlin/Swift via UniFFI) start it with one call and receive callbacks with
//! no runtime of their own.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tokio::runtime::Runtime;
use tokio::sync::Notify;

mod relay;

uniffi::setup_scaffolding!();

/// What to watch. All fields are public data — no secret ever crosses here.
#[derive(Debug, Clone, uniffi::Record)]
pub struct WatchConfig {
    /// Inbox owner, 32-byte public key as lowercase hex.
    pub owner_pubkey_hex: String,
    /// The owner's kind-10050 DM relays (wss:// URLs). Watched in parallel.
    pub relays: Vec<String>,
    /// Only report wraps created at or after this Unix time (seconds). The host
    /// persists the newest `created_at` it has seen and passes it back on the
    /// next start, so a restart does not re-notify old mail.
    pub since_secs: u64,
}

/// A gift-wrap returned by [`poll_once`]. `wrap_json` is the full kind-1059
/// event (public ciphertext only) so a signer-equipped host can unwrap it for
/// sender/subject; a metadata-only host uses just `id` + `created_at`.
#[derive(Debug, Clone, uniffi::Record)]
pub struct GiftWrap {
    pub id: String,
    pub created_at: u64,
    pub wrap_json: String,
}

/// One bounded poll of every relay: connect, read stored gift-wraps addressed to
/// the owner from `config.since_secs` onward up to EOSE, then disconnect.
/// Returns the arrivals, de-duplicated by id across relays. Blocks until all
/// relays finish or `timeout_secs` elapses (per relay), so a WorkManager worker
/// can call it directly on its background thread. Holds no key and never
/// decrypts — the battery-friendly counterpart to the always-on [`Watcher`].
#[uniffi::export]
pub fn poll_once(config: WatchConfig, timeout_secs: u64) -> Vec<GiftWrap> {
    let runtime = Runtime::new().expect("build tokio runtime");
    runtime.block_on(async move {
        let per_relay = std::time::Duration::from_secs(timeout_secs.max(1));
        let fetches = config.relays.iter().map(|url| async {
            tokio::time::timeout(per_relay, relay::poll_relay(url, &config))
                .await
                .unwrap_or_default()
        });
        let results = futures_util::future::join_all(fetches).await;

        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for wraps in results {
            for (id, created_at, wrap_json) in wraps {
                if created_at < config.since_secs {
                    continue;
                }
                if seen.insert(id.clone()) {
                    out.push(GiftWrap { id, created_at, wrap_json });
                }
            }
        }
        out
    })
}

/// Implemented by the host to receive watcher events. Callbacks fire on the
/// watcher's runtime threads and must return promptly — post to a handler and
/// get out; do not block.
#[uniffi::export(callback_interface)]
pub trait NotifierDelegate: Send + Sync {
    /// A previously-unseen gift-wrap addressed to the owner arrived.
    ///
    /// `created_at` is the wrap's Unix timestamp (seconds); the host should
    /// track the maximum to advance `since_secs` across restarts. `wrap_json`
    /// is the full kind-1059 event as received — public ciphertext only, no
    /// secret. A metadata-only host ignores it; a host with a NIP-55/NIP-46
    /// signer can hand it off to be unwrapped (wrap → seal → rumor) to enrich
    /// the notification with sender/subject. Kept here so that enrichment never
    /// requires a change to this key-free core.
    fn on_new_mail(&self, event_id: String, created_at: u64, wrap_json: String);

    /// At least one relay is connected (`true`) or all are disconnected
    /// (`false`). Drives the foreground-service notification's status text.
    fn on_connectivity(&self, any_connected: bool);
}

/// Shared, cheaply-cloned state handed to each relay task.
pub(crate) struct Shared {
    pub(crate) config: WatchConfig,
    pub(crate) delegate: Box<dyn NotifierDelegate>,
    /// Event ids already reported, so the same wrap seen on multiple relays (or
    /// re-sent after a reconnect) notifies at most once.
    seen: Mutex<HashSet<String>>,
    /// How many relay tasks currently hold a live connection, so connectivity
    /// transitions (0↔N) are reported exactly once.
    connected_count: Mutex<usize>,
}

impl Shared {
    /// Report a wrap if its id is new. Returns `true` when it was reported.
    /// `wrap_json` is forwarded verbatim for optional host-side unwrapping.
    pub(crate) fn report_if_new(&self, event_id: &str, created_at: u64, wrap_json: &str) -> bool {
        if created_at < self.config.since_secs {
            return false;
        }
        {
            let mut seen = self.seen.lock().unwrap();
            if !seen.insert(event_id.to_string()) {
                return false;
            }
        }
        self.delegate
            .on_new_mail(event_id.to_string(), created_at, wrap_json.to_string());
        true
    }

    /// Track a relay connecting/disconnecting and emit connectivity edges.
    pub(crate) fn set_relay_connected(&self, connected: bool) {
        let mut count = self.connected_count.lock().unwrap();
        let was_any = *count > 0;
        if connected {
            *count += 1;
        } else if *count > 0 {
            *count -= 1;
        }
        let now_any = *count > 0;
        if now_any != was_any {
            self.delegate.on_connectivity(now_any);
        }
    }
}

/// A running watch. Dropping it, or calling [`Watcher::stop`], tears down every
/// relay connection and stops the runtime.
#[derive(uniffi::Object)]
pub struct Watcher {
    shutdown: Arc<Notify>,
    // Held so the runtime lives as long as the watcher; taken and shut down
    // (non-blocking) on stop.
    runtime: Mutex<Option<Runtime>>,
}

#[uniffi::export]
impl Watcher {
    /// Start watching. Spawns the runtime and one task per relay, then returns
    /// immediately; arrivals surface through `delegate`.
    #[uniffi::constructor]
    pub fn start(config: WatchConfig, delegate: Box<dyn NotifierDelegate>) -> Arc<Self> {
        let shutdown = Arc::new(Notify::new());
        let shared = Arc::new(Shared {
            config,
            delegate,
            seen: Mutex::new(HashSet::new()),
            connected_count: Mutex::new(0),
        });

        let runtime = Runtime::new().expect("build tokio runtime");
        for url in shared.config.relays.clone() {
            let shared = Arc::clone(&shared);
            let shutdown = Arc::clone(&shutdown);
            runtime.spawn(async move {
                relay::watch_relay(url, shared, shutdown).await;
            });
        }

        Arc::new(Self {
            shutdown,
            runtime: Mutex::new(Some(runtime)),
        })
    }

    /// Stop watching. Idempotent.
    pub fn stop(&self) {
        self.shutdown.notify_waiters();
        if let Some(runtime) = self.runtime.lock().unwrap().take() {
            // Non-blocking: aborts tasks and reclaims threads in the background,
            // so a foreign caller on the main thread never stalls.
            runtime.shutdown_background();
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        mail: Mutex<Vec<(String, u64)>>,
        connectivity: Mutex<Vec<bool>>,
    }

    impl NotifierDelegate for Arc<Recorder> {
        fn on_new_mail(&self, event_id: String, created_at: u64, _wrap_json: String) {
            self.mail.lock().unwrap().push((event_id, created_at));
        }
        fn on_connectivity(&self, any_connected: bool) {
            self.connectivity.lock().unwrap().push(any_connected);
        }
    }

    fn shared(since_secs: u64, rec: &Arc<Recorder>) -> Shared {
        Shared {
            config: WatchConfig {
                owner_pubkey_hex: "ff".repeat(32),
                relays: vec![],
                since_secs,
            },
            delegate: Box::new(Arc::clone(rec)),
            seen: Mutex::new(HashSet::new()),
            connected_count: Mutex::new(0),
        }
    }

    #[test]
    fn reports_each_new_id_once_and_respects_since() {
        let rec = Arc::new(Recorder::default());
        let s = shared(100, &rec);

        assert!(s.report_if_new("a", 150, "{}"));
        assert!(!s.report_if_new("a", 150, "{}")); // duplicate id
        assert!(!s.report_if_new("b", 50, "{}")); // before `since`
        assert!(s.report_if_new("c", 100, "{}")); // exactly `since` is included

        assert_eq!(
            *rec.mail.lock().unwrap(),
            vec![("a".into(), 150), ("c".into(), 100)]
        );
    }

    #[test]
    fn parses_event_and_eose_frames() {
        use crate::relay::{parse_frame, Frame};

        let event = r#"["EVENT","mail",{"id":"abc","created_at":1723,"kind":1059}]"#;
        match parse_frame(event) {
            Frame::Event { id, created_at, json } => {
                assert_eq!(id, "abc");
                assert_eq!(created_at, 1723);
                assert!(json.contains("\"kind\":1059"));
            }
            _ => panic!("expected Event"),
        }
        assert!(matches!(parse_frame(r#"["EOSE","mail"]"#), Frame::Eose));
        assert!(matches!(parse_frame(r#"["NOTICE","hi"]"#), Frame::Other));
        assert!(matches!(parse_frame("not json"), Frame::Other));
    }

    #[test]
    fn connectivity_reports_only_on_edges() {
        let rec = Arc::new(Recorder::default());
        let s = shared(0, &rec);

        s.set_relay_connected(true); // 0 -> 1: edge
        s.set_relay_connected(true); // 1 -> 2: no edge
        s.set_relay_connected(false); // 2 -> 1: no edge
        s.set_relay_connected(false); // 1 -> 0: edge

        assert_eq!(*rec.connectivity.lock().unwrap(), vec![true, false]);
    }
}
