# Nail Frontend Audit — Anti-Patterns & Bad Code

Scope: the merged `web/` app (landing at `/`, mail client at `/mails`) plus the
`mobile/` Android shell (a pnpm-workspace member). Bridge/server out of scope
except where they share `nostr-bridge/src/protocol/`.

**Revision 3 — 2026-09-13 (same day as rev 2), verified against
`app_restructure`.** Rev 2 was verified at `67528bc`; the fixes below landed in
the working tree after it, then a re-verification pass (this revision) audited
the fixes themselves and closed the gaps they had left open (see "Review pass"
below). Rev 1 audited the now-deleted `client/` + `landing/` split at `6bd8a35`.

Baseline at revision 3: `pnpm build` passes, `pnpm test` = **30 files / 235
tests green**, `pnpm e2e` = **13/13 green**, `pnpm lint` = **0 errors / 0
warnings** (was 11 warnings). Bridge suite 88/88 and bridge + e2e-nostr
typecheck clean (the shared protocol module changed). Web CI added (E-1).
Main client chunk 1.18 MB → 586 KB; the mail app is a lazy 551 KB chunk (E-5);
the mobile bundle was served and driven headlessly to prove the lazy chunk
resolves under the `/mails/` base (no console errors).

## Review pass (rev 3 re-verification)

The first cut of the rev-3 fixes had residual holes, found by re-reading
the changed code and closed here:

1. **Async writers could cross the account boundary.** The synchronous reset
   (B1) cleared the stores, but in-flight work started under the old account
   could still `set()` afterwards: a decode completing (`useInbox`,
   `useMailMeta`), a settings publish/load resolving, or a mail-action publish
   writing `syncError`. Added `store/sessionEpoch.ts` — a counter bumped by
   `resetAccountScopedState()`; async writers capture it and drop their result
   if it moved. Covered by `settings.session.test.ts`.
2. **Metadata cursor could miss a same-second sibling update.** The `since`
   cursor made the replay bounded (D5), but the effect guard was `<=`, which
   dropped a second mail's state event published in the same second as the
   newest one decoded last session. Now the guard is `<` with an inclusive
   `since`, so the boundary second is re-checked (at most 1–2 extra decrypts
   per session).
3. **Recipient dedup left duplicate headers.** Wraps were deduped (D8) but the
   RFC 2822 `To`/`Cc` lists still repeated an address that appeared in both;
   headers are now deduped To-first (and an all-duplicate Cc is omitted).
4. **`useMailMeta` called `getLocalRelay()` outside a try** — the same D6
   crash class it had just been fixed to avoid in `useInbox`. Now guarded.
5. **`CUSTOM_SENDER` was defined twice** (`useSenderDraft` and
   `AddressesSection`) — consolidated to one export.

Also corrected in this pass: a duplicated comment block in `localRelay.ts`, a
comma-operator `reset()` in `settings.ts`, and a stale `useMailActions` doc
comment still claiming failures are log-only.

## Fixes landed since revision 2

