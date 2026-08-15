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

- `WatchConfig { owner_pubkey_hex, relays, since_secs }` — all public data. The
  host persists the newest `created_at` it saw and passes it back as
  `since_secs` so a restart never re-notifies old mail.
- `NotifierDelegate` — host callback interface (`on_new_mail`, `on_connectivity`).
- `Watcher::start(config, delegate) -> Arc<Watcher>` / `Watcher::stop()` — owns
  its own Tokio runtime on a dedicated thread, so Kotlin/Swift callers need none.

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

- [x] **Phase 1 — core crate** (this): key-free relay watcher + UniFFI surface,
      compiling and unit-tested on host.
- [ ] **Phase 2 — Android native**: cross-compile to `jniLibs`, generate Kotlin
      bindings, wrap in a **foreground service** (the "background too" decision)
      that holds the `Watcher` and posts local notifications on `on_new_mail`.
- [ ] **Phase 3 — Capacitor plugin**: `start({pubkey, relays})` / `stop()` from
      JS; the client calls it after login with the account pubkey + resolved
      kind-10050 relays, and persists `since` between runs.
- [ ] **Phase 4 — iOS**: same crate via a Notification Service Extension. Note:
      iOS forbids persistent background sockets, so true background delivery
      there will need a push wake-up — a separate design when iOS ships.
