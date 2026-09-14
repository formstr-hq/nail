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