| Audit ID | Fix |
|---|---|
| A1 | Split `SignupWizard` 906→423 L (`components/signup/*`), `EmailView` 461→185 L + `components/email/*`, `LoginPage` 550→55 L (`components/login/*`). File-size rule now holds. |
| A2 | Login-UI helpers de-duplicated into `web/src/lib/loginUi.ts` (was the deleted `shared/signer-ui.ts`'s job); both login surfaces consume it. |
| A3 | Added a shared `Overlay` primitive (`components/ui/Overlay.tsx`), adopted by Settings + Onboarding. |
| A5 | `selfAddresses` already in `useSelfAddresses` (rev 2); no change needed. |
| B1 | `resetAccountScopedState()` clears mail, settings, PGP session passphrases, compose/buy overlays, resets the relay worker, and **bumps the session epoch** (rev-3 review) — called synchronously by `switchTo`/`logout`/`removeAccount` **before** any await; in-flight writers drop results from the old epoch (`store/sessionEpoch.ts`). |
| B2 | `indexKeyInflight` keyed by pubkey; `initialized` moved into store state; `resetLocalRelay()` tears down the worker on account change. |
| B3 | Failed kind-34578 publishes set `mailStore.syncError`, shown as an app-level dismissible banner; cleared on the next success. |
| B4 | `EmailList` filters/sorts via `useMemo`; no longer rebuilds on unrelated renders. |
| B5 | `settings.save()` commits to the store only after the relay accepts; a failed mint throws before any coordinate is written. |
| B6 | `settings.save()` is a serialized patch API — merges into the live blob at publish time; `usePgpDiscovery`/`PgpSettings`/`Onboarding`/`SettingsModal` send only the fields they own. |
| C1 | `usePgpMessage`/`useProfile`/`Avatar`/`useComposerEncryption` derive stale-prone state instead of effect resets; `useSenderDraft` derives mode. Remaining form seed (`signature`) is a draft, justified under rule 4. |
| C2 | Relay watchdog extracted to `lib/nostr/relayWatchdog.ts` with unit tests; decode queue already extracted. |
| C3 | All 11 lint warnings resolved — `pnpm lint` is clean. |
| C4 | `cx()` helper added; adopted in `EmailList`. |
| D1 | Cross-device delete sets `selectionClearedReason: 'deleted'`; `EmailList` shows a dismissible "removed on another device" notice. |
| D2 | `mailState` is the single source of truth for filing; the misleading dual-mirror code removed and documented. |
| D3 | Signer failures are tagged (`SignerError`/`SIGNER_ERROR_TAG`) and classified `signer-error`, distinct from routine `not-for-us`; `DecodeQueue` retries them (bounded) and reports exhaustion. |
| D4 | `useResolveContext` returns `bridgeError`; composer shows a proactive "bridge unavailable" banner. |
| D5 | `useMailMeta` uses a persisted per-account `since` cursor + `seenMetaIds` dedup and the shared bounded queue; the boundary second is re-checked (`<` guard) so a same-second sibling update is not lost, and the epoch guard keeps late decodes out of a switched account. |
| D6 | `getLocalRelay()` moved inside `useInbox`'s try; the same guard added to `useMailMeta` in the rev-3 review. |
| D7 | Worker `service.start()` rejection reported over the channel; `localRelayBootError()` picks it up. |
| D8 | `parseRecipients` de-dupes case-insensitively; `buildWraps` de-dupes resolved pubkeys/legacy addresses (To+Cc included) **and the RFC 2822 headers** (To wins; an all-duplicate Cc is omitted). |
| D9 | PGP discovery marks `attempted` only after the lookup settles and clears `discovering` on teardown/early return. |
| D10 | `saveFile` revokes the object URL on a later task. |
| D11 | `decodeMailMeta` rethrows signer failures instead of treating them as undecryptable. |
| D12 | `installAndroidBackHandler` calls `exitApp()` when the JS dispatch declines at root; unit-tested. |
| D13 | Notifications watcher clears `watching` only after a successful stop. |
| D14 | Deletions are stored once (tombstone set); `mailState` no longer duplicates every deleted mail. `hydrateFlags` ignores stale events for tombstoned ids. |
| E-1 | Added `.github/workflows/web-ci.yml` (lint + test + build + e2e, frozen lockfile). |
| E-2 | Resolved by the mobile workspace merge (rev 2). |
| E-3 | `BoundedDecodeQueue<T>` shared by `useInbox` (via `DecodeQueue`) and `useMailMeta`. |
| E-4 | New tests: decode-queue retry, recipient dedup (both layers), settings serialized patch/rollback, account reset, session-epoch guarding, back-handler exit, watchdog, failure taxonomy, store tombstone/sync-error. 209 → 235. |
| E-5 | `MailApp` lazy-loaded in `src/App.tsx`; main chunk halved. |
| E-6 | Deleted `web/src/app/index.css` (559 L, unimported; coverage verified in `index.css`) and `web/src/app/types/nostr.ts`. |

### Residual / accepted

- **C1 (residual):** `SettingsModal`'s `signature` and `relays` remain form
  drafts intentionally (rule 4 permits a seeded draft with no sync-back); the
  save path is a patch (B6), so staleness cannot clobber.
- **B4 (scaling):** the in-memory `emails` map still re-renders the list on
  every add; fine at current volumes, tracked as future work, not a bug.
- **E-4:** hook/component coverage is improved but not exhaustive (`useInbox`,
  `useMailMeta` lack direct tests).

---

# Appendix — revision 2 snapshot (historical)

> **Everything from here to the end is the revision-2 audit as it stood before
> the rev-3 fixes.** It is retained for provenance, not as current state —
> most findings below are now fixed (see the table at the top of this file).
> Read it only to understand what was wrong and why the fixes took the shape
> they did.

**Revision 2 — 2026-09-13**, verified against `app_restructure` HEAD `67528bc`
(merge of main: saveToDisk port, portal export dialog, settings layout fixes).
The first revision audited the now-deleted `client/` + `landing/` split at
`6bd8a35`; its findings are re-scored below as **Resolved** or carried forward
as current findings.

**Actions taken since revision 2** (same day, `app_restructure`):
- **Deleted `shared/`** — `shared/signer-ui.ts` was dead code (A2). Shared
  frontend logic lives in `web/src/lib/`; the login-UI tuning dedup remains
  open under A2.
- **Merged `mobile/` into the pnpm workspace** (F-1). `pnpm-workspace.yaml`
  now lists `web` + `mobile`; `mobile/package-lock.json` deleted; Capacitor
  deps resolved once (7.6.9 core, up from mobile's 7.6.8); build/CI commands
  switched to pnpm (`android-apk.yml` now installs with `--frozen-lockfile`).
- The audit below is otherwise unchanged; E-2's frozen-lockfile concern is
  resolved by the merge, F-1/F-3 report the outcome.

Baseline at this revision: `pnpm build` passes, `pnpm test` = **24 files / 209
tests green**, `pnpm e2e` = **13/13 green**, `pnpm lint` = 0 errors / 11
warnings (all `react-hooks/set-state-in-effect` etc. — the tracked Phase-5
offenders). No web CI workflow exists in-repo (see E-1).

> ID note: the table below keeps revision-1 IDs (they are the historical
> record). The section headings after it use fresh IDs for the current
> revision — where they coincide numerically, the section is authoritative.

---

## Resolved since revision 1

| # | Original finding | Evidence it is done |
|---|---|---|
| A1 | Two apps, two React majors, duplicated shared code | `client/` + `landing/` deleted (merge phase 4). One app on React 19 / Tailwind 4 / Vite 7. `lib/nip98.ts`, `lib/platform.ts` singular. |
| A2 | Two separately deployed frontends | One Vite build, one Docker image (`web/Dockerfile`), prerendered `/` + `/privacy-policy` + noindex `/mails` shell (`prerender.js`). |
| A3 | No router | `react-router` owns routes (`web/src/App.tsx`); settings panes and add-account are real routes; `App.tsx:97-124`. |
| A4 | God components | `ComposeModal` 728→399 L (`components/compose/*` + `hooks/compose/*`), `SettingsModal` 674→288 L (`settings/sections/*`), `PgpSettings` 698→130 L (`settings/pgp/*`). |
| A5 | Overlay state + `selfAddresses` in `MailApp` | Overlay state in `store/composeOverlay.ts` + `store/buyOverlay.ts`; `selfAddresses` in `useSelfAddresses.ts`. |
| B1 | Hand-rolled persistence for 4 keys | `zustand/persist` everywhere (`store/mail.ts`, `theme.ts`, `dev.ts`, `useOwnedAddresses.ts`); legacy keys + bare shapes preserved and covered by `store/mail.persist.test.ts`. `freshSignup` intentionally hand-rolled (cross-app contract). |
| B2b | `useInbox` decode queue in closure | Extracted to `lib/mail/decodeQueue.ts` with unit tests. |
| D6 | Landing redirect has no timeout | `Home.tsx` still has no timeout, but `redirectReturningOwner()` now calls `hasResumableSession()` synchronously and redirects without awaiting a signer resume — the spinner cannot hang on resume (`lib/session.ts:62-76`). Effectively resolved. |
| E | No eslint config in client | `web/eslint.config.js` real; lint runs and reports. |
| E | React 18 vs 19 | Unified on 19. |
| E | `node_modules`/`dist` committed | Not tracked; root `.gitignore` + `web/.gitignore` cover both. |

Partially addressed, tracked below: **B2** (`indexKeyInflight` still module-level —
new cross-account variant in B1/B2), **C1** (queue extracted but the watchdog
still lives in the effect — C2), **D1/D2** (unchanged, see D1/D2), **E**
(component tests now exist but are thin — E-4).

---

## A. Structural / architectural

### A1. Split `EmailView` and `SignupWizard` (still open)
File-size discipline (AGENTS §1: target ≤300 L, hard alarm at 500) is now
violated by different files than revision 1:

- `web/src/components/SignupWizard.tsx` — **906 L**. Absorbed the landing
  wizard and the login-UI tuning helpers inline.
- `web/src/app/components/LoginPage.tsx` — **550 L**.
- `web/src/app/components/EmailView.tsx` — **461 L** (`MessageBody` +
  `PgpSignatureBadge` + `DebugPanel` + header/footer in one file).
- `web/src/app/lib/pgp/openpgp.ts` — 377 L (acceptable; leaf module).

The old A4 offenders are fixed; the same rule now applies to these three.
Split along seams: `MessageBody` → its own file, `DebugPanel` → own file;
`LoginPage`/`SignupWizard` tuning → see A2 below.

### A2. Login-UI duplication now intra-app (the named fix's vehicle was deleted)
`shared/signer-ui.ts` (257 L) was deleted as dead code (rule 14): it had zero
importers anywhere in the repo — no `@signer-ui` alias in `web/vite.config.ts`
or `web/tsconfig.app.json`, no `COPY shared/` in `web/Dockerfile`. The helpers
it was written to centralize (`TAB_COPY`, `tuneLoginUi`, `methodListNav`,
`autoGenerateQr`, `removeInapplicableMethod`, `injectAndroidSigners`,
`friendlyUnlockError`) are still copy-defined in `SignupWizard.tsx:20-239` and
`LoginPage.tsx:25-328`, and their comments still cite the dead
`client/`/`landing/` split as the reason (`SignupWizard.tsx:9-19`,
`LoginPage.tsx:14-24`).

The remaining fix is the named one from AGENTS: push the tuning upstream into
`@formstr/signer` config/slots, then delete both copies. Until that lands, do
not recreate a `shared/` directory — cross-app logic goes in `web/src/lib/`.

The stale path comments in `SignupWizard.tsx`, `LoginPage.tsx` and
`freshSignup.ts:9-10` ("landing/src/…", "client/src/…") must be rewritten in
the same change regardless.

### A3. No portal discipline for modals (still open, C4 revision 1)
`KeyExportDialog.tsx` is the only use of `createPortal` in the app. Every
other overlay (`SettingsModal`, `ComposeModal`, `BuyAddressModal`,
`OnboardingModal`, `AccountSwitcher` popover) renders inline and relies on
`z-50` + a `fixed inset-0` wrapper. Result: stacking order is convention, not
structure, and the mobile safe-area classes (`.safe-y` / `.safe-bottom` /
`.safe-modal`) are applied per-overlay by hand (12 TSX call sites). The one
portal proves the primitive exists; there is still no shared `<Overlay>`.

### A4. Router/overlay split is deliberate and documented — keep it
`composeOverlay`/`buyOverlay` intentionally stay out of the URL (a minimized
draft must survive navigation; the buy wizard opens over an unsaved Settings
pane). Android back is wired to them (`App.tsx:157-196`). This is now a
documented design, not drift. The only caveat is B1 (no reset on account
switch).

---

## B. State management

### B1. Cross-account state leaks (NEW — highest-value bug cluster)
The old module-level offenders (`indexKeyInflight`, `initialized`) are still
present, but the deeper problem is that **account-scoped state is not reset on
switch/logout**. Verified call chain: `switchAccount()` in the signer package
makes the new account active *before* `useAccountStore.switchTo()` finishes
its unlock (`store/account.ts:147-173`), and `logout()` clears only the mail
store (`store/account.ts:175-179`).

- **`useSettingsStore` is never cleared.** `load()` replaces `settings` only
  after the relay round-trip resolves; on failure it leaves the previous
  account's blob in place (`store/settings.ts:33-47`; caller swallows the
  error at `App.tsx:145-147`). During that window (or indefinitely on failure)
  the new account can: prefill the composer with the old account's signature
  (`ComposeModal.tsx:77-79`), make PGP encrypt/decrypt decisions from the old
  `pgpKeys`, and return the **old account's `mailIndexKey`**
  (`useMailActions.ts:135-136`) — publishing the new account's mail-state
  events under the wrong coordinate.
- **`useMailStore` is cleared too late.** `switchTo` clears at
  `account.ts:149`, then awaits up to ~16 s of bunker warm-up; until the final
  `set()` the old `MailApp` and its `useInbox` subscription are live, so a
  wrap arriving in that window re-populates the store with the old account's
  mail after the clear. The add-account path has the same shape
  (`App.tsx:344-354` clears after `SignerLogin` resolves).
- **PGP session passphrases survive logout.** `lib/pgp/session.ts` documents
  "for the session only"; `clearSessionPassphrases()` has **zero callers**.
- **Compose/buy overlays survive logout.** A draft (recipients + body) stays
  in `store/composeOverlay.ts` across a same-tab account switch; the next
  account's `MailApp` remounts the composer with the previous account's text.
  Only the send-time ownership guard (`send.ts:113-116`) stops a bad send.

Fix shape: one `resetAccountScopedState()` called synchronously by
`switchTo`/`logout`/`removeAccount` **before** the await, covering settings
(settings → `{}`, `loaded:false`), mail (already), compose/buy overlays,
`clearSessionPassphrases()`, and cancelling/clearing any in-flight signer
work. `useSettingsStore.load()` should also clear `settings` up-front, not
only on success.

### B2. Module-level lifecycle singletons (still open, narrowed)
- `useMailActions.ts:18` `indexKeyInflight` — a rejected promise clears in
  `finally`, but the promise is shared across accounts; if A's mint is
  in-flight when B logs in, B's `ensureMailIndexKey` returns **A's** key.
- `store/account.ts:21` `initialized` — correct today (per-page lifetime),
  but it is the same pattern AGENTS §5 bans.
- `lib/nostr/localRelay.ts:22` `client` holds one local relay across account
  switches; `syncAccountRelays` calls `setActiveAccount`, but the NIP-42 AUTH
  callback reads whatever `active` is current (`localRelay.ts:75-85`) — a
  relay challenge racing a switch can be signed by the wrong account's key.
- `lib/nostr/nip05.ts:14` / `relays.ts:13` / `profile.ts:18` in-flight maps
  keyed by address/pubkey — correctly scoped, **not** leaks.
- `lib/notifications.ts:32` `watching` — see D13.

### B3. Optimistic publishes without retry/feedback (still open)
`useMailActions.apply` (`useMailActions.ts:49-56`) and `deleteForever`
(`:88-107`) log publish failures and move on. The local flag stands; the
relay is never retried, so cross-device state silently diverges until the
next action. Now *partially* mitigated: the send path's `relay.publish` uses
the worker's durable outbox (`send.ts:283`), but mail-state events do not.

### B4. Store shape invites full re-renders (still open, worse surface)
`emails` map and `seenIds` Set are replaced wholesale on every add
(`store/mail.ts:248-251`); `EmailList` scans and sorts every email on each
render with no memo and no windowing (`EmailList.tsx:153-177`). At today's
volumes fine; at thousands (relay replay has no `since`, see D5) it janks.
The persisted `mailState`/`wrapKeys`/`deletedIds` maps also grow forever —
never pruned (see D14).

### B5. `mailIndexKey` can be used before it is durably saved (NEW)
`ensureMailIndexKey` mints a key and calls `save()`; `save()` writes the
in-memory store *before* publishing (`store/settings.ts:52-58`) and on
failure the error propagates — but the in-memory settings still hold the new
key. Every subsequent action takes the `if (existing) return existing` fast
path (`useMailActions.ts:135-136`) and publishes mail-meta under a key that
exists only in this tab. Close the tab before any settings save succeeds →
every coordinate ever written is orphaned and cross-device state silently
lost. Fix: only commit the key to the store after `saveSettings` resolves
(rollback on failure), or persist the minted key locally until the event is
confirmed published.

### B6. Settings saves are whole-blob last-writer-wins (NEW)
`save()` publishes the entire `MailSettings` blob. Two writers can race:
- `usePgpDiscovery` holds a `settings` closure taken when its effect ran
  (`usePgpDiscovery.ts:62,93`) and saves `{...settings, pgpKeyring}` after
  keyserver lookups resolve (seconds later). A signature/sender edit saved in
  the meantime is clobbered by the stale snapshot.
- `SettingsModal.handleSave` spreads its own `settings` closure
  (`SettingsModal.tsx:110-116`) — same exposure.

Fix: serialize saves (a store-level queue) and re-read the latest settings
inside the reducer before publishing, or move to per-field addressable events.

---

## C. React anti-patterns

### C1. `useState` mirrors of store/async data (still open)
- `SettingsModal`: `signature` (`:43`), `relays` (`:50`), plus the
  `useSenderDraft` hook's `senderAddress`/`senderMode`. The latter's sync-back
  effect is documented and careful, but the pattern remains.
- `usePgpDiscovery`: snapshot-save above (B6).
- `usePgpMessage`: async result state is correct (no mirror), but it runs a
  full decrypt pipeline in an effect whose deps include `settings.pgpKeys`
  and `settings.pgpKeyring` — any settings save re-runs every open message's
  decrypt.
- `useOwnedAddresses` uses the render-time "adjust state when a prop changes"
  pattern deliberately to close the stale-paint gap (`useOwnedAddresses.ts:110-127`);
  documented, justified, keep.

### C2. Effects doing orchestration (still open, narrowed)
`useInbox` (`:39-149`) still owns the watchdog `setInterval`, subscription,
status state machine and the relay list callback in one 5-dep effect (`attempt`
also in deps). The queue extraction was real, but AGENTS §6 wants the
watchdog out too. `useMailMeta` has the same shape with a hand-rolled bounded
pump inside the effect (see E-3).

### C3. `set-state-in-effect` warnings (11, tracked)
`pnpm lint` reports 11 warnings, all the known Phase-5 class:
`OnboardingModal:73`, `Avatar:33`, `useComposerEncryption:55`,
`useInbox:43`, `useOwnedAddresses:159`, `usePgpMessage:93`,
`useProfile:17`, `useSenderDraft:53`, plus two `exhaustive-deps`
(`ComposeModal:199` `setMinimized`, `OnboardingModal:56` `account`) and one
refs-during-render (`ComposeModal:166`). These are tracked, not new — but
they are warnings that nothing is burning down; the eslint config comment
says Phase 5, and Phase 5 is marked done. Either pay them or convert the
tracked-offender table into issues with owners.

### C4. Repeated `className` ternaries (still open)
26 `.join(' ')` class-string sites and no `cx()`/cva helper anywhere. AGENTS
§9 says a pattern repeated 3+ times gets hoisted. Small but pervasive.

---

## D. Correctness / bug-prone spots

### D1. Silent cross-device delete (still open)
`hydrateFlags` tombstone path clears `selectedId` with no affordance
(`store/mail.ts:285-297`). Intentional per design; still no UX signal. Keep
on the list.

### D2. `setFlag` read-sync only handles `read` (still open)
`store/mail.ts:254-267` updates `emails[id].read` but not a mirror for
archived/trashed; the list re-derives via `isFiled`. Two sources of truth for
one fact. Works; documented in revision 1; unchanged.

### D3. Transient signer failure classified as routine "not-for-us" (NEW, high)
`unwrapAndVerify` returns `not-for-us` for *any* `nip44Decrypt` throw
(`nostr-bridge/src/protocol/mail.ts:177-181`), including
`withSignerTimeout`'s 20 s ceiling (`lib/nostr/signer.ts:32-56`).
`decodeGiftWrap` marks that `routine: true` (`receive.ts:171-173`) and
`DecodeQueue` drops routine failures without a log (`decodeQueue.ts:77`).
A slow NIP-46 bunker during initial replay therefore loses real mail for the
whole session: no failure event, no status change, no retry until manual
reload. The failure taxonomy in ARCHITECTURE §8 explicitly says rows 1 and 2
must never be collapsed — this collapses a row-3/4 transient into row 1.
Fix: have the protocol layer distinguish signer/timeout failures from
undecryptable ciphertext (e.g. a `signer-error` reason) and have the queue
retry/report those.

### D4. Resolve-context failure is still console-only (still open)
`useResolveContext.ts:38-42` logs and leaves `bridgePubkey: null`; no UI
tells the user "external mail cannot be sent" until they try. (The composer
guard turns it into a send error, so it is not silent at send time — but the
Settings/bridge pane gives no standing signal.)

### D5. `useMailMeta` replays and decrypts the whole metadata history (NEW, medium)
No `since`, no cross-session dedup (`seen` is per-effect-run,
`useMailMeta.ts:44-45,71-74`), and decryption happens before
`hydrateFlags`'s newest-wins guard (`mailMeta.ts:283`). Every app open costs
one signer round-trip per kind-34578 event the account ever wrote — unbounded
over time, and exactly the signer-cost class AGENTS §5/§11 bounds. The
concurrency cap is the only bound. A `since` cursor persisted per account, or
a local id-set like `seenIds`, is the fix.

### D6. `useInbox` can crash before its error surface is armed (NEW, medium)
`getLocalRelay()` is called at `useInbox.ts:65`, outside the `try` that
begins at `:92`. On a browser that rejects the worker (the Safari <15 path
`localRelay.ts:63-66` explicitly handles), the throw escapes the effect body;
React treats it as an effect crash and the friendly "mail engine could not
start" error state is never reached. The 1s watchdog only covers a worker
that *errors later*, not a constructor throw. Move the `getLocalRelay()` call
inside the `try`.

### D7. Worker `start()` rejection is silent (NEW, medium)
`relay.worker.ts:31` is `void service.start().then(...)` with no `.catch`.
An IndexedDB failure (private browsing, quota) rejects `start()`, the
`hydrated` frame never posts, and nothing sets `workerBootError` — the
mailbox sits on "connecting" forever. Add a `.catch` that reports back over
the channel and surface it via `localRelayBootError()`/status.

### D8. No recipient de-duplication in the send path (NEW, medium)
`parseRecipients` promises "de-duplicated-at-source" but only trims/filters
(`composeFields.ts:26-28`). `buildWraps` iterates `[...toOut.nostr,
...ccOut.nostr]` and legacy lists with no pubkey/address Set
(`send.ts:174`), and `resolveRecipients` pushes per input address
(`resolve.ts:38-70`). The same address typed twice, or in both To and Cc,
produces two identical wraps — duplicate delivery. Sending to your own
address additionally duplicates the Sent copy. Dedupe by resolved pubkey +
normalized address before building wraps.

### D9. `usePgpDiscovery` drops lookups and can stick "looking for keys…" (NEW, medium)
(a) `attempted.current.add()` happens before the await
(`usePgpDiscovery.ts:76`); if the effect cleans up mid-loop (recipients keep
changing as the user types), the follow-up run filters the address via
`!attempted.current.has(...)` (`:66`) and it is never looked up again —
that recipient silently stays cleartext. (b) `discovering` is set true (`:71`)
but reset only when `alive` (`:98`); the follow-up run whose `missing` is
empty returns early at `:68` without clearing it, so the banner can persist
indefinitely. Fix: don't mark attempted until the lookup settles, and clear
`discovering` on every effect teardown/early-return path.

### D10. `saveFile` revokes the object URL synchronously (NEW, low/medium)
`saveFile.ts:113-123` calls `URL.revokeObjectURL(url)` in the same task as
`anchor.click()`. WebKit/Safari has aborted downloads in exactly this
pattern, and Safari 14/iOS 15 is the explicit support floor (AGENTS §6). A
`setTimeout(revoke, 0)` (or revoking on `window` `focus`/`blur`) is the
standard fix.

### D11. `useMailMeta` decrypt failures are swallowed (NEW, low)
`.catch(() => {})` at `useMailMeta.ts:55-58` treats a transient signer
ceiling the same as another app's metadata. Unlike D3 this is
lower-consequence (state re-hydrates next session), but it is still a
failure path with no counter, against AGENTS §10.

### D12. Android back at the client root does not exit the app (NEW, low)
`handleBack` returns `false` at root (`App.tsx:184-188`) expecting the OS to
treat the next press as exit. Capacitor's `@capacitor/app` plugin
(`AppPlugin.java:51-66`) fires the JS `backButton` event whenever *any*
listener exists and does nothing else when the JS side declines; nothing
calls `exitApp()` (verified: no call site). With the handler installed for
the app's lifetime, back is a no-op at root instead of exiting. Either call
`exitApp()` on the `false` path or gate the listener by stack depth.

### D13. Notifications watcher can outlive logout (NEW, low)
`syncMailNotifications` sets `watching = null` before `await
notifier.stop()`; a rejected stop leaves the Android WorkManager poll
running for the signed-out pubkey (`notifications.ts:43-53`). No UI signal on
either stop or start failure.

### D14. Persisted mail-state maps grow without bound (NEW, low)
`mailState`, `wrapKeys`, `deletedIds` accumulate forever: `markDeleted` keeps
`mailState[id]` **and** adds to `deletedIds` (double record per deleted mail),
and `hydrateFlags` tombstones without removing the flags entry
(`store/mail.ts:254-340`). Fine at hundreds, a quota/serialization cost at
tens of thousands. Prune `mailState`/`wrapKeys` entries whose mail is deleted
(after the publish confirms), keeping only the tombstone.

---

## E. Tooling / hygiene

### E-1. Build/tests/e2e are green; no in-repo CI for web (still open)
`.github/workflows/` contains only `android-apk.yml` (manual dispatch). There
is no workflow that runs `pnpm lint`, `pnpm test`, `pnpm build`, or `pnpm
e2e` on pushes/PRs for `web/`. The audit's verification checklist (AGENTS
bottom) has no automation behind it. Add a `web-ci.yml`.

