import { createHmac } from "node:crypto";

/**
 * Derives a per-recipient signing key from the bridge's master secret and the
 * recipient's pubkey, so each recipient sees a consistent "from" identity while
 * different recipients are unlinkable to each other (and to the master secret).
 * Reused both for the NIP-17 seal and for Blossom upload-auth events.
 */
export function deriveSecretKey(masterSecret: Uint8Array, targetPubkeyHex: string): Uint8Array {
  const digest = createHmac("sha256", Buffer.from(masterSecret))
    .update(Buffer.from(targetPubkeyHex, "hex"))
    .digest();
  return new Uint8Array(digest);
}
