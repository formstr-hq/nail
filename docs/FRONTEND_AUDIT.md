# Nail Frontend Audit — Anti-Patterns & Bad Code

Scope: `nail/client` (webmail) + `nail/landing` (landing/signup). Backend/bridge out of scope.
Evidence: all findings verified by reading the source at `formstr-hq/nail` (client HEAD: 6bd8a35 "pgp fixes").

---

## A. Structural / architectural

### A1. Two apps, two different React majors, zero shared code
`client/` is React 18 + Tailwind 3 + Vite 6; `landing/` is React 19 + Tailwind 4 + Vite 7. They were forked with no workspace and now duplicate code verbatim:
- `client/src/components/LoginPage.tsx` ↔ `landing/src/components/SignupWizard.tsx` — ~450 lines of duplicated signer-UI tuning (TAB_COPY, tuneLoginUi, methodListNav, autoGenerateQr). Both files carry a comment admitting the duplication and naming the fix ("move this DOM tuning upstream into @formstr/signer").
- `client/src/lib/api/nip98.ts` ↔ `landing/src/lib/nip98.ts`
- `client/src/lib/platform.ts` ↔ `landing/src/lib/platform.ts` (identical 13 lines)
- `landing/src/lib/session.ts`/`signer.ts` overlap client signer handling.
This is why bugs get fixed twice (or once) — a classic drift farm.

### A2. Two separately deployed frontends for one product
"Combine client and landing page" (owner request) is the fix: one app, routing (`/` = SEO landing, `/app/*` or post-login = mail client), one build, one React version. Landing already has prerender/SSG (`prerender.js`, entry-server) — merge that pipeline in and keep the client SPA chunk separate. Detail: `client/src/App.tsx` comment admits "at the root of the client, the first history entry is the landing page" — Android back-button hacks exist precisely because two apps share one web origin.

### A3. No router anywhere
Client navigation is `useState` booleans (`compose`, `composeMinimized`, `settingsSection`, `navOpen`, `selectedId`) in `App.tsx`, plus a hand-rolled back-button stack (`installAndroidBackHandler` + `handleBack` with 6 manual cases). Every overlay state is invisible to the URL: no deep links, no shareable settings state, no browser back on web. A router (even hash-based, Capacitor-safe) deletes ~80 lines of manual stack logic and fixes back-button for free.

### A4. God components
- `ComposeModal.tsx` — 728 lines, 6 effects, owns send + PGP + contacts + From-switcher + minimize + discard-confirm. Should be: composer state hook + `RecipientPicker`, `FromSwitcher`, `ComposerToolbar`, `SendFlow` subcomponents.
- `SettingsModal.tsx` — 674 lines, embeds relay editing, sender identity, signature, PGP, buy-intent.
- `PgpSettings.tsx` — 698 lines, 10 `useState` in one component.
- `EmailView.tsx` — 461 lines mixing rendering, iframe sizing, remote-image gating, PGP verify UI.