### E-2. Android CI lockfile discipline (resolved by the mobile merge)
`android-apk.yml` previously ran `pnpm --dir web install --no-frozen-lockfile`
plus `npm --prefix mobile ci` — two package managers, two lockfiles. With
`mobile/` in the workspace it is a single `pnpm install --frozen-lockfile` and
`pnpm --filter mailstr-mobile run build` (see F-1).

### E-3. Decode queue duplication (still open, new instance)
`useMailMeta` hand-rolls a second bounded pump (`useMailMeta.ts:41-63`)
instead of reusing `DecodeQueue`/a shared helper. It is the same pattern the
Phase-5 refactor extracted for `useInbox`; this one was missed.

### E-4. Component-test coverage remains thin
2 component tests vs. 24 lib test files; no tests for `Sidebar`, `EmailView`,
`SettingsModal`, `useInbox`, `useMailMeta`, `usePgpDiscovery`, and no test
for the Android back stack (AGENTS §9). The 13 e2e specs cover signup, login,
composer From/bounce, buy, relay settings, redirect — a good floor, not a
safety net for B1/D3/D8/D9.

### E-5. Bundle size (new observation)
The main client chunk is 1.18 MB minified / 385 KB gzip (`pnpm build`
output), over Vite's 500 KB warning. Not a correctness issue, but on the
Safari 14/iOS 15 floor it is parse cost on every cold start. Route-level
code-splitting for the mail app vs. landing is the obvious first cut.

