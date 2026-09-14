/**
 * The session epoch — a counter bumped whenever account-scoped state is reset
 * (login, switch, logout).
 *
 * Async writers that started under account A capture the epoch and drop their
 * result if it has moved by the time they resolve. Without this, an in-flight
 * decode, settings publish, or key mint from the outgoing account can
 * repopulate the incoming account's stores. A standalone module so both the
 * account store and the settings store can import it without a cycle.
 */
let epoch = 0

/** The current session epoch. */
export function sessionEpoch(): number {
  return epoch
}

/** Invalidate work started before the call; returns the new epoch. */
export function bumpSessionEpoch(): number {
  return ++epoch
}

/** True when `captured` still matches the current session. */
export function isCurrentSession(captured: number): boolean {
  return epoch === captured
}
