/**
 * Process-level crash and unhandled-error logging.
 *
 * Node's default behaviour for an unhandled rejection is to print the reason
 * and exit; for an uncaught exception it prints the stack and exits. Both
 * messages are easy to lose: under Docker the process is replaced by
 * `restart: unless-stopped` seconds later, so "the server crashed while a
 * large attachment was being tested" arrived with no cause attached. These
 * handlers make the last words explicit and structured, and — critically —
 * keep the two failure classes distinguishable in the log:
 *
 *   crash (uncaughtException)     — programmer error or corrupt state, the
 *                                   process must die (continuing runs on
 *                                   broken invariants).
 *   crash (unhandledRejection)    — a promise nobody caught. Fatal by default
 *                                   (Node 15+), so log and exit explicitly
 *                                   rather than letting an empty log imply a
 *                                   clean shutdown.
 *
 * `registerFatalHandlers` is idempotent so tests can call it repeatedly.
 */

let registered = false;

/**
 * True when a crash handler is already exiting, so the `exit` handler can
 * label the shutdown accurately (and so a second crash during handling does
 * not race `process.exit`). Module-scope state here is safe: it guards
 * process lifetime, not account state.
 */
let fatallyExiting = false;

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? "(no stack)"}`;
  }
  return `non-Error value: ${String(error)}`;
}

export function registerFatalHandlers(): void {
  if (registered) return;
  registered = true;

  process.on("uncaughtException", (error) => {
    fatallyExiting = true;
    console.error(`nostr-bridge: FATAL uncaught exception — process will exit\n${describe(error)}`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    fatallyExiting = true;
    console.error(
      `nostr-bridge: FATAL unhandled rejection — process will exit\n${describe(reason)}`,
    );
    process.exit(1);
  });

  // Last words on every shutdown path. `exit` alone cannot carry a cause, so
  // the handlers above set `fatallyExiting` and this distinguishes a crash
  // from an intentional stop (Docker SIGTERM) with an OOM kill (SIGKILL)
  // remaining the one silent case.
  process.on("exit", (code) => {
    console.log(
      `nostr-bridge: process exiting (code ${code}${fatallyExiting ? ", fatal" : ""})`,
    );
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.warn(`nostr-bridge: received ${signal} — shutting down`);
      process.exit(0);
    });
  }
}