### E-6. Orphaned stylesheet and dead type (NEW)
- `web/src/app/index.css` (**559 L**) has **no importer** — a repo-wide grep
  for `app/index.css` finds nothing; the app imports `src/index.css` only
  (`main.tsx:9`, `App.tsx:2`). The built output confirms it: only one
  stylesheet ships (`dist/assets/index-*.css`), and the build is green.
  It is a leftover from the phase-2 port, not live code.
  Before deleting, the rules were checked against the live sheet: every
  selector family in `app/index.css` (`nostr-signer__*`, `bg-graph`,
  `eyebrow`, `.safe-*`, tokens, keyframes) is present in `src/index.css`, with
  the app's variants re-scoped under `.mail-signer` (e.g. `cancel-fab` at
  `index.css:716-732`, `brand-title` at `:763`, `tab::after` at `:801`). A
  rule-text diff finds differences only in scoping/wording, not coverage.
  Delete it in the same change as a visual smoke test (login + composer +
  settings on mobile and desktop); if any `.nostr-signer__*` rule turns out to
  exist only there, migrate it first.
- `web/src/app/types/nostr.ts` (5 L, `RelayConfig`) has zero importers —
  delete.
- `RelayManager.tsx` and `ThemeToggle.tsx` *are* used (grep for the bare
  basename misses `@/app/...` alias imports; both are imported by
  `RelaysSection.tsx`/`OnboardingModal.tsx` and `Sidebar.tsx` respectively) —
  not dead. Noted so a future sweep does not repeat the false positive.

