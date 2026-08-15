//! One task per relay: connect, subscribe to the owner's gift-wraps, and stream
//! arrivals to [`Shared`]. Reconnects with capped backoff until shutdown.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

use crate::Shared;

const SUB_ID: &str = "mail";
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// Run one relay until `shutdown` fires, reconnecting on any drop.
pub(crate) async fn watch_relay(url: String, shared: Arc<Shared>, shutdown: Arc<Notify>) {
    let mut backoff = BACKOFF_START;
    loop {
        // Race the connection attempt against shutdown so a stop during a
        // reconnect exits promptly.
        tokio::select! {
            _ = shutdown.notified() => return,
            result = run_once(&url, &shared, &shutdown) => {
                match result {
                    // A clean shutdown-driven exit.
                    RunOutcome::Shutdown => return,
                    // Connection ended; back off, then retry.
                    RunOutcome::Disconnected => {}
                }
            }
        }

        tokio::select! {
            _ = shutdown.notified() => return,
            _ = tokio::time::sleep(backoff) => {}
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

enum RunOutcome {
    Shutdown,
    Disconnected,
}

/// A single connection lifecycle: connect, subscribe, pump messages.
async fn run_once(url: &str, shared: &Arc<Shared>, shutdown: &Notify) -> RunOutcome {
    let stream = match tokio_tungstenite::connect_async(url).await {
        Ok((stream, _resp)) => stream,
        Err(err) => {
            log::warn!("[notifier] connect {url} failed: {err}");
            return RunOutcome::Disconnected;
        }
    };
    log::info!("[notifier] connected {url}");
    // Successful connect resets backoff for the *next* drop by the caller only
    // implicitly; report connectivity up.
    shared.set_relay_connected(true);

    let (mut write, mut read) = stream.split();

    // {kinds:[1059], "#p":[owner], since}: every gift-wrap addressed to us from
    // `since` onward. The relay replays history, then streams live arrivals.
    let req = json!([
        "REQ",
        SUB_ID,
        {
            "kinds": [1059],
            "#p": [shared.config.owner_pubkey_hex],
            "since": shared.config.since_secs,
        }
    ]);
    if let Err(err) = write.send(Message::Text(req.to_string().into())).await {
        log::warn!("[notifier] REQ to {url} failed: {err}");
        shared.set_relay_connected(false);
        return RunOutcome::Disconnected;
    }

    let outcome = loop {
        tokio::select! {
            _ = shutdown.notified() => break RunOutcome::Shutdown,
            msg = read.next() => match msg {
                Some(Ok(Message::Text(text))) => handle_frame(text.as_str(), shared),
                Some(Ok(Message::Ping(data))) => {
                    let _ = write.send(Message::Pong(data)).await;
                }
                Some(Ok(Message::Close(_))) | None => break RunOutcome::Disconnected,
                Some(Ok(_)) => {} // Binary/Pong/Frame: ignore.
                Some(Err(err)) => {
                    log::warn!("[notifier] {url} read error: {err}");
                    break RunOutcome::Disconnected;
                }
            }
        }
    };

    shared.set_relay_connected(false);
    outcome
}

/// Parse one relay→client frame and report any new gift-wrap it carries.
fn handle_frame(text: &str, shared: &Arc<Shared>) {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(text) else {
        return;
    };
    match items.first().and_then(Value::as_str) {
        // ["EVENT", <sub>, <event>]
        Some("EVENT") => {
            let Some(event) = items.get(2) else { return };
            let Some(id) = event.get("id").and_then(Value::as_str) else {
                return;
            };
            let created_at = event
                .get("created_at")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            shared.report_if_new(id, created_at);
        }
        // ["EOSE", <sub>] — end of stored events; nothing to do.
        // ["NOTICE"/"CLOSED", ...] — log for diagnostics.
        Some("NOTICE") | Some("CLOSED") => {
            log::info!("[notifier] relay message: {text}");
        }
        _ => {}
    }
}
