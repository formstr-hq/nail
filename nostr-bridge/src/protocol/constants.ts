export const KIND_MAIL = 1301;
export const KIND_SEAL = 13;
export const KIND_GIFTWRAP = 1059;
export const KIND_DM_RELAYS = 10050;
export const KIND_PROFILE = 0;

/** Rumors older than this are rejected as replays (§6B step 7). */
export const MAX_RUMOR_AGE_SECONDS = 300;

/** NIP-44 v2 plaintext ceiling. Content above this cannot be encrypted at all. */
export const MAX_PLAINTEXT_BYTES = 65535;