Dead-code sweep method for the next revision: match on import specifier
(`from '@/app/components/...'`), not basename, or use `ts-prune`/`knip`.

---

## F. Mobile + shared + web merge assessment

**Verdict: `mobile/` merged into the workspace (done). `shared/` deleted as
dead code. `nostr-bridge/` stays a sibling.**

### F-1. `mobile/` → workspace (DONE)
Outcome:
- `pnpm-workspace.yaml` lists `web` + `mobile`.
- `mobile/package-lock.json` deleted; `mobile/package.json` dev/build scripts
  now invoke pnpm; Capacitor deps aligned to the web-resolved 7.6.x set
  (`@capacitor/core` 7.6.9, so mobile/web no longer drift).
- `.github/workflows/android-apk.yml` installs the workspace with
  `pnpm install --frozen-lockfile` and builds via
  `pnpm --filter mailstr-mobile run build`.
- `mobile/README.md` documents the workspace build.

Verified locally at this change: workspace `pnpm install`, `web` build + 209
unit tests + lint (11 tracked warnings) + 13/13 e2e, `mailstr-mobile build`
(web build → `www/` → `cap sync`), and `assembleDebug` produced
`app-debug.apk`. `cap sync` regenerated `capacitor.settings.gradle` with
pnpm's `.pnpm` store paths — generated file, not hand-edited.

