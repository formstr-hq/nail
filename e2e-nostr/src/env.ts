export const env = {
  smtpHost: process.env.SMTP_HOST ?? "localhost",
  smtpSubmissionPort: Number(process.env.SMTP_SUBMISSION_PORT ?? 587),
  imapHost: process.env.IMAP_HOST ?? "localhost",
  imapPort: Number(process.env.IMAP_PORT ?? 143),
  mailcowUser: process.env.MAILCOW_TEST_USER ?? "test@mailcow.local",
  mailcowPassword: process.env.MAILCOW_TEST_PASSWORD ?? "123456",
  bridgeDomain: process.env.NOSTR_BRIDGE_DOMAIN ?? "nostr-forward.local",
  bridgePubkey:
    process.env.NOSTR_BRIDGE_PUBKEY ??
    "54a9f6323e7cb952c0933e7eff7e7268a793da77e6a1cb04f29582ab30dd7a3c",
  // If set, tests connect to this relay; otherwise nostr-mock-relay starts in-process.
  // Use 127.0.0.1 (not localhost) — localhost resolves to ::1 first on this host and
  // Docker's IPv6 DNAT path is unreliable.
  relayUrl: process.env.RELAY_URL,
  // Port for the NIP-05 mock HTTP server (bridge must be configured with NIP05_BASE_URL pointing here).
  nip05Port: Number(process.env.NIP05_PORT ?? 4500),
  deliveryTimeoutMs: Number(process.env.DELIVERY_TIMEOUT_MS ?? 30000),
  blossomServerUrl:
    process.env.BLOSSOM_SERVER_URL ?? "https://blossom.primal.net",
};
