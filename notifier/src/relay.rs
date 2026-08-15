//! Relay I/O, in two shapes that share connect + framing:
//!
//! - [`watch_relay`] — an always-on subscription that streams live arrivals and
//!   reconnects until shutdown (the "instant" mode).
//! - [`poll_relay`] — a bounded fetch: connect, read stored events up to EOSE,
//!   return them, disconnect (the WorkManager periodic-poll mode).

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

use crate::{Shared, WatchConfig};

const SUB_ID: &str = "mail";
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// The `REQ` for every gift-wrap addressed to the owner from `since` onward.
fn make_req(config: &WatchConfig) -> String {
    json!([
        "REQ",
        SUB_ID,
        {
            "kinds": [1059],
            "#p": [config.owner_pubkey_hex],
            "since": config.since_secs,
        }
    ])
    .to_string()
}

/// A parsed relay→client frame, reduced to what either mode needs.
pub(crate) enum Frame {
    /// An `EVENT`: gift-wrap id, its Unix timestamp, and the raw event JSON.
    Event { id: String, created_at: u64, json: String },
    /// `EOSE` — the relay has sent all stored events for our subscription.
    Eose,
    /// Anything else (NOTICE, CLOSED, unknown) — nothing actionable.
    Other,
}

pub(crate) fn parse_frame(text: &str) -> Frame {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(text) else {
        return Frame::Other;
    };
    match items.first().and_then(Value::as_str) {
        Some("EVENT") => {
            let Some(event) = items.get(2) else { return Frame::Other };
            let Some(id) = event.get("id").and_then(Value::as_str) else {
                return Frame::Other;
            };
            let created_at = event.get("created_at").and_then(Value::as_u64).unwrap_or(0);
            Frame::Event {
                id: id.to_string(),
                created_at,
                json: event.to_string(),
            }
        }
        Some("EOSE") => Frame::Eose,
        _ => Frame::Other,
    }
}

// --- bounded poll (WorkManager mode) ---------------------------------------

/// Connect, read stored gift-wraps up to EOSE, then close. Returns
/// `(id, created_at, wrap_json)` for each. The caller bounds this with a
/// timeout; a slow or unreachable relay simply yields whatever it sent so far.
pub(crate) async fn poll_relay(url: &str, config: &WatchConfig) -> Vec<(String, u64, String)> {
    let mut out = Vec::new();
    let stream = match tokio_tungstenite::connect_async(url).await {
        Ok((stream, _)) => stream,
        Err(err) => {
            log::warn!("[notifier] poll connect {url} failed: {err}");
            return out;
        }
    };
    let (mut write, mut read) = stream.split();
    if write.send(Message::Text(make_req(config).into())).await.is_err() {
        return out;
    }

    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Text(text)) => match parse_frame(text.as_str()) {
                Frame::Event { id, created_at, json } => out.push((id, created_at, json)),
                // Stored events are complete; no need to sit on a live socket.
                Frame::Eose => break,
                Frame::Other => {}
            },
            Ok(Message::Ping(data)) => {
                let _ = write.send(Message::Pong(data)).await;
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(err) => {
                log::warn!("[notifier] poll {url} read error: {err}");
                break;
            }
        }
    }
    let _ = write.send(Message::Close(None)).await;
    out
}

// --- always-on watch (instant mode) ----------------------------------------

/// Run one relay until `shutdown` fires, reconnecting on any drop.
pub(crate) async fn watch_relay(url: String, shared: Arc<Shared>, shutdown: Arc<Notify>) {
    let mut backoff = BACKOFF_START;
    loop {
        tokio::select! {
            _ = shutdown.notified() => return,
            outcome = run_once(&url, &shared, &shutdown) => {
                if matches!(outcome, RunOutcome::Shutdown) {
                    return;
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

async fn run_once(url: &str, shared: &Arc<Shared>, shutdown: &Notify) -> RunOutcome {
    let stream = match tokio_tungstenite::connect_async(url).await {
        Ok((stream, _resp)) => stream,
        Err(err) => {
            log::warn!("[notifier] connect {url} failed: {err}");
            return RunOutcome::Disconnected;
        }
    };
    log::info!("[notifier] connected {url}");
    shared.set_relay_connected(true);

    let (mut write, mut read) = stream.split();
    if let Err(err) = write.send(Message::Text(make_req(&shared.config).into())).await {
        log::warn!("[notifier] REQ to {url} failed: {err}");
        shared.set_relay_connected(false);
        return RunOutcome::Disconnected;
    }

    let outcome = loop {
        tokio::select! {
            _ = shutdown.notified() => break RunOutcome::Shutdown,
            msg = read.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if let Frame::Event { id, created_at, json } = parse_frame(text.as_str()) {
                        shared.report_if_new(&id, created_at, &json);
                    }
                }
                Some(Ok(Message::Ping(data))) => {
                    let _ = write.send(Message::Pong(data)).await;
                }
                Some(Ok(Message::Close(_))) | None => break RunOutcome::Disconnected,
                Some(Ok(_)) => {}
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