### F-2. `nostr-bridge/` stays a sibling
Already the shared-protocol home via the `@protocol` alias and one Docker
build context copy (`web/Dockerfile`); promotion to a workspace package is
deferred by ARCHITECTURE §9 until the interface settles. Nothing in this
audit changes that. Note `nostr-bridge/` carries its own
`pnpm-workspace.yaml` + lockfile (separate resolution from the root
workspace); leave that until the protocol package is promoted.

### F-3. Remaining integration cost
The Android shell is a thin, correct wrapper now inside the workspace. The
higher-cost integration items are instead:
1. A2 (login-UI dedup) — one app, two copies.
2. B1 (account-switch resets) — cross-account correctness.
3. E-1 (no web CI) — nothing catches regressions.
4. D3/D5 — signer-failure handling and unbounded metadata replay, which the
   mobile (bunker-heavy, metered) environment punishes most.
---

## G. What's actually good (don't break it)

- `lib/` layering is intact and grew: pure tested modules under
  `app/lib/{mail,nostr,pgp,api}` with 24 test files; `DecodeQueue` is the
  model extraction (comment even cites audit C1).
- The persistence refactor is careful: same legacy keys, bare shapes,
  `mailstr.read` folded every hydration, rollback-safe, covered by
  `mail.persist.test.ts` (AGENTS §8 honored).
