import { nip19 } from "nostr-tools";
import { config } from "./config";

export type ParsedIdentity =
  | { kind: "pubkey"; pubkey: string }
  | { kind: "name"; name: string };

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;
// Local parts we accept for name@mailstr.app — conservative on purpose:
// lowercase alphanumerics with dots/underscores/hyphens in the middle.
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/**
 * Interpret whatever the user typed in the hero input:
 * an npub, a hex pubkey, a bare name, or name@mailstr.app.
 * Returns null when it's none of those.
 */
export function parseIdentityInput(raw: string): ParsedIdentity | null {
  const input = raw.trim().toLowerCase();
  if (!input) return null;

  if (input.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(input);
      if (decoded.type === "npub") {
        return { kind: "pubkey", pubkey: decoded.data };
      }
    } catch {
      return null;
    }
    return null;
  }

  if (HEX_PUBKEY.test(input)) {
    return { kind: "pubkey", pubkey: input };
  }

  const name = input.endsWith(`@${config.mailDomain}`)
    ? input.slice(0, -(config.mailDomain.length + 1))
    : input.includes("@")
      ? null // an address on a foreign domain isn't something we can claim
      : input;

  if (name && isValidLocalPart(name)) {
    return { kind: "name", name };
  }
  return null;
}

export function isValidLocalPart(name: string): boolean {
  return LOCAL_PART.test(name);
}

export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}