### A5. Duplicated app-level logic in `App.tsx`
`MailApp` computes `selfAddresses` dedupe, owns all overlay state, wires back handling, and renders three modal layers. Overlay state machine belongs in a store or router; `selfAddresses` belongs in a `useSelfAddresses` hook (it's used by Sidebar, EmailView, ComposeModal — currently passed as props through 3 levels).

---

## B. State management

### B1. Three different persistence idioms, hand-rolled
`store/mail.ts` (313 lines) hand-writes JSON localStorage load/persist/merge with try/catch for 4 separate keys, including a legacy migration (`mailstr.read` → `mailstr.mailstate.v1`). Meanwhile `useOwnedAddresses.ts`, `theme.ts`, `dev.ts`, `freshSignup.ts` each roll their own localStorage calls. No shared `persist()` helper or `zustand/persist` middleware — every new store reinvents serialization + corruption handling.

### B2. Module-level singletons with implicit lifecycle
- `useMailActions.ts`: `let indexKeyInflight: Promise | null` at module scope — a promise cache surviving account switches. Correct today only because the comment says so; a logout/login race would leak the old account's key mint.
- `account.ts`: `let initialized = false` module flag guarding `init()` — same pattern, same risk.
- `useInbox` implements a concurrency-limited decode queue (bounded-3 pump) inside a hook closure — nontrivial scheduler logic that belongs in a service module, testable without React.

### B3. Optimistic writes without UI feedback
`useMailActions.apply` publishes kind-34578 events in background and swallows failures (`console.error` only). User gets no signal that cross-device sync failed. Fine per design, but there's no retry/queue — a failed publish is lost until the next action.

### B4. Store shape invites full re-renders
`emails: Record<string, Email>` + `seenIds: Set` replaced wholesale on every add (`addEmail`). EmailList then filters/sorts the whole map each render (see EmailList.tsx). At a few hundred messages this is fine; at thousands (relay replays everything, no `since`) it will jank. Consider per-email selectors or normalization keyed by folder.

---

## C. React anti-patterns

### C1. Effects doing orchestration that should be a store/service
`useInbox` runs a watchdog `setInterval`, relay subscription, bounded decode queue, and status state machine in one effect with 5 deps (`[account, active, addEmail, bridgePubkey, attempt]`). `addEmail` is a stable store fn but is in the dep array — if it ever becomes unstable the subscription tears down and replays every wrap through the signer again. Fragile by construction.

### C2. `useState` mirrors of store data
`SettingsModal` seeds `senderAddress`, `signature`, `relays` from store/async fetches into local state with sync-back effects — the "copy props/state into state" pattern, each needing manual re-sync when the source changes. Derived-state or form-library approaches are cleaner.

### C3. Non-idiomatic derived state
`ComposeModal` derives default From address inline in render with fallback chains (`settings.senderAddress` → owned alias → npub) — logic commented as a bug fix for "composer/sidebar handle mismatch". This is a selector; put it beside the stores it reads.

### C4. Modal layering without a portal discipline
`App.tsx` renders modals conditionally inline; `SignerLogin` "renders its own full-screen layer; no wrapper needed" per comment. No shared `<Overlay>`/portal primitive → z-index and mobile-safe-area rules (the `safe-y` class) are copy-pasted per layer.

### C5. Giant `className` ternary strings
EmailList/EmailView/Sidebar build class strings with array-join ternaries (`['min-w-0 flex-1', selectedId ? 'hidden md:block' : 'block'].join(' ')`) — repeated ~20×. Fine once; a `cx()` helper or cva would stop the drift.

---

## D. Correctness / bug-prone spots (verified)

### D1. `hydrateFlags` deletes selected mail silently
`store/mail.ts:226` — cross-device delete clears `selectedId`, so the open message vanishes mid-read with no user feedback. Intentional per design, but no UX affordance.

### D2. `setFlag` read-sync only handles `read`
`store/mail.ts:186-189` — archived/trashed changes don't update the `emails` entry; the list re-derives via `isFiled`. Works today, but two sources of truth for the same fact.

### D3. `useInbox` `status` `relays` race
`setStatus({phase:'live', relays: withHardcodedRelay(DEFAULT_RELAYS), ...})` fires before the first `syncAccountRelays` callback — brief wrong relay count in UI.

### D4. `useResolveContext` returns a stale-safe ctx but swallows errors
Resolve failure only logs; `bridgePubkey` stays null (correct) but no UI ever sees "outbound to legacy addresses is unavailable".

### D5. `markDeleted` merges `mailState[id]` spread
`store/mail.ts:247` — `...get().mailState[id]` then `deleted: true`: fine, but `merged` keeps `read/archived` flags and publishes them in the meta event; harmless yet noise.

### D6. Landing `useIsomorphicLayoutEffect` + redirect flow
`App.tsx` (landing) `checking` state races `redirectReturningOwner()` — if resume takes long, user stares at spinner with no timeout.

---

## E. Tooling / hygiene

- **No ESLint config in client/** — `lint: "eslint ."` exists but flat config file is absent (landing has `eslint.config.js`). Client lint likely silently no-ops or errors; verify before trusting it.
- **No router, no query/cache layer** — every fetch is ad-hoc async in effects/hooks; no retry, no cache invalidation story (TanStack Query or a thin fetch-service layer would do).
- **Zero component tests** — vitest suite covers only `lib/` (good coverage there: mail, pgp, nostr). All 12 components + 9 hooks are untested; e2e exists (Playwright) but unit-level regression safety for UI logic is nil.
- **React 18 vs 19** across the two apps (blocks A1 merge).
- **`node_modules` + `dist` committed in working tree** (not gitignored at repo root — verify gitignore).
- **Landing SEO is good** (prerender, per-route meta, JSON-LD) — keep, don't regress in the merge.

---

## F. What's actually good (don't break it)

- `lib/` layering: pure, tested protocol/mail/pgp modules separated from UI. Model for everything else.
- Comments explain *why* with failure histories — rare and valuable.
- `@protocol` alias sharing wire types with the bridge prevents drift.
- Sandbox/iframed email rendering with CSP + remote-image gating is security-conscious.
- Optimistic flags with newest-wins `updatedAt` reconciliation is a correct design.