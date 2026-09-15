# Session Log

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

