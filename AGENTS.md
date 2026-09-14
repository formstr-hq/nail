# AGENTS.md — nail frontend (`client/web/`)

Frontend work happens in the `nail/` repo: `/home/rama/Documents/Projects/formstr-hq/nail`. Scope is frontend only — `nostr-bridge/`, `mail-server/`, and the formstr API are out of bounds unless the contract says otherwise.

## Repo map

| Path                         | What                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| `client/web/`                | The frontend: landing (prerendered at `/`) + mail client (`/mails`) in one Vite app (React 19, Tailwind 4, zustand) |
| `client/web/src/lib/`        | Shared modules: `nip98`, `platform`, `session`, `signer`, `config`    |
| `client/web/src/app/`        | The mail client: `components/`, `hooks/`, `store/`, `lib/`            |
| `nostr-bridge/src/protocol/` | Shared wire protocol — imported via `@protocol`, never copy it        |
| `client/`                    | Capacitor native shell (`android/`, future `ios/`); consumes `client/web/`'s built `dist` — no app source of its own |
| `docs/ARCHITECTURE.md`       | **Read before any non-trivial change.** Design constraints live there |

The client/landing merge is complete: one app, one build, one deploy (see `docs/plans/FRONTEND_MERGE_PLAN.md` — phases 1–5 done). `client/` and `client/web/` are pnpm-workspace members (`pnpm-workspace.yaml`) and install/build from the repo root; `shared/` was deleted as dead code — shared frontend logic lives in `client/web/src/lib/`.

All rules, and architecture principles are non negotiable unless specifically stated otherwise. Ask the user if there is a contradiction.

## Rules

1. **Read `docs/ARCHITECTURE.md` first.** It records _why_ the protocol is shaped this way (kind 1301, gift wraps, NIP-05 as the mail path). Violating it breaks delivery, not just style.
2. **Never duplicate protocol/mail logic.** The remaining duplication (login-UI tuning in `SignupWizard` ↔ `LoginPage`) is acknowledged debt with a named fix (push it into `@formstr/signer`) — do not add new ones.
3. **`lib/` is the boundary.** Pure, tested modules (`lib/mail`, `lib/pgp`, `lib/nostr`) hold logic; components/hooks stay thin. New logic goes in `lib/` with a `.test.ts` beside it — run `pnpm test` in the app you touched.
4. **Every mail action is optimistic + reconciled by `updatedAt`.** Never block UI on relay publishes; never write a second source of truth for read/archived/trashed — go through `useMailStore` flags.
5. **Signer calls cost relay round-trips (NIP-46).** Never add unbounded per-event signer work; keep decode queue bounds. Don't subscribe without dedup guards (`seenIds`/`deletedIds` pre-checks exist for this).
6. **Browser support floor: es2020 / Safari 14 / iOS 15.** The Vite build target and the IIFE worker format exist because of iOS Safari — don't "modernize" them. Local relay runs in a classic worker; module workers break pre-15 Safari.
7. **Email rendering stays sandboxed.** HTML bodies render in the iframe via `lib/mail/emailFrame.ts` with no `allow-scripts`. Never render remote HTML outside it
8. **localStorage keys are namespaced** (`mailstr.*`) and migration paths (e.g. `mailstr.read` → `mailstr.mailstate.v1`) must be preserved — deleting a legacy key breaks upgrades on real devices.
9. **Android/Capacitor back navigation** is wired by `installAndroidBackHandler`; if you add an overlay, add its case to the back stack (or the router equivalent post-merge) or back will exit the app mid-overlay.
10. **No `any`, no silent catch.** Failure states surface in UI (`InboxStatus.error`, DebugErrorOverlay), not just console.
11. **Tests before refactor, tests after feature.** `lib/` units in vitest; Playwright e2e for login/compose/settings flows. Never shrink the suite to make a diff green.
12. **Commits:** imperative subject ≤ 72 chars; reference the issue/task id when one exists. Do not commit `node_modules`, `dist`, or local `.env`.
13. **Never ssh into any server unless explicitly asked by the developer** Deployments go through the repo's docker-compose/scripts only. If there is a need to ssh then request permissions
14. Remove dead code unless stated otherwise.
15. All changes in a session must be logged into "Session-Log.md" in docs. Especially if there is an arch change, then log the ADR. Atleast last 3 logs must be consulted before doing work to gain previous context.

