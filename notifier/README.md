# notifier

A **key-free, local** Nostr inbox-arrival watcher, written in Rust so one core
serves Android now and iOS later (via UniFFI), and can be lifted into our other
apps unchanged.

## What it does

The mail app receives mail as NIP-17 **gift-wraps** (kind `1059`) addressed to
the owner's pubkey (a `p` tag) on the owner's kind-10050 DM relays. Reading a
message needs the private key — but the **arrival** of a p-tagged gift-wrap is
already the "you have new mail" signal, and that needs only public data.

So this crate:

- holds **no key material** and never decrypts,
- keeps a subscription open per relay for `{kinds:[1059], #p:[owner], since}`,
- de-duplicates by event id (same wrap on N relays → one notification),
- calls the host back once per new arrival.

The host turns each callback into a **local** OS notification. Scope for v1 is
therefore deliberately small: metadata-only ("you have new mail"), no sender or
subject preview (that would require the key and couple us to the signer).

## Shape

Two modes over the same key-free core:

- **Poll (chosen for Android)** — `poll_once(config, timeout_secs) -> Vec<GiftWrap>`:
  one bounded fetch (connect → read stored wraps to EOSE → disconnect), returns
  new arrivals de-duplicated by id, blocks until done. No foreground service, no
  persistent socket → negligible battery. Driven by a WorkManager periodic job.
- **Instant (optional, unused on Android for now)** — `Watcher::start(config,
  delegate)` / `stop()`: an always-on subscription that streams live arrivals via
  `NotifierDelegate` (`on_new_mail`, `on_connectivity`), owning its own Tokio
  runtime. Real-time, but needs a foreground service to stay alive — the battery
  cost we opted out of.

`WatchConfig { owner_pubkey_hex, relays, since_secs }` is all public data. The
host persists the newest `created_at` it saw and passes it back as `since_secs`
(the Android worker polls from `since - slack` and dedups by id) so a poll never
re-notifies old mail.

TLS is rustls (pure Rust) so there is no OpenSSL to cross-compile for the NDK.

## Build / test

```sh
cargo test                     # host-side unit tests (dedupe, since, connectivity)
```

Android `.so` + Kotlin bindings (later phase):

```sh
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o <jniLibs> build --release
cargo run --bin uniffi-bindgen -- generate \
  --library target/aarch64-linux-android/release/libnotifier.so \
  --language kotlin --out-dir <android module>/java
```

## Roadmap

- [x] **Phase 1 — core crate**: key-free relay watcher + UniFFI surface,
      compiling and unit-tested on host.
- [x] **Phase 2 — Android native**: cross-compile to `jniLibs` + Kotlin bindings
      (`scripts/build-notifier.sh`, run by a Gradle task). Landed first as a
      foreground service, then **switched to a WorkManager periodic poll**
      (`MailPollWorker` + `pollOnce`) for battery; `NotifierPlugin` schedules it.
      Verified via `:app:assembleDebug`.
- [ ] **Phase 3 — JS wiring**: the client calls `Notifier.start({pubkey,
      relays})` after login (resolved kind-10050 relays), requests
      POST_NOTIFICATIONS, and `stop`s on logout. Then run on-device.
- [ ] **Enrichment (optional)**: unwrap the forwarded `wrap_json` via a
      NIP-55/NIP-46 signer to show sender/subject (host-side; ncryptsec stays
      metadata-only). See the top-level project notes.
- [ ] **Phase 4 — iOS**: same crate via a Notification Service Extension / BG
      refresh. iOS forbids persistent background sockets, but a periodic poll
      maps cleanly onto BGAppRefreshTask.
