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
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::Message;

use crate::{Shared, WatchConfig};

const SUB_ID: &str = "mail";
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// A browser-like User-Agent sent on every WebSocket upgrade. Some relays sit
/// behind Cloudflare and reject the default client UA (e.g. relay.0xchat.com
/// answers the upgrade with HTTP 403, relay.damus.io with 503). The rejection
/// is at the TLS/HTTP layer, before any Nostr frame — so NIP-42 AUTH can't run
/// (the socket never opens) and, separately, this key-free crate holds no
/// signing key to produce an AUTH event anyway. Spoofing a browser UA gets
/// past the CDN gate; matches the bridge's `relay-socket.ts` UA exactly.
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/// Build the WebSocket upgrade request for `url` with the browser User-Agent.
fn client_request(url: &str) -> Result<Request<()>, tokio_tungstenite::tungstenite::Error> {
    let mut req = url.into_client_request()?;
    req.headers_mut().insert("User-Agent", USER_AGENT.parse().unwrap());
    Ok(req)
}

/// The `REQ` for every gift-wrap addressed to the owner from `since` onward.
///
/// Mail wraps now carry a `["k","1301"]` tag (see `sealAndWrap`), so we *could*
/// filter `#k` to skip non-mail 1059s (e.g. NIP-17 DMs). We deliberately don't
/// yet: mail sent before the tag existed has no `k`, and filtering on it would
/// silently drop those. Once tagged mail is ubiquitous we can add
/// `"#k": ["1301"]` here and lose nothing.
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
    let req = match client_request(url) {
        Ok(req) => req,
        Err(err) => {
            log::warn!("[notifier] poll request build {url} failed: {err}");
            return out;
        }
    };
    let stream = match tokio_tungstenite::connect_async(req).await {
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
    let req = match client_request(url) {
        Ok(req) => req,
        Err(err) => {
            log::warn!("[notifier] request build {url} failed: {err}");
            return RunOutcome::Disconnected;
        }
    };
    let stream = match tokio_tungstenite::connect_async(req).await {
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
