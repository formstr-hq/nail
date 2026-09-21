# Session Log

## 2026-09-20 — Local relay pruned kind-1059 mail out of the offline cache

Context consulted (rule 15): the 2026-09-19 nginx/discovery entry, the NIP-42
AUTH entry (whose open item already flagged this: "the local relay TTLs
non-protected kinds at 7 days and 1059 is not protected"), and the send-wrap-API
entry.

### Root cause

`@formstr/local-relay`'s `defaultPrunePolicy()` protects only profiles (0),
contacts (3), relay lists (10002) and the 10000–19999 replaceable range.
**Kind 1059 (the mail/DM gift-wrap ciphertext) is not protected**, so the
Persistence prune pass removes cached wraps once `created_at` is older than
`defaultTtlSeconds` (7 days), and the 50k hard cap can evict them oldest-first
before that. The local relay IS the offline mailbox (IndexedDB replay serves
mail before any relay answers), so this is exactly "my local emails vanish" —
and it explains why a just-received message is present while one from hours/days
ago is not. (The observed "2 hours" is downstream of this plus refetch/relay
timing; the deterministic defect is the missing protection.)

### Is a relay-side delete triggered by pruning? No.

Traced every `EventDB.onChange` listener: `RelayCore` acts only on `add`/`reset`
(no network); `Persistence` writes the removal to the local StorageAdapter;
`RelayService` calls `outbox.remove(id)` (drops pending outbound debt). Nothing
publishes a kind-5 deletion. Only the explicit user delete
(`lib/nostr/delete.ts` `publishGiftwrapDeletion`, two NIP-09 events) deletes
upstream. Prune is local-only: it makes the device forget, never deletes on
relays.

### What changed

1. **`client/web/src/app/lib/nostr/prunePolicy.ts` (new).**
   `mailPrunePolicy()` starts from `defaultPrunePolicy()` and adds
   `KIND_GIFTWRAP` (1059), `KIND_MAIL_META` (34578, read/archived/trashed state)
   and `KIND_SETTINGS` (30078) to `protectedKinds`. Docstring states the
   local-only invariant and that the durable fix belongs upstream.
2. **`relay.worker.ts`** passes it as `persistence: { prunePolicy:
   mailPrunePolicy() }` — the supported `RelayServiceOptions` seam.
3. **`prunePolicy.ts.test`** — asserts the package default does NOT protect
   these (so the test fails if upstream fixes it and the override becomes
   redundant), that the mail kinds are protected, that no existing protected kind
   is lost, and that TTLs/cap are otherwise unchanged.

This is a client-side override of an upstream default; the proper fix is in
`common-packages/packages/local-relay` `defaultPrunePolicy` (or an opt-in), and
that should be raised separately.

### Verification (exact)

- Package behavior, Node: an 8-month-old kind-1059 event with the base policy
  `prune()` → removed=1, gone; with `mailPrunePolicy()` → removed=0, still
  stored.
- Standalone local-relay (0.6.2) against live relays with the app's exact three
  inbox filters: 422 wraps fetched; a second worker over the same storage
  cold-replayed all 422 before any upstream answer and after an immediate
  observe-before-hydration — so fetch/cold-replay themselves are sound and the
  prune is the actionable defect.
- `pnpm --filter mailstr-web test` — 39 files / 316 tests passed.
- `pnpm --filter mailstr-web lint` — 0 errors.
- `pnpm --filter mailstr-web build` — ok (`NODE_OPTIONS=--experimental-strip-types`
  for the pre-existing prerender/Node 22.17 issue). Built
  `dist/assets/relay.worker-*.js` adds 1059/34578/30078 to the protected set.

### Open items

- Push the protection upstream (`@formstr/local-relay`): either protect 1059 by
  default or expose per-host kind protection; nail's override is a stopgap.
- `KIND_MAIL_META` protects kind-34578 *events* by kind — but the store also
  holds every other addressable app's 34578s, so this over-protects. Acceptable
  for now (small; correctness over memory), revisit with a kind+namespace rule.

## 2026-09-19 — nginx proxy for mail discovery; live end-to-end probe

Context consulted (rule 15): the 2026-09-17 send-wrap-API entry, its open item
"Wire nginx to proxy `/.well-known/nostr-mail.json` → `/api/mails/discovery`",
and the prerendered/nginx vhost entry, per the last-3 rule.

### What changed

1. **`~/Dev/formstr/nginx-prod/sites-enabled/mailstr.app`** (separate repo
   `formstr-hq/nginx`, branch `fix/mail-discovery-well-known`, commit `091742c`;
   pushed, PR open). Added a `location = /.well-known/nostr-mail.json` block
   proxying to `http://127.0.0.1:5000/api/mails/discovery` with open CORS
   (GET/OPTIONS), mirroring the existing `nostr.json` route. This closes the
   open item above: previously the well-known URL fell through to the landing
   `try_files` and returned `200 text/html`, so `fetchMailDiscovery`
   (`lib/nostr/bridgeSend.ts`) failed to parse it and silently relay-fell-back.

2. No app code changed. The `e2e-nostr` live probe was a one-off, run against
   prod and then deleted — it is not part of the CI-matched suite.

### Verification (exact)

- `nginx -t` on the edited vhost (nginx:alpine + stub cert): syntax ok.
- Live before: `https://mailstr.app/.well-known/nostr-mail.json` → 200
  `text/html` (landing fallback). After deploy: 200
  `application/json; charset=utf-8`, `access-control-allow-origin: *`,
  body `{version:1, bridge_pubkey, send_wrap_endpoint, relays}`.
- Live end-to-end (throwaway key, no mail delivered): fetch discovery via the
  fixed well-known URL → build a real kind-1301 mail rumor with the shared
  protocol `buildMailRumor`/`sealAndWrap`, p-tagged to the discovered bridge →
  NIP-98 sign `POST {wrap}` → `https://api.formstr.app/api/mails/send-wrap` →
  **202 `{"accepted":true}`** (backend → bridge `/v1/relay` → `handleWrap`).
  Negative controls: no-auth POST → **401**; kind-1 wrap → **400
  `wrap must be kind 1059`**. So the API is reached, authed, and gated — not
  accepting everything.

### Why

Discovery is the preferred road to the bridge (no relay round-trip). The
well-known proxy makes the documented URL live; the backend fallback remains
for deploys where this nginx change has not landed. The live probe confirms the
whole chain (discovery → NIP-98 → backend → bridge ingest) works from a real
client, not just in unit tests.

## 2026-09-13 — Frontend audit rev 2; `shared/` deleted; `mobile/` joins the pnpm workspace

Context: docs/Session-Log.md was empty at session start (no prior entries to
consult). Work done on branch `app_restructure`, base `67528bc`.

### What changed

1. **`docs/FRONTEND_AUDIT.md` → revision 2.** Re-verified every revision-1
   finding against the merged `web/` app. Recorded resolved items
   (client/landing merge, router, god-component splits, `zustand/persist`)
   and new findings (cross-account state leaks B1; signer-failure
   misclassification D3; unbounded metadata replay D5; worker-boot error
   gaps D6/D7; recipient dedup D8; PGP discovery D9; Android-back exit D12;
   orphaned `app/index.css` E-6; no web CI E-1).
2. **Deleted `shared/`** (`shared/signer-ui.ts`, 257 L). Repo-wide grep found
   zero importers (no `@signer-ui` alias, no Dockerfile `COPY shared/`); it
   was dead code per AGENTS rule 14. The login-UI dedup it was meant to host
   is still open under audit A2, with the named fix being upstream
   `@formstr/signer` config/slots.
3. **Merged `mobile/` into the root pnpm workspace:**
   - `pnpm-workspace.yaml` now lists `web` + `mobile`.
   - Deleted `mobile/package-lock.json` (1240 L); all mobile deps resolve
     from the root `pnpm-lock.yaml`.
   - `mobile/package.json`: `build` uses `pnpm run`; Capacitor deps aligned
     to the web-resolved 7.6.x set (core 7.6.8 → 7.6.9; cli 7.6.8;
     status-bar 7.0.6; typescript ~5.9.3).
   - `.github/workflows/android-apk.yml`: one
     `pnpm install --frozen-lockfile` + `pnpm --filter mailstr-mobile run
     build` (was `pnpm --dir web install --no-frozen-lockfile` + `npm ci`).
   - `mobile/README.md`: workspace build instructions; documents that
     `cap sync` regenerates `capacitor.settings.gradle` with `.pnpm` paths.
4. **`AGENTS.md`:** repo map (`mobile/`, no `shared/`), rule 8, command
   reference (workspace-level), and the Known offenders table rewritten
   against audit revision 2.
5. **Audit doc annotated** with the actions taken (F-1 done, E-2 resolved).

### Verification (exact commands, at this working tree)

- `pnpm install` (workspace: 2 projects) — ok.
- `pnpm --filter mailstr-web build` — ok (prerender + `/mails` shell).
- `pnpm --filter mailstr-web test` — 24 files / 209 tests passed.
- `pnpm --filter mailstr-web lint` — 0 errors, 11 known warnings.
- `pnpm --filter mailstr-web e2e` — 13/13 passed.
- `pnpm --filter mailstr-mobile run build` — web build → `www/` →
  `cap sync` ok (5 plugins registered).
- `pnpm --filter mailstr-mobile run apk:debug` — `assembleDebug`
  BUILD SUCCESSFUL; `app-debug.apk` produced.
- Docker-install simulation (`--frozen-lockfile --filter mailstr-web` from a
  root-context copy without `mobile/package.json`) — lockfile resolves.

### ADR-001: `mobile/` is a pnpm-workspace member; `shared/` is deleted

- **Status:** accepted (2026-09-13).
- **Context:** `web/` and `mobile/` are one product on one build contract:
  `mobile/scripts/build-web.mjs` runs `web/`'s build and copies its `dist`
  into the Capacitor bundle; `mobile/` has no first-party JS source. They
  were resolved by two package managers (root pnpm for `web`, npm +
  committed `package-lock.json` for `mobile`), which had already drifted
  (`@capacitor/core` 7.6.8 vs 7.6.9). Separately, `shared/signer-ui.ts` was
  intended to host shared login-UI helpers but had no importer; those
  helpers are duplicated inline in `SignupWizard`/`LoginPage`.
- **Decision:** add `mobile` to `pnpm-workspace.yaml`; delete its npm
  lockfile and resolve everything from the root lockfile; build/CI use pnpm
  only. Delete `shared/` rather than keep or wire a file with no callers;
  cross-app logic belongs in `web/src/lib/`, and the login-UI dedup's named
  home is upstream `@formstr/signer`.
- **Consequences:**
  - One install, one lockfile, no version drift; Android CI installs with
    `--frozen-lockfile` (drift now fails the build).
  - `cap sync` rewrites `mobile/android/capacitor.settings.gradle` with
    pnpm store paths; the file stays tracked and generated, never hand-edited.
  - Gradle does not consume JS dependencies directly (only via `cap sync`),
    so pnpm's symlinked `node_modules` layout is not on Gradle's classpath
    except through the resolved plugin project paths.
  - `web/Dockerfile` is unaffected: its install is
    `--filter mailstr-web` and the root-context copy still resolves.
  - A future `shared/` re-creation is explicitly rejected by AGENTS rule 8;
    shared frontend logic goes to `web/src/lib/`.

### Open follow-ups (from audit rev 2, priority order)

1. B1 — reset account-scoped state (settings, PGP session, overlays) on
   switch/logout.
2. D3 + D5 — distinguish signer failures from routine decrypt failures; bound
   kind-34578 replay.
3. D8 + D9 — recipient dedup; fix PGP discovery's `attempted`/`discovering`.
4. D6 + D7 — surface worker-boot failures.
5. A2 — land the `@formstr/signer` upstream login-UI fix and delete the
   duplicated tuning in `SignupWizard`/`LoginPage`.
6. E-1 — add `web-ci.yml`.
7. E-6 — diff and delete `web/src/app/index.css`; delete `types/nostr.ts`.

## 2026-09-13 — Frontend audit rev 3: all findings fixed

Context consulted: the entry above (rev-2 audit + workspace merge), which is
the only prior session in this log. Work continued on `app_restructure`.

### What changed

1. **All audit findings fixed** (detail table in `docs/FRONTEND_AUDIT.md`
   revision 3). Highlights:
   - **Cross-account reset (B1/B2):** `resetAccountScopedState()` runs
     synchronously before any await in `switchTo`/`logout`/`removeAccount`;
     settings store, PGP passphrase cache, overlays, and the relay worker all
     reset. `indexKeyInflight` is keyed by pubkey; `initialized` is store state.
   - **Signer-failure taxonomy (D3/D11):** `SignerError` carries
     `SIGNER_ERROR_TAG`; protocol `unwrapAndVerify` returns `signer-error`
     (not the routine `not-for-us`); `DecodeQueue` retries bounded (2×) and
     reports exhaustion; `decodeMailMeta` rethrows instead of swallowing.
   - **Bounded metadata replay (D5/E-3):** `useMailMeta` uses a persisted
     per-account `since` cursor, `seenMetaIds` dedup, and the new generic
     `BoundedDecodeQueue<T>` (shared with `useInbox`).
   - **Settings durability (B5/B6):** `save()` is a serialized patch API that
     commits only after relay acceptance; all callers send owned fields only.
   - **Delivery correctness (D8/D9):** recipient dedup at both text and
     resolved-route layers; PGP discovery settles-then-marks and always
     clears its spinner.
   - **Failure surfacing (D4/D6/D7):** bridge-unavailable banner, worker boot
     errors over the channel, `getLocalRelay()` inside the try, sync-error
     banner for failed kind-34578 publishes (B3).
   - **Misc (D1/D2/D10/D12/D13/D14):** delete-reason notice, single-source
     filing flags, deferred blob revoke, `exitApp()` on back-at-root,
     notification-watcher ordering, single-stored tombstones.
   - **Structure (A1/A2/A3/C1-C4):** `SignupWizard` 906→423,
     `LoginPage` 550→55, `EmailView` split; login-UI dedup moved to
     `web/src/lib/loginUi.ts` (the deleted `shared/` file's intended job);
     shared `Overlay` primitive; `cx()` helper; **0 lint warnings**.
   - **Hygiene (E-1/E-3/E-4/E-5/E-6):** `web-ci.yml` added; tests 209→231;
     `MailApp` lazy-loaded (main chunk 1.18 MB → 586 KB); dead
     `app/index.css` + `types/nostr.ts` deleted.
2. **`AGENTS.md` Known offenders** rewritten to the rev-3 residual list
   (6 tracked items, each with a reason to keep tolerating it).

### Verification (at this working tree)

- `pnpm --filter mailstr-web build` — pass.
- `pnpm --filter mailstr-web lint` — 0 errors, 0 warnings.
- `pnpm --filter mailstr-web test` — 28 files / 231 tests pass.
- `pnpm --filter mailstr-web e2e` — 13/13 pass.
- `pnpm --filter mailstr-mobile run build` — pass (web build → www → cap sync).

### ADR-002: signer failures are a first-class, retryable error class

- **Status:** accepted (2026-09-13).
- **Context:** `unwrapAndVerify` classified every `nip44Decrypt` throw as
  `not-for-us` (routine — someone else's ciphertext). But a NIP-46 bunker
  timeout/refusal also throws there, so the decode queue silently dropped
  real mail during bunker warm-up (D3). Retrying was impossible because the
  two cases were indistinguishable, and not retrying was impossible to
  justify once a message is "ours".
- **Decision:** introduce a tagged `SignerError` (`SIGNER_ERROR_TAG` in the
  shared protocol types) thrown by the web signer wrapper on timeout, and a
  distinct `signer-error` unwind reason. Failure consumers treat it as
  `{ routine: false, retryable: true }` and retry bounded (2 attempts, 1.5 s
  backoff), reporting exhaustion through the normal failure callback.
- **Consequences:**
  - A swamped bunker no longer loses mail permanently; a dead one surfaces
    after bounded work (rule 11 bound is explicit).
  - The protocol module now exports one predicate (`isSignerFailure`) used by
    both the client and its tests; the bridge never produces the tag (its
    `keySigner` is in-process), so bridge behavior is unchanged.
  - Only the timeout is tagged — a genuine decryption error is still
    `not-for-us`, so retry work stays proportional to real failures.

### Open follow-ups

- B4 scaling: `emails` map still re-renders `EmailList` per add; revisit if
  mailboxes grow into the thousands.
- E-4: add direct unit tests for `useInbox`/`useMailMeta` before extending.
- `mailState`/`wrapKeys` historical entries still accumulate (D14 residual).

### ADR-003: session epoch guards async store writers

- **Status:** accepted (2026-09-13).
- **Context:** clearing account-scoped stores synchronously on switch/logout
  (the B1 fix) removes the *existing* state, but not work already in flight.
  Decode completions, settings publishes/loads, and mail-action error writers
  all call `set()` asynchronously; without a guard, old-account results land in
  the new account's stores — the same class of bug B1 fixed, just time-shifted.
- **Decision:** `web/src/app/store/sessionEpoch.ts` holds a module-level
  counter. `resetAccountScopedState()` bumps it; async writers capture the
  value at start and drop their result (including error-path writes) when the
  session has moved. A standalone module rather than store state, so the
  settings store can import it without a cycle through the account store.
- **Consequences:** cross-account writes are structurally impossible for every
  guarded writer; a new async writer must follow the same capture-and-check
  pattern. The guard is cheap (integer compare) and orthogonal to React
  lifecycle flags like `alive`, which only cover unmount, not account change.

### Re-verification pass (same day)

Re-read the whole diff after the fix pass and closed five residual issues the
first cut introduced or left; full detail in `docs/FRONTEND_AUDIT.md` rev 3
("Review pass"):

1. **Async writers crossing an account reset** — added
   `store/sessionEpoch.ts`; `settings.load/save`, `useInbox`, `useMailMeta`,
   and `useMailActions` (apply + deleteForever) capture the epoch and drop
   results from a superseded session. `settings.session.test.ts` proves a load
   and a save that resolve after a switch do not commit.
2. **Metadata cursor boundary** — `since` inclusive + `<` guard now re-checks
   the boundary second, so a sibling mail's state event published in the same
   second is not lost; previously the `<=` guard dropped it.
3. **Duplicate RFC 2822 headers on deduped recipients** — the wrap was
   deduped but `To`/`Cc` still listed the address twice; headers are now
   deduped To-first.
4. **`useMailMeta` `getLocalRelay()` outside a try** — the same D6 crash class
   the `useInbox` fix addressed; now guarded.
5. **`CUSTOM_SENDER` defined twice** — one export now, consumed by both the
   hook and `AddressesSection`.

Also fixed: stale doc comments (duplicated worker comment, `useMailActions`
"logged, not surfaced"), and a comma-operator `reset()` in the settings store.

Verification after this pass: bridge 88/88, bridge + e2e-nostr `tsc` clean,
web build/lint/235 tests/13 e2e green, and the assembled mobile bundle served
headlessly to confirm the lazy `App` chunk resolves under `/mails/` with no
console errors.

## 2026-09-14 — Flat `client/` layout: `mobile/` removed, `web/` → `client/web/`

Context consulted: the two entries above (rev-2 workspace merge + ADR-001,
rev-3 audit fix pass + ADR-002/003). The rev-3 work was committed first
(`frontend audit rev 3…`) so this restructure is a standalone, reviewable diff.

### What changed

1. **One `client/` folder, no `mobile/`.** `git mv mobile client` then
   `git mv web client/web`. The native shell is now `client/` itself
   (`package.json`, `capacitor.config.ts`, `scripts/`, `android/`, future
   `ios/`) and the web app is nested at `client/web/`. History preserved via
   git rename detection.
2. **Package rename:** `mailstr-mobile` → `mailstr-client`; description now
   says native shell (Android/iOS) instead of "Android wrapper". `mailstr-web`
   keeps its name. CI filters updated to match.
3. **Workspace:** `pnpm-workspace.yaml` lists `client` + `client/web`;
   `pnpm-lock.yaml` regenerated (importers `client:` / `client/web:`), still
   `--frozen-lockfile`-clean.
4. **Alias depth +1** because `client/web` is two levels below the root:
   `vite.config.ts`, `vitest.config.ts`, `tsconfig.app.json` (`@protocol`,
   `include`/`exclude`), and `playwright.config.ts` (`../../e2e-nostr`).
5. **Build scripts:** `client/scripts/build-web.mjs` resolves
   `repo/client/web`; `build-notifier.sh` renames its `mobile` var to `client`
   (relative offsets unchanged, as is the Gradle `../scripts/...` invocation).
6. **Docker:** compose points at `client/web/Dockerfile`; the Dockerfile
   copies `client/web`/`client/package.json` and builds `cd client/web`, and
   now copies the protocol to `/app/nostr-bridge` so the `../../nostr-bridge`
   alias actually resolves (the pre-move `/nostr-bridge` copy did not match
   the `/app/...` alias — latent bug, fixed and verified by a real image
   build). `.dockerignore` ignores only the native dirs (`client/android`,
   `client/ios`, `client/www`) instead of the whole `client`.
7. **Docs:** `AGENTS.md` (title, repo map, rules 8, offenders, commands,
   verification), root `README.md` (repo table was stale from before the
   merge — now lists `client/web`, `client`, `notifier`), `client/README.md`,
   `docs/ARCHITECTURE.md` (component table + callers + protocol section),
   `docs/fiat-iap-plan.md` (paths retargeted to the merged layout).
8. **`scripts/render-app-icon.py`:** `RES` points at `client/android/...`;
   the dead `client/public` + `landing/public` favicon writes (deleted in the
   merge, guarded by `exists()`) are replaced by the live
   `client/web/public/favicon.svg` target, and the unreferenced
   `favicon-512.png` output (no web manifest consumes it) is dropped.

### Verification (at this working tree)

- `pnpm install` — workspace resolves `client` + `client/web`; lockfile
  regeneration is the only change after the initial move.
- `pnpm --filter mailstr-web lint` — clean.
- `pnpm --filter mailstr-web test` — 30 files / 235 tests pass.
- `pnpm --filter mailstr-web build` — prerender + `/mails` shell ok.
- `pnpm --filter mailstr-web e2e` — 13/13 pass.
- `pnpm --filter mailstr-client run build` — web build → `client/www` →
  `cap sync android` (5 plugins); `capacitor.settings.gradle` unchanged
  (depth preserved).
- `pnpm --filter mailstr-client run apk:debug` — BUILD SUCCESSFUL;
  `client/android/app/build/outputs/apk/debug/app-debug.apk` (+ notifier
  `.so`/bindings cross-compiled by the Gradle preBuild task).
- `docker build -f client/web/Dockerfile .` — image builds; `/build-output`
  contains `index.html` + `mails/index.html` + assets. `docker compose
  config` resolves.

### ADR-004: one flat `client/` tree; `mobile/` is removed (supersedes ADR-001)

- **Status:** accepted (2026-09-14). Supersedes ADR-001 (2026-09-13), whose
  workspace-membership decision this restructure carries forward but whose
  two-directory shape it replaces.
- **Context:** ADR-001 merged `mobile/` into the pnpm workspace so one
  lockfile served both. The remaining split (`web/` + `mobile/`) still named
  the native shell by one of its two platforms, while the roadmap
  (`docs/fiat-iap-plan.md` phase 3b) adds `client/ios`. A flat
  `client/{web,android,ios}` tree makes the shell's platform folders siblings
  under a neutral name and matches the plan the iOS work will follow.
- **Decision:** `mobile/` is removed as a directory; its contents become
  `client/` (the native shell). `web/` moves to `client/web/` (the sole
  workspace member that carries app source). Workspace lists both `client`
  (shell, for Capacitor deps) and `client/web` (app); the package is renamed
  `mailstr-client`. The shell stays a pure consumer: `client/scripts/
  build-web.mjs` builds `client/web` and assembles `www/`; no web code
  imports the shell.
- **Consequences:**
  - Relative offsets that assumed the old depth were updated once:
    `@protocol`/e2e aliases (+1 level), Dockerfile paths, CI workdir/artifact
    paths, and `render-app-icon.py`. `capacitor.settings.gradle` and the
    Gradle→notifier script path needed no change (same depth).
  - `mailstr-mobile` references in historical docs (this log's earlier
    entries, `docs/FRONTEND_AUDIT.md`) stay as the record of what ran then;
    living docs use `mailstr-client`.
  - iOS can now be added with `npx cap add ios` inside `client/` with no
    path churn (macOS + Xcode required; not scaffolded here).
  - The Dockerfile's protocol copy bug — `/nostr-bridge` vs the `/app/
    nostr-bridge` the alias resolves to — is fixed as part of this move and
    verified with a real image build.


## 2026-09-14 — Restore `cursor: pointer` on buttons (Tailwind v4 preflight regression)

Context consulted: the three entries above (rev-2 workspace merge + ADR-001,
rev-3 audit + ADR-002/003, flat `client/` layout + ADR-004).

### What changed

1. **Root cause.** The mail client was ported Tailwind 3 → 4 in merge phase 2
   (`16bf719`). Tailwind v4's preflight intentionally dropped v3's
   `button, [role="button"] { cursor: pointer }` rule ("Buttons use the
   default cursor", v4 upgrade guide), so every native `<button>` in the app
   — mail rows, folder rows, composer chrome, Send — silently regressed to
   the browser's `default` arrow. The only `cursor: pointer` left was in the
   `@formstr/signer` stylesheet and three hand-written rules in `index.css`,
   which is why the login modal still looked right and the mailbox did not.
2. **Fix.** Added the upgrade guide's documented compat shim to
   `client/web/src/index.css` under `@layer base`:
   `button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer }`.
   The `:not(:disabled)` guard keeps `disabled:cursor-not-allowed`/opacity
   affordances honest; the signer's own higher-specificity rules are
   unaffected.
3. **Regression test.** New `client/web/e2e/app/cursor.spec.ts` asserts the
   computed cursor on a sidebar folder button and the shared `Button`
   ("Write") as `pointer`, and the composer's disabled Send as
   `not-allowed`. Verified it fails on the pre-fix stylesheet (first
   assertion reads `default`) and passes with the fix.

### Verification (at this working tree)

- `pnpm --filter mailstr-web build` — pass; the compiled CSS contains
  `button:not(:disabled),[role=button]:not(:disabled){cursor:pointer}`.
- `pnpm --filter mailstr-web e2e` — 14/14 pass (new spec included); the new
  spec fails when the `index.css` hunk is stashed (13/14), proving the guard.
- `pnpm --filter mailstr-web test` — 30 files / 235 tests pass.
- `pnpm --filter mailstr-web lint` — clean.

### Follow-ups

- Tailwind v4 targets Safari 16.4+ while AGENTS rule 6 pins the browser floor
  at Safari 14 / iOS 15 (the relay worker still ships IIFE for that reason).
  This is pre-existing from the phase-2 port, not introduced here; flagging
  it as an architecture question rather than silently widening the floor.

## 2026-09-15 — Sender proof moves from decode-time to render-time (ADR-005); multi-bridge tri-state resolution

Context consulted: the three entries above (rev-3 audit + ADR-002/003, flat
`client/` layout + ADR-004, cursor regression), per rule 15.

### Root cause

Users saw legitimate bridge (SMTP-origin) mail rendered as "unverified
sender" with the mail bridge's kind-0 profile instead of the real `From`,
intermittently and per-message. `decodeGiftWrap` computed `senderProof` once,
at decode time, against `ctx.bridgePubkey` — which is `null` until the
asynchronous `_smtp@<domain>` NIP-05 probe resolves. Any wrap decoded in that
window fell through to `none`; the result was stored on the `Email`, and
`seenIds` meant the same wrap was never re-decoded, so the wrong verdict was
permanent for the session. The check itself was correct — the failure was
asking the question before the answer existed.

### What changed

1. **`Email` carries raw sender facts only.** `from` + `senderProof` are
   replaced by `fromHeader` (the claimed RFC 2822 header, verbatim) and the
   existing `senderPubkey` (the kind-13 seal). `receive.ts` no longer probes
   NIP-05 or fetches kind-0 at decode — it is one less signer-round-trip-
   adjacent cost per message and removes the ordering dependency entirely.
2. **New `lib/mail/senderProof.ts`** derives `SenderProof` from live inputs:
   `own-seal` → any resolved bridge matching the seal → NIP-05 match →
   `checking` (a check still running) → `bridge-unavailable` (all bridges
   failed) → `none`. `SenderProof` gains `checking` and
   `bridge-unavailable`; `displaySender`/`effectiveSender` return the header
   when backed and the npub otherwise.
   Because derivation runs per render, the NIP-05 probe fan-out is now bounded
   (`MAX_CONCURRENT_PROBES = 4` in `lib/nostr/nip05.ts`, on top of the existing
   per-address dedup and cache), so a mailbox full of distinct senders cannot
   issue unbounded lookups at once.
3. **Multi-bridge tri-state resolution** (`lib/nostr/bridge.ts`):
   `bridgeTargets()` builds the default `_smtp@<ownDomain>` plus every
   `settings.bridgeDomains` override, deduped; `BridgeProbe` is
   `resolving | resolved | failed` per target; `resolveBridgeProbes()` reports
   each transition as it lands. `outboundBridge()` preserves the old send
   precedence (a resolved override wins; a configured-but-failed override
   never silently falls back to the default).
4. **`store/bridge.ts`** holds the probe list and a shared NIP-05 verdict map,
   both live and never persisted; `resetAccountScopedState()` clears it.
   `useResolveContext` drives the probes and exposes `resolving` /
   `bridgeError` / `retry()` (wired into the app's manual reload).
5. **`useSenderIdentity` / `useEffectiveSenders`** re-derive per render from
   the bridge store, the NIP-05 cache (`peekNip05` added for a synchronous
   cache hit), and kind-0. No verdict is memoized across bridge changes; the
   list row, reading pane, debug panel, drafts, contacts, and alias filter all
   consume the derived sender. Side-effecting consumers (contacts, alias
   filing) treat `checking` as the key — never a header nothing backs.
6. **UI:** `SenderProofLine`/`SenderProofTrace` gained badge-less `checking`
   and `bridge-unavailable` rows; the composer shows a neutral "looking up
   your email bridge" banner while resolving instead of the old immediate
   error.
7. **Tests:** new `senderProof.test.ts` (every branch, incl. the
   `checking → bridge-seal` flip and multi-bridge cases) and `bridge.test.ts`
   (targets, incremental probes, outbound precedence); `receive.test.ts`
   rewritten to assert raw facts + derivation; fixtures across
   draft/contacts/aliasFilter/store/component tests updated.
   `e2e/app/sender-proof.spec.ts` drives the real app: a real account, a
   route-stubbed `_smtp` probe, and a genuine bridge-sealed gift wrap
   published to the mock relay — asserting the claimed `From` and "via email
   bridge" render.

### Verification (at this working tree)

- `pnpm --filter mailstr-web test` — 33 files / 273 tests pass.
- `pnpm --filter mailstr-web lint` — clean.
- `pnpm --filter mailstr-web build` — pass (tsc -b + vite + SSR + prerender).
- `pnpm --filter mailstr-web e2e` — 15/15 pass (new spec included).

### ADR-005: Sender proof is derived at render time, never stored on the email

- **Status:** accepted (2026-09-15).
- **Context:** verification rule 6 ("`From:` is authoritative only where the
  claim is backed") depends on bridge identity, which is resolved by an
  asynchronous NIP-05 lookup with a multi-second timeout. Computing the rule
  during decode coupled a permanently-stored display verdict to a transient,
  ordering-dependent resolution state: mail decoded before the probe landed
  was mislabelled for the life of the cache, with no re-evaluation path
  short of clearing local storage. The bug was reported as intermittent
  because it is a race.
- **Decision:** decode stores raw facts (`fromHeader`, `senderPubkey`);
  `lib/mail/senderProof.ts` derives the verdict from the message plus the
  current bridge/probe/NIP-05 state on every render. Resolution becomes
  plural (default + overrides) and tri-state (resolving / resolved / failed),
  with `checking` and `bridge-unavailable` as first-class reader-visible
  outcomes. No derived UI result is memoized across a state change: when a
  bridge resolves, every consumer re-derives.
- **Consequences:**
  - A message's sender label can change under the reader (checking →
    bridge-seal, or checking → key); this is intended — it is the honest
    reflection of when the check completes.
  - The verdict is no longer persisted, so it cannot go stale or leak across
    accounts; bridge probes reset on account switch.
  - `useInbox` no longer depends on `bridgePubkey`, so resolving a bridge
    late no longer tears down and reopens the kind-1059 subscription.
  - Derivation touches kind-0 only for senders shown by key (the only case a
    profile name is rendered), keeping the list render cheap.
  - Adding a future bridge source (e.g. per-recipient discovery) is a change
    to `bridgeTargets`, not to the verification rule.

### Follow-ups

- `settings.bridgeDomains[0]` remains the only override path; the Settings UI
  does not yet expose the list. Multi-bridge verification is implemented and
  tested, but the UI for selecting several bridges is not part of this change.

## 2026-09-15 — Deploy fix: `VITE_BRIDGE_DOMAIN` missing from the docker build args

Context consulted: the ADR-005 entry above plus the rev-3/cursor entries, per
rule 15. Deployment target is the `chhotu` host at `/root/Clients/nail`
(mailcow sidecar + `stg.mailstr.app`), pulling from the GitHub remote.

### Root cause

The deployed staging bundle had the production bridge domain baked in:
`const Ge="mailstr.app"` with zero `stg.mailstr.app` occurrences in the mail
chunk. `docker-compose.yml` passed `VITE_API_BASE_URL`, `VITE_MAIL_DOMAIN`,
etc. as build args but **not `VITE_BRIDGE_DOMAIN`**, and `client/web/Dockerfile`
had no `ARG`/`ENV` for it either. `.dockerignore` excludes `.env`, so Vite's
build inside the image could not read the server's
`VITE_BRIDGE_DOMAIN=stg.mailstr.app` — `lib/nostr/constants.ts` fell through to
its `?? 'mailstr.app'` default. Introduced by the phase-4 merge (`5990c39`),
which folded the old `client-deploy` compose service (which did pass the arg)
into the single `web-deploy` service.

Effect: bridge verification probed `_smtp@mailstr.app` (the production bridge)
on staging, and outbound legacy mail routed through the production bridge.

### What changed

- `docker-compose.yml`: `VITE_BRIDGE_DOMAIN: ${VITE_BRIDGE_DOMAIN:-mailstr.app}`
  build arg on `web-deploy`.
- `client/web/Dockerfile`: documented, declared (`ARG`) and exported (`ENV`)
  `VITE_BRIDGE_DOMAIN` alongside the other Vite args.

### Verification (on chhotu)

- Server fetched `0a53104` (pushed to `origin` = GitHub; the local ngit remote
  is a different identity and the server tracks GitHub).
- `docker compose up -d --build` — rebuilt and copied dist to
  `/var/www/stg.mailstr.app`.
- Served chunk `assets/App-Ba3YzHY5.js` now reads
  `const Ge="stg.mailstr.app"` (grep count 1; previous chunk had
  `"mailstr.app"` and 0 staging matches); `https://stg.mailstr.app/mails/`
  returns 200 and references the new chunk.



## 2026-09-17 — Outbound mail rides the backend send-wrap API (relay fallback)

Context consulted: the 2026-09-15 sender-proof ADR-005 entry, the
`VITE_BRIDGE_DOMAIN` deploy-fix entry directly above, and the rev-3 audit entry,
per rule 15. Branch `fix/bugfixes` (from `403db91`, latest `origin/main`).

### What changed

1. **`lib/nostr/bridgeSend.ts` (new).** Discovery + the NIP-98 send-wrap call:
   - `fetchMailDiscovery(domain)` fetches `/.well-known/nostr-mail.json`, and
     falls back to the backend's `/api/mails/discovery` when the well-known
     proxy is not wired yet. Cached (positive 10 min), bounded (4 s), and
     fail-open — any error/404/malformed body returns null so the caller
     relays instead.
   - `sendWrapViaApi({ wrap, discovery, signer })` POSTs `{ wrap }` to the
     discovered `send_wrap_endpoint`, NIP-98 signed over the canonical URL with
     the body hashed. Never throws; failures are `{ ok: false, status, reason }`.
2. **`lib/mail/deliver.ts` (new).** The delivery half, split out of `send.ts`:
   - Bridge-bound wraps (p-tagged to the resolved bridge) go to the API first.
     Only the ones it declines fall back to relay publish.
   - Nostr-direct wraps and the self-copy always relay.
   - A discovery document naming a *different* bridge than NIP-05 resolved is
     treated as "API unavailable" (relay fallback), not an error.
   - Undeliverable *real* recipients throw as before; the self-copy stays
     best-effort.
3. **`lib/mail/send.ts`.** `sendMail` now delegates to `deliverWraps`; the old
   inline relay loop is gone. `buildWraps` takes `BuildWrapsParams` (params
   minus `active`) so wire-format tests need no signer. `SendMailParams` gains
   `active` (NIP-98 needs `ActiveSigner.signEvent`, which takes an unsigned
   template a `ProtocolSigner` cannot sign).
4. **`ComposeModal.tsx`** passes `active` through.
5. **Tests:** `bridgeSend.test.ts` (10) and `deliver.test.ts` (7) cover
   discovery parsing/caching/fallback, the NIP-98 call and its failure modes,
   and the API-first/relay-fallback routing matrix.

### Verification (exact, at this working tree)

- `pnpm --filter mailstr-web test` — 35 files / 290 tests passed.
- `pnpm --filter mailstr-web lint` — 0 errors.
- `pnpm --filter mailstr-web e2e` — 15/15 passed (after installing the
  Chromium build the local cache was missing).
- `pnpm --filter mailstr-web build` — ok **with `NODE_OPTIONS=--experimental-strip-types`**;
  without it, `prerender.js` (imports `src/lib/config.ts`) dies under
  `ERR_UNKNOWN_FILE_EXTENSION` on Node 22.17. This is **pre-existing** —
  reproduced with the tree stashed at base `403db91` — and not caused here.
- Live contract checked: `GET https://api.formstr.app/api/mails/discovery`
  returns the document; `POST /api/mails/send-wrap` is 401 unauthenticated (so
  it is deployed and NIP-98-gated). `https://mailstr.app/.well-known/nostr-mail.json`
  currently 404s — hence the backend fallback candidate.

### Why

The relay path only works if the bridge's Nostr subscription observes the
client's publish; the HTTP ingress feeds the identical `handleWrap` path with no
relay round-trip. This is the mechanism the formstr-backend docstring references
for external email invites. The API is an optimization, never a new hard
dependency: every failure falls through to the original relay publish.

### Open items

- Wire nginx to proxy `/.well-known/nostr-mail.json` → `/api/mails/discovery`
  on `mailstr.app` (and staging) so the documented discovery URL is live; the
  backend fallback makes this non-blocking.
- The bridge must have `/v1/relay` enabled (`SEND_API_KEY` set) for the API
  path to accept wraps; when it 400/502s, delivery falls back to relays.

## 2026-09-17 — NIP-42 AUTH was never implemented (the real "missing desktop mail" bug)

Context consulted: the send-wrap-API entry directly above, the ADR-005
sender-proof entry, and the rev-3 audit entry, per rule 15. Branch
`fix/more-bugfixes` (from `b76a125`).

### What actually happened (and a correction)

An earlier entry in this session recorded a `#k:1301` inbox filter as the fix
for "mail shows on mobile but not desktop". **That diagnosis was wrong and the
change was reverted**; the entry was removed rather than left to mislead. It is
recorded here because the reasoning error is instructive: the bridge does stamp
`["k","1301"]` (`sealAndWrap`), and `notifier/src/relay.rs` does filter on it —
but on the affected account **0 of 417 kind-1059 wraps on `nos.lol` carried
`k=1301`** (414 untagged, 3 NIP-17 kinds), because the mail predates the tag and
a tag cannot be backfilled (the event id commits to it). A `#k`-only filter
therefore hid the entire mailbox rather than surfacing it.

### Root cause

`@formstr/local-relay` never performed NIP-42 AUTH. `RelayConnection.onMessage`
switched on `EVENT`/`EOSE`/`CLOSED`/`OK` only — `AUTH` frames were discarded
(`// NOTICE / AUTH: ignored for now`). The `onAuth` hook named in that file's doc
comment did not exist on the handlers interface, and `SignerPort.sign()` was
never called outside tests. `docs/USAGE.md` §12 documented the behaviour as if
it were implemented.

Consequence: a relay that challenges is silently skipped. The affected account's
kind-10050 list included such a relay, so its mail there was invisible — while
non-AUTH relays kept working, which is exactly why the symptom looked
account-specific and intermittent.

Evidence: `wss://relay.stg.formstr.app` answers a REQ with `AUTH <challenge>` and
then sends nothing (no EVENT, no EOSE, no CLOSED). The package's own test for the
auth-required path asserted the *opposite* of correct behaviour — it asserted
that `CLOSED ... auth-required` causes the subscription to be forgotten.

### What changed

**`common-packages` (`fix/nip42-auth`, merged #30, published `local-relay` 0.6.2):**
`RelayConnection` now parses `AUTH`, builds the kind-22242 template bound to the
relay's URL + challenge, signs it through the existing `SignerPort` RPC (plumbed
via `RelayPool.setOnAuth` from `RelayService`), replies `["AUTH", event]`, and
replays every active REQ (pre-challenge REQs are not honoured). One sign per
challenge per socket, never concurrent; cleared on reconnect. Refusal, a throwing
signer, or a mid-sign socket drop all leave the relay unauthenticated as before.

The merged PR also had to **carry the published 0.6.1 dm-publish work**: 0.6.1
was cut from `fix/dm-aware-publish-routing`, which was never on `main`, so `main`
was *behind* npm and its `publish(event)` lacked the `opts: { relays }` that nail
already calls. Publishing from `main` would have silently regressed gift-wrap
DM-inbox routing. PR #30 cherry-picked `ec5d52b` onto `main` first, then stacked
AUTH as 0.6.2. It also added tests for 0.6.1's uncovered branches — the published
0.6.1 lineage actually **failed the repo's own 99% branch floor** (98.89%).

**`nail` (`fix/more-bugfixes`):**
- `lib/mail/inboxFilter.ts` — `inboxFilters(pubkey)` returns a three-way
  partition (one upstream REQ each; the worker dedups by event id):
  1. `#k:['1301']` whole-history (tagged mail, uncrowdable by DMs);
  2. `#p` + `until` the tag rollout — the pre-tag history, reachable no other
     way (no filter negation exists in Nostr);
  3. `#p` + `since` the rollout — post-tag untagged mail (third-party senders).
- `useInbox.ts` passes all three filters to `relay.observe`.
- `package.json` — `@formstr/local-relay` bumped `^0.6.1` → `^0.6.2` (the real
  registry version; the temporary `file:` tarball pin used for live testing was
  never committed).

### Verification (exact, at this working tree)

- common-packages (merged `09b0542`): 250 tests, `tsc --noEmit`, coverage gate
  99.12%. End-to-end test through the real signer RPC against a NIP-42 relay.
  Manually driven through the built package against a live NIP-42 relay:
  `REQ authed=false → AUTH valid=true → REQ authed=true → EVENT → EOSE`.
  Published 0.6.2 verified from the registry tarball (AUTH + `publish(event,
  opts?)` + `dmPublishTargets` all present).
- nail: 36 files / 294 tests, lint 0 errors, build ok (`NODE_OPTIONS=
  --experimental-strip-types`; pre-existing Node 22.17 `prerender.js` issue),
  15/15 e2e.

### Open items

- **Local-store prune:** the local relay TTLs non-protected kinds at 7 days and
  1059 is not protected, so cached wraps older than a week are dropped; upstream
  refetch is the only recovery. A separate policy decision.
- `relay.stg.formstr.app` closes the socket (1006) even on an idle connection,
  so it is unusable independent of AUTH — worth its own investigation.

## 2026-09-19 — Add `wss://relay.formstr.app` as a default relay

Context consulted: the NIP-42 AUTH entry, the send-wrap-API entry, and the
rev-3 audit entry, per rule 15. Branch `feat/add-formstr-default-relay`, base
`498f3ea` (`origin/main`).

### What changed

Purely additive: our own relay is prepended to the mail stack's default relay
sets. No relay removed; env overrides still win; user NIP-17/NIP-65 lists still
take precedence where they already did.

1. **`client/web/src/app/lib/nostr/constants.ts`** — `DEFAULT_RELAYS` fallback
   now `relay.formstr.app` first, ahead of nos.lol / primal.net / snort.social.
   `HARDCODED_RELAY` (primal.net) is left as-is: it is the always-on read/write
   floor, and our relay is already unconditionally present because it now leads
   `DEFAULT_RELAYS` and `withHardcodedRelay(DEFAULT_RELAYS)` unions it in.
2. **`client/web/src/lib/signer.ts`** — `NOSTRCONNECT_RELAYS` (NIP-46 bunker
   pairing) gains `relay.formstr.app` first.
3. **`nostr-bridge/src/config.ts`** — server-side `bootstrapRelays`,
   `defaultRelayUrl`, and `bridgeRelays` defaults now name `relay.formstr.app`
   first (`defaultRelayUrl` is the single fallback target). All remain
   env-overridable (`BOOTSTRAP_RELAYS`, `DEFAULT_RELAY_URL`, `BRIDGE_RELAYS`).
4. **`nostr-bridge/scripts/{send-and-listen,send-test-mail}.ts`** — dev script
   `RELAY_URL` defaults updated to match.

### Verification (exact, at this working tree)

- `client/web`: `vitest run src/app/lib/nostr/relays.test.ts
  src/app/lib/nostr/bridgeSend.test.ts` — 17 passed (relays.test asserts
  against the imported `DEFAULT_RELAYS`, so it tracks the new first entry).
- `client/web`: `tsc --noEmit` — ok. `eslint` on the two touched files — 0
  errors.
- `nostr-bridge`: `tsc --noEmit` — ok. Full `vitest run` — 26 failed / 59
  passed, **all failures pre-existing**: reproduced with this change stashed
  (`crypto.getRandomValues must be defined`, a Node 22.17 environment issue in
  `protocol/mail.test.ts` et al.), not caused here.
- No bridge test asserts relay defaults (only `nostr-listener.test.ts` imports
  `config`, and it does not read the relay fields).

### Why

We now run `relay.formstr.app`. Preferring it by default keeps mail on our own
infrastructure for users who have not set their own relay lists, while the
existing public relays remain as fallbacks so delivery never depends on a
single relay.

## 2026-09-18 — PGP double-encryption: one owner for encryption (ADR-006)

Context consulted per rule 15: the 2026-09-17 send-wrap-API entry, the NIP-42
entry directly above, and the ADR-005 sender-proof entry. Work on `main` at
`498f3ea`, intended for the `pgp/double-encrypt` PR to ngit.

### Symptom and evidence

Mail from stg (`112@stg.mailstr.app`) to a Proton address arrived as a raw
armored PGP blob; mail from prod (`rama1@mailstr.app`) rendered fine. The raw
messages were decrypted with the recipient's key:

- stg: decrypting the delivered document yielded **a second armored PGP
  block**, which decrypted to the body.
- prod: decrypting the delivered document yielded the body directly.

Two PGP layers, applied by two different code paths. `d1ebb89` (the reported
prod commit) is an ancestor of `53d3244`/v0.2.0, and the prod bundle contains
both call sites — prod runs the same code.

### Root cause

`encryptBody` was called **twice per send**:

1. `ComposeModal.handleSend` (line ~251) — replaced `body` with the armored
   result before calling `sendMail`;
2. `send.ts buildWraps` — encrypted `params.body` again for each encryptable
   legacy recipient.

(1) predates (2). `6bd8a35` ("pgp fixes") added mixed per-leg encryption to
`send.ts` but left the composer call in place, so every send nested two layers.
The reason prod looked healthy is a second bug: `send.ts` passed **no
passphrase** to `encryptBody`, so on prod's passphrase-locked
`rama1@mailstr.app` key the call threw, and the `catch` silently demoted the
encryptable set to plaintext — leaving only the composer's layer. On stg the
alias key is unlocked, so the second layer succeeded.

**Fail-open encryption.** The `catch`-to-plaintext branch meant a locked key, a
wrong passphrase, or malformed key material all produced a *cleartext* send
with no signal — the send the user asked to protect is the one that leaks.

### What changed (nail `main`, 4 files)

1. **`lib/mail/send.ts` — the single encryption point.**
   - `SendMailParams` gains `encrypt?: boolean` (the composer's lock state) and
     `pgpPassphrase?: string`; `pgp` alone no longer implies encryption.
   - One `encryptBody` call builds one encrypted RFC 2822 document; it covers
     Nostr-direct recipients we hold a key for, legacy recipients we hold a key
     for, and always the self-copy. Recipients without a key get the plaintext
     document (mixed delivery) as before.
   - The `catch` now **fails closed**: `{ wraps: [], errors: ['Could not encrypt
     this message: …'] }` — never a silent cleartext send.
2. **`components/ComposeModal.tsx`** — drops the pre-encryption entirely; passes
   `encrypt`, `pgpPassphrase`, and the plaintext body. The passphrase prompt now
   fires only when the lock is on.
3. **`lib/pgp/compose.ts`** — recipient key resolution now mirrors
   `keyForAddress` (`allKeysForAddress`, which resolves own aliases *and*
   keyring entries) instead of keyring-only. Previously a recipient who was
   another own alias passed send's `keyed()` gate but threw inside
   `encryptBody`; the silent demote hid it. Also deletes the unused
   `decryptionHalvesFor` (rule 14).
4. **`lib/mail/send.test.ts`** — the mixed tests now pass `encrypt: true`; new
   tests pin: single-layer decryption (regression), lock-off stays plaintext,
   Nostr-direct encrypted copy, encrypted self-copy, fail-closed on a locked
   key with no passphrase, and success with the session passphrase.

### Verification (exact, at this working tree)

- `vitest run` (touched files): `send.test.ts` 22/22, `compose.test.ts` 3/3,
  `keyring.test.ts` 21/21, `openpgp.test.ts` 18/18.
- Full `pnpm --filter mailstr-web test`: 45 files, 322 passed / 12 failed — the
  12 are **pre-existing** on base `498f3ea` (untracked in-progress attachments
  work: `rfc2822`/`attachmentsTxt`/`blossom`/`addresses` tests); confirmed by
  stashing this diff and re-running (12 failed / 316 passed at base).
- `pnpm --filter mailstr-web lint` — 0 errors.
- `pnpm --filter mailstr-web build` — ok with `NODE_OPTIONS=
  --experimental-strip-types`, once untracked WIP that does not compile is moved
  aside (moved back after).

### ADR-006: PGP bodies are encrypted exactly once, in the send library

- **Status:** accepted (2026-09-18).
- **Context:** two encryption implementations existed (composer + send.ts).
  Having two produced nested ciphertext on any unlocked-key send and,
  worse, the send-side `catch` silently downgraded to plaintext on any key
  error. The composer cannot do it correctly anyway: it does not know which
  recipients are legacy vs Nostr-direct, and it must encrypt the *same*
  document for all recipients so the audience headers stay consistent.
- **Decision:** `lib/mail/send.ts` (`buildWraps`) owns PGP encryption. The
  composer passes intent (`encrypt`), key material (`pgp`), and the session
  passphrase — never an armored body. Encryption failure aborts the send with
  an error; there is no plaintext fallback.
- **Consequences:**
  - One code path means the mixed-delivery routing and the ciphertext can no
    longer disagree about who receives what.
  - Future attachment/HTML work has exactly one place to apply body protection
    (the encrypted document deliberately drops `bodyHtml` today).
  - The composer no longer needs PGP imports beyond the keyring lookup it uses
    for gating; the dynamic import in `send.ts` keeps openpgp out of the main
    bundle for plaintext sends.

### Open items

- A **send-side HTML body** (`bodyHtml`) is dropped from the encrypted document
  by design (an HTML part would carry the plaintext); rendering encrypted HTML
  mail is future work.
- The 12 pre-existing test failures and the non-compiling untracked attachments
  work belong to a separate in-flight feature and are untouched here.

## 2026-09-19 — Remove per-alias PGP key deletion (WKD unpublish unsupported)

Context consulted per rule 15: the ADR-006 entry above, the 2026-09-18
send-wrap entry, and the 2026-09-17 entry. Work on `main`.

### Why

Removing an alias key from Settings deleted only the local `settings.pgpKeys`
entry. The public half stays served at `mailstr.app/.well-known/openpgpkey/...`
with no way to revoke it: formstr-backend's WKD API has exactly three routes
(`wkdRoutes.ts` — GET `/policy`, GET `/hu/:hash`, PUT `/`) and no DELETE, and
`models/nip05.ts` exposes no clear/delete for `pgp_pubkey_b64`. Live probe
confirmed: unauthenticated `PUT /api/wkd` → 401 (route exists), `DELETE
/api/wkd` → 404 (route absent).

A "remove" that leaves the public key discoverable is a false revocation: the
user believes the key is gone, while every WKD lookup keeps returning it.

### What changed (2 files)

1. **`components/settings/pgp/AliasKeyRow.tsx`** — removed the Remove/Keep
   confirm UI, its `confirmRemove` state, and the `| null` half of `onSet`.
   Row keeps copy/export/republish.
2. **`components/PgpSettings.tsx`** — `setAliasKey` now only sets (no delete
   branch); signature is `(address, keypair: PgpKeypair)`.

### Deliberately left in place

`removeFromKeyring` / the correspondents-keyring Remove is untouched — that is
the user's own local cache of *other people's* keys, not a WKD publish, so
deleting it is correct and has no server-side counterpart.

### Re-add condition

Bring back key deletion only once formstr-backend ships
`DELETE /api/wkd` (NIP-98, ownership-checked, nulls `pgp_pubkey_b64` +
`wkd_hash`); the client remove path then must await the unpublish (or surface
its failure) before dropping the local key.

### Verification (exact, at this working tree)

- `pnpm --filter mailstr-web lint` — 0 errors.
- `pnpm --filter mailstr-web build` — ok (prerender + `/mails` shell).
- `pnpm --filter mailstr-web test` — 298 passed / 4 failed; confirmed
  pre-existing by stashing this diff and re-running (same 4 failed / 298
  passed at base): `api/addresses.test.ts` (3) + `mail/composeFields.test.ts`
  (1), the untracked attachments WIP noted in the previous entry.
- No dedicated AliasKeyRow/PgpSettings unit tests or e2e specs exist to update
  (grep over `*.test.*` and `e2e/app`).

## 2026-09-19 — Key rotation; passphrase-less key policy (ADR-007)

Context consulted per rule 15: the ADR-006 entry above, the WKD-unpublish entry
directly above, and the 2026-09-18 send-wrap entry. Work on `main`.

### WKD overwrite verification (asked first, before building rotation)

Republishing DOES replace the served key, no unpublish needed:
`publishWkdKeyHandler` → `setPgpKey` is an UPDATE on the nip05 row addressed by
`(nip05, domain)` (`models/nip05.ts:92-97`), recomputing the same `wkd_hash`;
`getPgpKeyByWkdHash` reads that row; nginx `proxy_pass`es with no cache
(`nginx/sites-enabled/mailstr.app:37-44`); the live response carries
`cf-cache-status: DYNAMIC` (Cloudflare bypasses). Verified end-to-end: `PUT
/api/wkd` unauthenticated → 401 (route exists), serve → 200 with the stored
bytes.

### Part 1 — passphrase-less keys (ADR-007)

Mailstr stores PGP private keys UNLOCKED, always:

- `generateKeySet`/`generateKey` lost their `passphrase` param — generation is
  passphrase-less (`openpgp.ts`).
- Generate UI lost the passphrase field; Import REJECTS a passphrase-protected
  private key (`readKeyInfo().encrypted`) with instructions to strip it — a
  locked key cannot sign/decrypt without an unlock step the app no longer
  prompts for in its normal flow.
- `encryptPrivateKey` remains, now with exactly one caller: the export dialog.
  Download is the only passphrase path, so a file never lands on disk in the
  clear while the stored key stays unlocked.

**Legacy locked keys stay supported on read**: a keypair already stored with
`passphraseProtected: true` still decrypts via the session-passphrase prompt
(`usePgpMessage`, `ComposeModal`) and still fails closed on send without its
passphrase (pinned in `send.test.ts`). Removing that path would brick existing
users' old mail — see part 2 for the supported escape hatch.

### Part 2 — rotate

- `lib/pgp/rotate.ts` (new): generate → SAVE → publish, in that order. A save
  failure aborts before publishing (WKD never advertises a key the user cannot
  use); a publish failure keeps the rotated key and reports it (Republish-to-WKD
  retries).
- `components/settings/pgp/RotateKeyDialog.tsx` (new): unmissable
  "You will not be able to view your previous messages encrypted to <address>"
  plus an acknowledgement checkbox; portaled to `<body>` like KeyExportDialog
  (the settings pane clips fixed overlays in the native WebView).
- `AliasKeyRow` gains Rotate; `PgpSettings.rotateKey` wires it, reading
  `pgpKeys` LIVE at save time (generation takes ~1s; a stale render snapshot
  could clobber a concurrent edit to another alias).

### ADR-007: Mailstr-generated PGP keys are always passphrase-less

- **Status:** accepted (2026-09-19).
- **Context:** the optional at-rest passphrase (design doc) conflicts with the
  app's actual use: decrypt/sign happen automatically on read and send, so a
  locked key either prompts constantly (NIP-46 signer round-trips make an
  unlock step expensive) or blocks mail. It also created the split behavior
  behind the 2026-09-18 double-encryption incident (prod's locked key silently
  demoted sends to plaintext).
- **Decision:** generated and imported keys are stored UNLOCKED. A passphrase
  exists only on EXPORTED copies (download is forced through
  `encryptPrivateKey`). Legacy locked keys keep decrypt/unlock support so old
  mail stays readable, and users can rotate to a new unlocked key (which is
  why export-before-rotate matters — the old key is only in settings, and
  rotation replaces it).
- **Consequences:**
  - Settings blob confidentiality rests entirely on NIP-44 to self — same as
    `mailIndexKey`; losing the Nostr key loses the PGP keys (unchanged from the
    original design).
  - No unlock friction on read/send for new keys; the session-passphrase cache
    remains for legacy keys only.
  - Rotation is the sanctioned way to shed a legacy locked key: export the old
    one if needed, rotate, and the alias ends up unlocked.

### Verification (exact, at this working tree)

- `pnpm --filter mailstr-web lint` — 0 errors.
- `pnpm --filter mailstr-web build` — ok (prerender + `/mails` shell).
- `pnpm --filter mailstr-web test` — 302 passed / 4 failed; the 4 are the
  pre-existing untracked attachments WIP failures
  (`api/addresses.test.ts` ×3, `mail/composeFields.test.ts` ×1) recorded in the
  entry above, unchanged here.
- New/updated: `lib/pgp/rotate.test.ts` 4/4 (save-before-publish ordering, save
  failure aborts publish, publish failure keeps key, fresh distinct keypair);
  `lib/pgp/openpgp.test.ts` 18/18 (locked fixture now built via
  `encryptPrivateKey` — the only way to lock a key post-policy);
  `lib/mail/send.test.ts` + `ComposeModal.test.tsx` 30/30 (legacy locked key
  still fails closed without a passphrase and sends with one).
- Rotation's WKD overwrite is backend-verified (above); no client e2e spec
  covers the Settings encryption pane yet (`e2e/app` has no PGP spec) — the
  unit suite is the pin for the orchestration.

### Amendment (same day) — import accepts a passphrase, then stores unlocked

The first pass of ADR-007 rejected passphrase-protected keys on import. That
was wrong for the workflow: a key exported from this app or from GPG is
routinely locked, and telling the user to strip it in GPG first is friction the
app can absorb.

Now: `unlockPrivateKey(armored, passphrase)` (`openpgp.ts`) decrypts a locked
key and re-emits its UNLOCKED armor; the new `ImportKeyForm` component
(extracted from `AliasKeyRow`, which was near the 300-line target) runs a
two-step flow — paste key → if `readKeyInfo().encrypted`, ask for the
passphrase → unlock → store the unlocked key with `passphraseProtected: false`.
The stored artifact is re-read after unlock so the fingerprint/identity come
from what is actually persisted. A wrong passphrase surfaces and stores
nothing. Unlocked keys still import in one step; public keys are still
rejected.

`encryptPrivateKey` now throws a named error on an already-locked key
(`encryptKey` would throw its own "Key packet is already encrypted"); the
already-locked branch in `KeyExportDialog` is the only legitimate path for
such a key.

Tests: `openpgp.test.ts` +3 (unlocked armor round-trips decrypt/sign; wrong
passphrase rejects; already-unlocked passthrough); `ImportKeyForm.test.tsx` 4/4
(two-step flow stores an unlocked key, wrong passphrase stores nothing,
one-step unlocked import, public-key rejection).

### Amendment 2 (same day) — one-click generate, WKD-gated install, npub row disabled

Three changes on top of the above, same day:

**1. Generate is one click again.** The generate panel (explanatory copy +
Generate/Cancel) is gone; the button generates and installs directly. The
passphrase field had already been removed in this session, so the panel was
pure friction. Copy about the passphrase-less policy now lives in the Field
hint instead.

**2. A key is only kept if WKD accepts it.** New orchestrator
`lib/pgp/install.ts` (`installAliasKey`), shared by first-time generate,
import, and rotate. Order: **save → publish**; on publish failure the save is
**rolled back** (restore `previous`, or remove the entry when the alias had
none — safe because the publish failed, so WKD never held it). This keeps the
user's rule ("if the API call fails for WKD, don't save the key") without the
worse failure mode a naive save-after-publish would have: a save that fails
after a successful publish would leave WKD advertising a key whose private half
was lost, making inbound mail to it unreadable. Saving first cannot lose mail;
the rollback restores the exact prior state. The one case where the key stays
stored and unpublished is a rollback failure, surfaced explicitly with the
Republish hint. `rotate.ts`/`rotate.test.ts` are superseded by
`install.ts`/`install.test.ts` (deleted; the rotate behavior is the same code
path with a non-null `previous`). `publishOwnKey` (the old fire-and-forget
publish) is deleted — dead once every path needs the failure.

**3. The npub bridge address row is disabled.** `<npub>@mailstr.app` has no
nip05 row (`nostr.json?name=npub15g…` returns `{"names":{}}`), so the backend's
ownership check rejects its WKD publish with 403 every time — under (2) that
alias could never install a key. The row renders inert with the reason
("no NIP-05 identity"). A legacy stored key on that row still exposes
copy/export, but Republish/Rotate are hidden (they can only 403).

Tests: `install.test.ts` 6/6 (save-before-publish order, save failure aborts
publish, publish failure rolls a fresh key out, publish failure restores the
rotated key, rollback failure keeps + warns, dual unlocked keypair);
`ImportKeyForm.test.tsx` 5/5 (adds "install failure keeps the form open");
`openpgp.test.ts` 21/21.

Verification at this working tree: lint 0 errors; build ok; `pnpm test` 312
passed / 4 failed — the same pre-existing attachments-WIP failures
(`api/addresses.test.ts` ×3, `mail/composeFields.test.ts` ×1), not caused by
this diff.

### WKD publish rollback and the npub address — noted limitation

The 403 on the npub address is a backend policy (the nip05-ownership check in
`wkdController`), not a client bug. If PGP for the npub bridge address is ever
wanted, it needs a backend route that accepts a pubkey-owned synthetic
identity — not a client change.

## 2026-09-19 — nginx: SPA fallback for the mail client (deep links were 404)

Context consulted per rule 15: the 2026-09-17 deploy-fix entry, the
FRONTEND_MERGE_PLAN phase-4 entry, and the 2026-09-19 rotation entry. The two
external nginx configs live outside this repo: `nginx/sites-enabled/mailstr.app`
(prod) and `nginx-72.61.138.38/sites-enabled/stg.mailstr.app` (staging).

### Root cause

`https://mailstr.app/mails/settings` returned nginx's 404. Both vhosts served
the site with a bare `location / { root …; index index.html; }` — no
`try_files`. Client-side routes (`/mails/settings`, `/mails/inbox/thread/…`)
have no file on disk, so nginx looked for `…/mails/settings` and 404'd.
`/privacy-policy` was also affected (directory without an index lookup
fallback). `README.md` (`client/web/README.md` §External nginx) already
documented the required fallbacks; the deployed configs predate the merge and
were never switched — commit `2eaa9fe` had even deleted an earlier `/mails/`
alias block that carried a fallback.

### What changed (2 files, outside the app repo)

Both vhosts gain the config from `client/web/README.md`:

- `location ^~ /mails` → `try_files $uri $uri/ /mails/index.html` (SPA shell;
  the shell stays `noindex`).
- `location /` → `try_files $uri $uri/index.html /index.html` (prerendered
  routes like `/privacy-policy` resolve to their own directory index; unknown
  paths fall back to the landing shell).
- The nested asset-cache `location ~*` regex is untouched; `^~ /mails` keeps
  it from intercepting `/mails*`, and assets are referenced root-absolute
  (`/assets/...`) so the fallback `location /` still serves them.

### Verification (exact)

- `docker run nginx:alpine` with both edited configs (listen swapped to
  8080/8081, HTTP→HTTPS redirect stripped, `root` bound to the local
  `client/web/dist`): `nginx -t` ok.
- Prod vhost: `/` 200, `/mails` 301 → `/mails/` 200, `/mails/settings` 200,
  `/mails/inbox/thread/abc` 200, `/privacy-policy` 200,
  `/privacy-policy/` 200, `/assets/App-C5ntoRNL.js` 200 with
  `Cache-Control: public, no-transform` / `Expires +1y`, unknown path 200.
- Staging vhost (8081): `/mails/settings` 200, `/privacy-policy` 200,
  unknown path 200.
- Bodies checked: `/mails/settings` carries the shell's
  `robots: noindex, nofollow`; `/privacy-policy` carries the prerendered
  `index, follow, max-image-preview:large, max-snippet:-1`.
- Live pre-fix: `https://mailstr.app/mails/settings` and
  `https://stg.mailstr.app/mails/settings` both 404; `/privacy-policy` on prod
  also 404. Live post-deploy check is on the nginx repos' owners: these are
  server configs, no app build is involved — copy into
  `/etc/nginx/sites-enabled/` and `nginx -s reload` on each host.

### Open items

- `nginx-72.61.138.38/sites-enabled/stg.mailstr.app` is the config that serves
  `stg.mailstr.app`; `sites-available/mails.stg.mailstr.app` proxies a separate
  host (`mails.stg.mailstr.app`) to mailcow's own UI on `:9833`, not this app —
  out of scope here.
- Neither nginx repo was committed; the two edits are working-tree changes in
  `~/Documents/Projects/formstr-hq/nginx` and `…/nginx-72.61.138.38`.

## 2026-09-21 — Mail links: plaintext autolink + native open path

Context consulted per rule 15: the 2026-09-19 nginx SPA-fallback entry, the
2026-09-19 key-rotation entry, and the 2026-09-18 ADR-006 send-ownership entry.
Work on branch `fix/mail-link-opening`, base `main` (`38a71e6`).

### Root cause

Two distinct defects behind "links in a mail are not clickable":

1. **Plaintext mail had no links at all.** `MessageBody`'s `PlainBody` renders
   the body in a `<pre>`; URLs were inert text. Verified by e2e before the fix:
   `anchor count: 0`, `iframe count: 0`.
2. **Native HTML links were dead.** The frame relies on
   `<base target="_blank">` + sandbox `allow-popups`, which works in a real
   browser (verified in Chromium: click → popup). Inside the Capacitor Android
   WebView it cannot: Capacitor never calls
   `WebSettings.setSupportMultipleWindows(true)` nor implements
   `WebChromeClient.onCreateWindow` (checked in `@capacitor/android` 7.6.9
   source; `BridgeWebChromeClient` has no `onCreateWindow`). A `_blank`
   navigation is therefore a silent no-op — the user-visible bug.

### What changed (6 files + tests)

1. **`lib/mail/plainLinks.ts` (new):** `splitPlainLinks(text)` finds URLs with
   `linkifyjs` (MIT; rule 13 — no hand-rolled URL parsing) and returns
   text/link segments. `find(text, 'url')` only, deliberately: `mailto:` links
   would launch a foreign app from the reader, and the address is already
   actionable via Reply. Bare `www.` hosts get `http://` inferred by the
   library.
2. **`lib/openLink.ts` (new):** `isSafeExternalUrl(href)` (absolute
   `http`/`https` only — `tel:`, `intent:`, `mailto:` are rejected before any
   plugin call) and `openExternal(href)`. On native it reaches
   `window.Capacitor.Plugins.Browser` through the runtime global — the
   `saveFile.ts`/`notifications.ts` pattern that keeps the web build
   Capacitor-free — and returns true so the caller can `preventDefault()`. On
   web it returns false and the browser opens its own tab (fighting the popup
   blocker would be worse).
3. **`MessageBody.tsx`:**
   - `PlainBody` maps segments: URLs render as `<a target="_blank">` with the
     app's link treatment, routed through `openExternal` on click.
   - `fitToContent` installs a parent-side capture listener on the iframe
     document (same-origin is already required for auto-height, and the frame
     runs no scripts, so the listener cannot live inside it) that intercepts
     anchors and routes them through `openExternal`. On web the listener
     declines and the anchor opens normally — the existing e2e proves both.
4. **`client/package.json`:** `@capacitor/browser@^7.0.5` (7.x — 8.x requires
   Capacitor core 8, this app is on 7.6.9). `cap sync android` registered the
   plugin in `capacitor.plugins.json`/`capacitor.build.gradle`/
   `capacitor.settings.gradle` (the two Gradle files are tracked; the JSON is
   gitignored, per the existing contract).
5. **`client/web/package.json`:** `linkifyjs@^4.3.3`.

### Tests

- `plainLinks.test.ts` 6/6: prose preserved around the split, multiple URLs
  across lines/blank lines, `www.` scheme inference, email deliberately not
  linked, and no text lost or reordered.
- `openLink.test.ts` 6/6: scheme allowlist (`intent:`/`tel:`/`mailto:`/
  relative rejected), native `Browser.open` called with the URL, web declines,
  missing plugin declines.
- `e2e/app/mail-links.spec.ts` 3/3 (new, permanent): a real account receives
  a bridge-sealed HTML message and a plaintext one through the mock relay;
  both links are asserted visible and the click is asserted to produce a
  popup with the right URL. The third spec fakes the Capacitor global and
  asserts the click reaches `Browser.open` with **no** popup — the exact
  native behavior the Android WebView cannot provide itself. This is the
  regression pin for both defects.

### Verification (exact, at this working tree)

- `pnpm --filter mailstr-web lint` — 0 errors.
- `pnpm --filter mailstr-web build` — ok (prerender + `/mails` shell).
- `pnpm --filter mailstr-web test` — 324 passed / 4 failed; the 4 are the
  pre-existing environment failures recorded on 2026-09-19
  (`api/addresses.test.ts` ×3, `mail/composeFields.test.ts` ×1 — stg bridge
  domain defaults), confirmed unchanged on `main` by stash + re-run.
- `pnpm e2e` — mail-links 3/3; the full run is 17 passed / 1 failed, where the
  failure (`buy-address.spec.ts` "sidebar buy row opens the wizard in place")
  also fails on `main` at the same commit, so it is pre-existing and
  unrelated.
- `pnpm --filter mailstr-client run apk:debug` — BUILD SUCCESSFUL, with
  `@capacitor/browser` in the plugin list (`cap sync` reported 6 plugins).
- The native click routing is pinned by the fake-Capacitor e2e above (calls
  `Browser.open`, opens no popup). The plugin's own on-device behavior
  (Custom Tab launch) was not exercised on a real device: the sandbox's
  emulator is resource-starved (the AVD stalls in `BOOTING`/`RUNNING_LOCKED`
  and the package never resolves), so the APK build + plugin registration +
  the routing e2e are the evidence. An on-device click check is the remaining
  gap before shipping the APK.

### Deliberately not changed

- HTML mail's sandbox stays as-is: no `allow-scripts`, same CSP, remote images
  still opt-in. The click listener is parent-side and the scheme allowlist
  gates every navigation, so the security boundary (AGENTS rule 12) is
  unchanged.
- No `mailto:` linkification: Reply/Reply-all is the intended path, and a
  tapped `mailto:` would leave the app for an OS handler.
- `target="_blank"` on plaintext anchors is kept for web parity with HTML
  mail; native never sees it because `openExternal` claims the click first.

### Test build for on-device review (same session)

A debug APK for the on-device link check was built and served on the LAN, so
the remaining gap above can be closed by a phone on the same network:

- `debug { applicationIdSuffix ".debug" }` in
  `client/android/app/build.gradle` plus
  `client/android/app/src/debug/res/values/strings.xml` ("Mail by Form*
  (debug)") so the debug build installs **alongside** the production app
  (distinct applicationId = distinct app; Java package unchanged). This is
  committed as the permanent debug-variant setup, not a one-off.
- Served from `/tmp/opencode/apk-host/` at
  `http://192.168.178.46:8000/mailstr-debug-0.2.1.apk` (plain
  `python3 -m http.server 8000 --bind 0.0.0.0`, host LAN IP 192.168.178.46,
  `wlp2s0`). Verified locally: `200`, `Content-Length 15401701`,
  `application/vnd.android.package-archive`, sha256
  `a3c49827bf19c6412d31b5a8691b300b5622bcb42d482a7d1313cdf89449e7c4`.
- Built with `cap sync` (6 plugins, `@capacitor/browser` included) and
  `assembleDebug`; `aapt2 dump badging` confirms package
  `com.formstr.mail.debug`, versionName `0.2.1`, launch label
  "Mail by Form* (debug)".
- The server is a plain static host serving only the APKs; it is not a repo
  artifact. No auth — LAN only; stop the process when done.

## 2026-09-21 — Prod-readiness pass: dev config leaked into the APK, error overlay blocked the app, mixed-content images

Context consulted per rule 15: the link-opening entry directly above (same
session), the 2026-09-19 rotation entry, and the 2026-09-15
`VITE_BRIDGE_DOMAIN` deploy-fix entry (same class of bug: build-time config
silently falling back). Work on `fix/mail-link-opening`, base `main`
(`38a71e6`), continuing from the link fix.

### Root causes (three separate defects, all observed on the real APK)

1. **The dev error overlay blocked the whole page.** `MessageBody`'s
   `ResizeObserver` observed `doc.documentElement` while its callback wrote the
   iframe's height — which resizes that very element. The browser reported the
   self-retrigger as `ResizeObserver loop completed with undelivered
   notifications`, an `error` event; `DebugErrorOverlay` captured every one as
   a fatal app error and rendered a full-height overlay over a working page.
   Because layout kept settling, they arrived continuously. Diagnosed on the
   real WebView: the user's console dump was 100% these notifications.
2. **`Load images` did nothing on native.** Verified over Chrome DevTools
   Protocol against the app's actual WebView (Android 15 ATD image): the app
   serves from `https://localhost`, so `http://` images are blocked as
   **mixed content before CSP applies** —
   `blockedReason: "mixed-content"` on `Network.loadingFailed`, `naturalWidth: 0`.
   The same probe with `https://` loaded (`width: 32`). Plaintext/HTML link
   tests could not catch this: the e2e dev server runs on `http://localhost`,
   where mixed-content rules never apply.
3. **The mobile APK shipped staging config.** `client/scripts/build-web.mjs`
   ran `pnpm run build` without pinning `VITE_*`; Vite loads `client/web/.env`
   (gitignored) on every build, and this machine's file points at staging. The
   shipped bundle contained `api.stg.formstr.app`, `wss://api.stg.formstr.app`
   and `stg.mailstr.app` — a production APK calling staging and claiming
   `@stg.mailstr.app` addresses.

Additionally, dev diagnostics and the Developer-mode UI (raw rumor JSON, key
fingerprints) were shipping in production, and console traces narrated relay
timings and decoded mail ids in the APK.

### What changed

1. **`MessageBody.tsx` (ResizeObserver loop):** observe `doc.body` (content-
   driven, never resized by our height write) instead of `documentElement`;
   defer the write to `requestAnimationFrame`; and skip sub-pixel oscillations
   (`|Δ| ≤ 1`). This removes the root cause rather than only hiding its
   symptom.
2. **`DebugErrorOverlay.tsx`:** `isBenignError()` filters both ResizeObserver
   notification forms at the capture boundary (tested). Two-mode surface:
   production gets a plain "Something went wrong" + Reload, never stacks or
   messages; dev keeps the copyable stack overlay. Critically, in production a
   stray error/rejection can no longer replace a working page — only a React
   render crash (where the tree is already gone) takes the screen. The error
   list is capped at 20 so a repeating error cannot lock the UI. Global capture
   is dev-only.
3. **`emailFrame.ts` (mixed content):** the remote-allowed CSP gains
   `upgrade-insecure-requests`, the standard subresource rewrite. Chosen over a
   hand-rolled `src`/`srcset`/`url()` regex (rule 13) and verified on the real
   WebView: `http://www.google.com/favicon.ico` upgrades and loads
   (`currentSrc: https://…`, `width: 32`), while link `href`s stay untouched.
4. **`client/scripts/build-web.mjs`:** pins `VITE_API_BASE_URL`,
   `VITE_WS_BASE_URL`, `VITE_API_CANONICAL_BASE_URL`, `VITE_MAIL_DOMAIN` and
   `VITE_BRIDGE_DOMAIN` to production in `PROD_ENV`. Process env beats `.env`
   file values, so the APK is production regardless of a developer's local
   file. (The Docker deploy service already passed these as build args; this
   fixes the mobile build path, which did not.)
5. **Dev surfaces prod-gated:** `DebugPanel` (raw rumor disclosure) and the
   Developer-mode setting render only when `import.meta.env.DEV`; both were
   previously reachable in the shipped app via a persisted preference.
6. **Console traces stripped:** every step-by-step trace (settings stage
   timings, PGP key-id matching, addresses response, inbox rejects, account
   warm-up) now sits behind an inline `if (import.meta.env.DEV)`. An imported
   `logger.dev…` helper was tried first and **removed** — Vite cannot
   statically drop an imported function's arguments, so the message strings
   still shipped (verified in the bundle); the inline guard is what minifies
   away. Genuine failure logs (`FAILED after…`, `failed to publish…`) stay in
   production.
7. **Version:** `versionCode 3 → 4`, `versionName 0.2.1 → 0.2.2`,
   `client/package.json` `0.2.2`.

### Verification (exact, at this working tree)

- `pnpm lint` — 0 errors.
- `pnpm build` (mobile assembly) — ok; bundle greps: **0** staging hits, 4
  `api.formstr.app`; `VITE_API_BASE_URL/VITE_WS_BASE_URL/VITE_MAIL_DOMAIN` all
  production; **0** occurrences of `the stall is here`, `decrypted with`,
  `message targets key IDs`, `Developer mode`, `Debug · rumor event`,
  `Copy JSON`, `App error`; failure logs still present (1/3/1/1).
- `pnpm test` — 329 passed / 4 failed; the 4 are the pre-existing env failures
  (`api/addresses.test.ts` ×3, `mail/composeFields.test.ts` ×1) already
  recorded, unchanged on `main`. New: `DebugErrorOverlay.test.tsx` 4/4
  (benign-error recognition, real errors not swallowed, capture installs,
  crash surfaces in dev) and `emailFrame.test.ts` +1 (upgrade directive only
  when remote is allowed).
- `pnpm e2e` — 18 passed / 1 failed; the failure is the pre-existing
  `buy-address.spec.ts` one. New spec in `mail-links.spec.ts`: a mail with an
  `http://` image is not fetched before consent, then `Load images` fetches it
  as `https://` (`upgrade-insecure-requests` proven end to end).
- **On the real Android WebView** (Android 15 `google_atd` image, the app's own
  `https://localhost` origin, Chrome DevTools Protocol):
  - shipped bundle: `stg` hits 0, prod hits 4;
  - `document.body.innerText` contains none of `App error`, `Developer mode`,
    `Debug · rumor event`;
  - 0 ResizeObserver errors after exercising the app;
  - the app's exact frame CSP + an `http://` image → `width: 32`,
    `currentSrc: https://…`.
- `apk:debug` — BUILD SUCCESSFUL; `aapt2 dump badging` confirms package
  `com.formstr.mail.debug`, **versionCode 4, versionName 0.2.2**, label
  "Mail by Form* (debug)".

### Notes / limitations

- The mixed-content class of bug is invisible to the current e2e suite by
  construction (dev server is http). The on-device CDP probe is the evidence
  here; a permanent guard would need an https-served e2e origin.
- The `atd`-variant emulator (`google_atd`) is the only one that stayed stable
  on this host; the Play-store images repeatedly lost their package manager
  under memory pressure. Commands used are recorded above for the next pass.
- Host-side debug artifacts (the AVD and a static APK host) are not repo
  artifacts; the AVDs were deleted after use.
