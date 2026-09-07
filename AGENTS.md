# AGENTS.md — nail frontend (client + landing → `web/`)

Frontend work happens in the `nail/` repo: `/home/rama/Documents/Projects/formstr-hq/nail`. Scope is frontend only — `nostr-bridge/`, `mail-server/`, and the formstr API are out of bounds unless the contract says otherwise.

## Repo map

| Path | What |
|---|---|
| `client/` | Webmail SPA (React 18, Vite 6, Tailwind 3, zustand, Capacitor shell) |
| `landing/` | Signup/landing site (React 19, Vite 7, Tailwind 4, SSG prerender) |
| `nostr-bridge/src/protocol/` | Shared wire protocol — imported via `@protocol`, never copy it |
| `docs/ARCHITECTURE.md` | **Read before any non-trivial change.** Design constraints live there |
| `shared/signer-ui.ts` | Signer UI helpers shared with the bridge |

Migration in flight: client and landing merge into `web/` (see PLANS/NAIL_FE_MERGE_PLAN.md in the Gerald workspace). Until the merge lands, treat both apps as separate builds; after it lands, this file governs `web/`.

## Rules

1. **Read `docs/ARCHITECTURE.md` first.** It records *why* the protocol is shaped this way (kind 1301, gift wraps, NIP-05 as the mail path). Violating it breaks delivery, not just style.
2. **Never duplicate protocol/mail logic between apps.** The known duplications (`nip98`, `platform`, signer-UI tuning) are acknowledged debt with a named fix (push signer UI tuning into `@formstr/signer`) — do not add new ones.
3. **`lib/` is the boundary.** Pure, tested modules (`lib/mail`, `lib/pgp`, `lib/nostr`) hold logic; components/hooks stay thin. New logic goes in `lib/` with a `.test.ts` beside it — run `pnpm test` in the app you touched.
4. **Every mail action is optimistic + reconciled by `updatedAt`.** Never block UI on relay publishes; never write a second source of truth for read/archived/trashed — go through `useMailStore` flags.
5. **Signer calls cost relay round-trips (NIP-46).** Never add unbounded per-event signer work; keep decode queue bounds. Don't subscribe without dedup guards (`seenIds`/`deletedIds` pre-checks exist for this).
6. **Browser support floor: es2020 / Safari 14 / iOS 15.** The Vite build target and the IIFE worker format exist because of iOS Safari — don't "modernize" them. Local relay runs in a classic worker; module workers break pre-15 Safari.
7. **Email rendering stays sandboxed.** HTML bodies render in the iframe via `lib/mail/emailFrame.ts` with no `allow-scripts`. Never render remote HTML outside it, never auto-load remote images.
8. **localStorage keys are namespaced** (`mailstr.*`) and migration paths (e.g. `mailstr.read` → `mailstr.mailstate.v1`) must be preserved — deleting a legacy key breaks upgrades on real devices.
9. **Android/Capacitor back navigation** is wired by `installAndroidBackHandler`; if you add an overlay, add its case to the back stack (or the router equivalent post-merge) or back will exit the app mid-overlay.
10. **No `any`, no silent catch.** Failure states surface in UI (`InboxStatus.error`, DebugErrorOverlay), not just console.
11. **Tests before refactor, tests after feature.** `lib/` units in vitest; Playwright e2e for login/compose/settings flows. Never shrink the suite to make a diff green.
12. **Commits:** imperative subject ≤ 72 chars; reference the issue/task id when one exists. Do not commit `node_modules`, `dist`, or local `.env`.
13. **Never ssh into any server.** Deployments go through the repo's docker-compose/scripts only.

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