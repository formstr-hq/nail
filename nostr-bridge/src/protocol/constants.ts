export const KIND_MAIL = 1301;
export const KIND_SEAL = 13;
export const KIND_GIFTWRAP = 1059;

/**
 * Ephemeral gift-wrap outer kind (NIP-01 ephemeral range 20000–29999). Relays
 * broadcast these to currently-connected subscribers but do NOT persist them,
 * so they suit transient control traffic — delivery receipts and the internal
 * health-ping loopback — that must never accumulate on a relay. The inner rumor
 * still carries the real kind (`KIND_DELIVERY_RECEIPT` / `KIND_HEALTH_PING`);
 * only the disposable outer envelope changes.
 */
export const KIND_GIFTWRAP_EPHEMERAL = 21059;

export const KIND_DM_RELAYS = 10050;
export const KIND_PROFILE = 0;

/**
 * Inner rumor kind carried over an ephemeral gift wrap. Not mail — the receive
 * path routes on the kind instead (see `unwrapAndVerify`'s `acceptKinds`).
 *
 *  - HEALTH_PING: bridge → itself, a loopback nonce the self-test waits to see
 *    come back, proving the receive path (relays + subscription) still works.
 */
export const KIND_HEALTH_PING = 1303;

/** NIP-42 client authentication event. */
export const KIND_CLIENT_AUTH = 22242;

/** Rumors older than this are rejected as replays (§6B step 7). */
export const MAX_RUMOR_AGE_SECONDS = 300;

/** NIP-44 v2 plaintext ceiling. Content above this cannot be encrypted at all. */
export const MAX_PLAINTEXT_BYTES = 65535;
