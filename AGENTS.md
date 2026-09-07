# AGENTS.md — nail frontend (client + landing → `web/`)

Frontend work happens in the `nail/` repo: `/home/rama/Documents/Projects/formstr-hq/nail`. Scope is frontend only — `nostr-bridge/`, `mail-server/`, and the formstr API are out of bounds unless the contract says otherwise.

## Repo map

| Path                         | What                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| `client/`                    | Webmail SPA (React 18, Vite 6, Tailwind 3, zustand, Capacitor shell)  |
| `landing/`                   | Signup/landing site (React 19, Vite 7, Tailwind 4, SSG prerender)     |
| `nostr-bridge/src/protocol/` | Shared wire protocol — imported via `@protocol`, never copy it        |
| `docs/ARCHITECTURE.md`       | **Read before any non-trivial change.** Design constraints live there |
| `shared/signer-ui.ts`        | Signer UI helpers shared with the bridge                              |

Migration in flight: client and landing merge into `web/` (see `docs/plans/FRONTEND_MERGE_PLAN.md`). Until the merge lands, treat both apps as separate builds; after it lands, this file governs `web/`.

## Rules

1. **Read `docs/ARCHITECTURE.md` first.** It records _why_ the protocol is shaped this way (kind 1301, gift wraps, NIP-05 as the mail path). Violating it breaks delivery, not just style.
2. **Never duplicate protocol/mail logic between apps.** The known duplications (`nip98`, `platform`, signer-UI tuning) are acknowledged debt with a named fix (push signer UI tuning into `@formstr/signer`) — do not add new ones.
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
7. **One persistence idiom.** All localStorage persistence goes through `zustand/persist` middleware (or, pre-merge, the `store/mail.ts` helpers) with namespaced keys and preserved migrations. Hand-rolled `localStorage.getItem` in a component or hook is rejected.
8. **No new cross-app duplication.** Logic needed by both `client/` and `landing/` goes into a shared location (`shared/`, or `lib/` post-merge) in the same change — a copy-paste "for now" is a rejected diff.
9. **No hardcoded styling drift.** Colors/spacing come from the Tailwind theme tokens; a class-string pattern repeated 3+ times gets hoisted into a shared helper/component.
10. **Router owns navigation state** (post-merge). No new overlay state as bare `useState` booleans in `App.tsx`; overlays get routes or a dedicated overlay store that the back handler reads.
11. **No unbounded work against relays/signers.** Any new subscription or per-event computation must state its bound (dedup guard, queue limit) in the diff.
12. **Security boundaries are non-negotiable.** Email HTML renders only in the sandboxed iframe (`lib/mail/emailFrame.ts`); remote images stay opt-in; secrets never enter logs or `console.*`.

## Command reference (run inside `client/`, `landing/`, or `web/`)

```sh
pnpm dev        # dev server (client proxies /api; E2E=1 disables watcher)
pnpm build      # tsc -b && vite build (landing: + SSR + prerender)
pnpm test       # vitest run (client)
pnpm e2e        # playwright
pnpm lint       # eslint
```

## Verification before you claim done

- `pnpm build` + `pnpm test` + `pnpm lint` in the app you touched, at the exact commit you'll cite.
- Any claim about mail delivery behavior needs either a unit test around `lib/mail`/`lib/nostr` or an `e2e-nostr` run — never "should work".
- UI claims: name the e2e spec that exercises it.
