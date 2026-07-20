import { lookupNip05 } from "./nip05.js";
import { normalizeLocalpart, splitAddress } from "./protocol/address.js";

export type AuthResult =
  | { ok: true; address: string }
  | { ok: false; reason: string };

/**
 * May this sealer send as this From address? (§5)
 *
 * Two independent facts are combined: the seal signature proves possession of
 * sealPubkey, and the NIP-05 record proves the backend assigned that name to
 * that pubkey. Anything else is refused — including every transient failure,
 * because an unverifiable sender must not be relayed.
 *
 * sealPubkey MUST come from the kind-13 seal. rumor.pubkey is attacker-chosen
 * plaintext inside the ciphertext and proves nothing.
 */
export async function authorizeSender(params: {
  from: string;
  sealPubkey: string;
  localDomains: string[];
  nip05BaseUrl?: string;
}): Promise<AuthResult> {
  const parts = splitAddress(params.from);
  if (!parts) return { ok: false, reason: `malformed From address: ${params.from}` };

  if (!params.localDomains.includes(parts.domain)) {
    return {
      ok: false,
      reason: `Domain "${parts.domain}" is not served by this bridge`,
    };
  }

  const lookup = await lookupNip05(params.from, params.nip05BaseUrl);
  if (lookup.status === "error") {
    return { ok: false, reason: `NIP-05 lookup failed: ${lookup.message}` };
  }
  if (lookup.status === "not-found") {
    return { ok: false, reason: `No NIP-05 record for ${params.from}` };
  }
  if (lookup.pubkey !== params.sealPubkey) {
    return { ok: false, reason: `${params.from} is not owned by the sending key` };
  }

  return { ok: true, address: `${normalizeLocalpart(params.from)}@${parts.domain}` };
}

/**
 * Split the envelope into addresses this bridge will deliver to and ones it
 * refuses. Local-domain targets are refused: they are reachable directly over
 * Nostr, and relaying to them here would bypass the inbound rules (§6B).
 */
export function selectDeliverTargets(
  targets: string[],
  localDomains: string[],
): { deliver: string[]; rejected: string[] } {
  const deliver: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const parts = splitAddress(target);
    if (!parts) {
      rejected.push(target);
      continue;
    }
    if (localDomains.includes(parts.domain)) {
      rejected.push(target);
      continue;
    }
    const key = `${parts.localpart}@${parts.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deliver.push(target);
  }

  return { deliver, rejected };
}