## Role

Act as a **principal software developer** and behave as one:

- **Own the whole diff, not just your task.** Anticipate how a change affects delivery, sync, mobile, and the bridge — a frontend change that breaks the protocol contract is broken, not "done".
- **Push back with evidence.** If a request conflicts with `docs/ARCHITECTURE.md`, the audit findings, or the platform constraints (Safari floor, signer cost, sandbox), say so in the work itself, cite the source, and propose the alternative — do not silently implement something wrong.
- **Plan before multi-file work.** Any change touching >2 files or a store gets a short written plan first (what, why, how it's verified). No opportunistic refactors bundled into feature diffs.
- **Verify before claiming done** — see the checklist at the bottom. "Should work" is not a status.

## Architecture rules (anti-patterns to refuse)

These encode the audit findings (`docs/FRONTEND_AUDIT.md`) as hard rules. Violations in review are blocking, not stylistic.

1. **File size discipline.** Target ≤300 lines per file, hard alarm at 500. A component or module crossing it gets split along its seams (container/presenter, per-section files) in the same change that pushes it over — do not leave it "for later".
2. **Container/presenter split.** Store wiring, protocol calls, and signer calls live in hooks/containers; presenters render from props and must not import `lib/nostr`, `lib/pgp`, or the stores directly.
3. **No god components.** One component = one responsibility. A modal owning send + PGP + contacts + settings (see `ComposeModal.tsx` at 728 lines) is the anti-pattern; split into subcomponents + a state hook before extending it.
4. **No `useState` mirrors of store/async data.** Derive with selectors/`useMemo` beside the store; if you must copy store data into local state, the sync-back effect and its staleness risk need a written justification in the diff.
5. **No module-level mutable singletons guarding lifecycle** (`let initialized = false`, module-scope promise caches) — they survive account switches and create cross-account leaks. State that persists belongs in a store with an explicit reset; in-flight dedup belongs inside the store/hook scope.
6. **Effects orchestrate, services compute.** Schedulers, queues (e.g. the inbox decode pump), and watchdogs are extracted into plain testable modules — not closures inside `useEffect`. Effects with >3 deps or a `setInterval` inside are a smell requiring justification.
7. **One persistence idiom.** All localStorage persistence goes through `zustand/persist` middleware (or, pre-refactor, the `store/mail.ts` helpers) with namespaced keys and preserved migrations. Hand-rolled `localStorage.getItem` in a component or hook is rejected.
8. **No new cross-app duplication.** Logic needed by both the landing and the mail client goes into `client/web/src/lib/` in the same change — a copy-paste "for now" is a rejected diff. (`shared/` is gone; the login-UI tuning both surfaces use now lives in `client/web/src/lib/loginUi.ts`.)
9. **No hardcoded styling drift.** Colors/spacing come from the Tailwind theme tokens; a class-string pattern repeated 3+ times gets hoisted into a shared helper/component.
10. **Router owns navigation state.** No new overlay state as bare `useState` booleans in `App.tsx`; overlays get routes or a dedicated overlay store that the back handler reads.
11. **No unbounded work against relays/signers.** Any new subscription or per-event computation must state its bound (dedup guard, queue limit) in the diff.
12. **Security boundaries are non-negotiable.** Email HTML renders only in the sandboxed iframe (`lib/mail/emailFrame.ts`); remote images stay opt-in; secrets never enter logs or `console.*`.
13. **Proven libraries before hand-rolled core logic.** For core modules and logic — crypto, parsing, protocol handling, encoding, date/time, storage, queues — use a known, well-reputed package with a permissive (non-copyleft) license instead of writing an implementation by hand. Hand-rolling is the exception: it requires the developer's explicit direction, or the agent stops and asks permission first, naming the library candidates it considered and why they don't fit. Copy-left (GPL/AGPL) dependencies need the same permission even when off-the-shelf.

## Known offenders (legacy anti-patterns on watch)

These are the remaining tracked residuals after the rev-3 audit fix pass
(`docs/FRONTEND_AUDIT.md`, revision 3). They are **warnings, not licenses**:
don't replicate the pattern, and shrink the offender when you touch it. Paths
without a `client/web/src/` prefix are under `client/web/src/app/`.

| Offender | Where | Why it's a warning |
|---|---|---|
| Store-shape full re-renders | `store/mail.ts` (`emails` map replaced wholesale on each add) | B4 — `EmailList` is memoized, so this is a scaling watch item, not a current bug; don't grow it further |
| `useState` form seed without sync-back | `components/SettingsModal.tsx` (`signature`, `relays`), `hooks/useSenderDraft.ts` | C1 residual — accepted per rule 4: drafts with no sync-back, and saves are patches (B6) so they cannot clobber |
| Unbounded on-disk history growth | `store/mail.ts` (`mailState`/`wrapKeys` maps never pruned; tombstones accumulate) | D14 residual — deletions are single-stored now; historical read/archive entries still grow |
| Hook/component test gaps | `hooks/useInbox.ts`, `hooks/useMailMeta.ts` lack direct unit tests | E-4 residual — covered indirectly (e2e + lib tests); add a unit test before extending either |
| Orphaned stylesheet risk | `client/web/src/index.css` is the only live global sheet; if you add a new entry, import it (the deleted `app/index.css` is the cautionary tale) | E-6 — verify an import exists before assuming styles ship |
| Android back edge cases | `lib/androidBack.ts` exits on decline; new overlays must still be added to `App.tsx` `handleBack` | D12 — a missed overlay now exits the app rather than silently no-oping |

Everything else from the rev-2 offender list was fixed in the rev-3 pass and is
covered by tests: account-scoped reset (B1/B2), sync-error surfacing (B3),
mailIndexKey durability (B5), serialized settings patches (B6), signer-failure
taxonomy + bounded retries (D3/D5/D11), worker boot errors (D6/D7), recipient
dedup (D8), PGP discovery (D9), save-file revoke (D10), notifications watcher
(D13), web CI (E-1), shared bounded queue (E-3), and the oversized
components/login-UI duplication (A1/A2).

**Async store writers cross an account reset unless guarded.** If your code
awaits anything (a signer call, a relay publish, a fetch) and then calls
`set()`/`addEmail`/`hydrateFlags`, capture `sessionEpoch()` before the await
and bail when `!isCurrentSession(captured)` — a logout/switch clears the
stores, and an unguarded late write repopulates the incoming account (ADR-003).
React's `alive` flag only covers unmount, not account change.

Dead-code sweep note: match on import specifier (`from '@/app/...'`), not
basename — alias imports hide usages (see audit E-6). Rule of thumb: if a diff
adds code that would land in the left column, it needs a reason in writing —
or a different shape.

## Command reference

Workspace root (`pnpm install` installs both apps):

```sh
pnpm --filter mailstr-web build     # tsc + vite + SSR + prerender + /mails shell
pnpm --filter mailstr-web test      # vitest run
pnpm --filter mailstr-web lint      # eslint
pnpm --filter mailstr-web e2e       # playwright (landing + mail app specs, mock relay)
pnpm --filter mailstr-client build  # build client/web, assemble www/, cap sync android
```

Inside `client/web/` (`pnpm dev`, `pnpm build`, `pnpm test`, `pnpm e2e`,
`pnpm lint` all work as before); inside `client/`, `pnpm build` /
`pnpm apk:debug` / `pnpm apk:release`.

## Verification before you claim done

- `pnpm build` + `pnpm test` + `pnpm lint` in the app you touched, at the exact commit you'll cite. `.github/workflows/web-ci.yml` runs the same gate (lint → test → build → e2e) on pushes/PRs touching `client/web/` or the protocol, so a green CI run is the strongest evidence.
- The shared protocol lives in `nostr-bridge/src/protocol/`; if you changed it, also run `pnpm test` in `nostr-bridge/` and `tsc --noEmit` in `nostr-bridge/` and `e2e-nostr/` (both consume it).
- Any claim about mail delivery behavior needs either a unit test around `lib/mail`/`lib/nostr` or an `e2e-nostr` run — never "should work".
- UI claims: name the e2e spec that exercises it.