- The merged build preserves SEO: prerendered routes with per-route meta,
  canonical, JSON-LD, and a `noindex` mail shell with no mail markup
  (`prerender.js`; verified `dist/mails/index.html`).
- Security boundaries hold: email HTML only in the sandboxed iframe (no
  `allow-scripts`), remote images opt-in, URL scheme allow-list + AES-GCM
  authentication in attachments, filename sanitization including BiDi
  (`attachments.ts` / `emailFrame.ts`).
- The protocol trust rules are implemented where they matter: rumor≠seal
  rejected, `wrapkey` verified, From authoritative only with proof
  (`nostr-bridge/src/protocol/mail.ts`).
- Optimistic flags + `updatedAt` newest-wins reconciliation is still the
  right shape; the failures are in the reset/retry paths, not the model.
- The Android wrapper's build contract (build web from source, copy dist,
  no committed generated assets) is exactly how a shell should consume the
  app.

---

## Current work items (post rev-3)

All rev-2 findings are fixed. What remains, in priority order:

1. **B4 scaling** — `emails` map still re-renders `EmailList` per add; only a
   problem in the thousands. Revisit if mailboxes grow that far.
2. **D14 residual** — `mailState`/`wrapKeys` historical entries accumulate;
   add pruning once the tombstone model proves itself in the field.
3. **E-4 residual** — add direct unit tests for `useInbox`/`useMailMeta`
   before extending either.
4. **A2 upstream** — the login-UI helpers now live in `web/src/lib/loginUi.ts`
   and both surfaces consume them (dedup done); the named upstream fix (move
   them into `@formstr/signer` config/slots) would let the file shrink further,
   but is no longer urgent.
5. **Watch list** — the six items in AGENTS' Known offenders table; each is a
   deliberate acceptance with a stated reason, not an unknown.
