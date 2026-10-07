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
 * `isManagedDomain` extends the domain gate to tenant (workspace) domains:
 * without it the bridge would only relay for the platform's own domains. It is
 * optional so platform-only deployments (and the existing tests) behave
 * exactly as before.
 *
 * sealPubkey MUST come from the kind-13 seal. rumor.pubkey is attacker-chosen
 * plaintext inside the ciphertext and proves nothing.
 */
export async function authorizeSender(params: {
  from: string;
  sealPubkey: string;
  localDomains: string[];
  nip05BaseUrl?: string;
  isManagedDomain?: (domain: string) => Promise<boolean>;
}): Promise<AuthResult> {
  const parts = splitAddress(params.from);
  if (!parts) return { ok: false, reason: `malformed From address: ${params.from}` };

  let domainServed = params.localDomains.includes(parts.domain);
  if (!domainServed && params.isManagedDomain) {
    try {
      domainServed = await params.isManagedDomain(parts.domain);
    } catch {
      // Unknown state must refuse: an unverifiable sender must not be relayed.
      domainServed = false;
    }
  }
  if (!domainServed) {
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

/**
 * `selectDeliverTargets` with managed (tenant) domains also treated as local.
 *
 * A tenant member is reachable directly over Nostr, exactly like a platform
 * user, so a workspace address must never be relayed through SMTP — doing so
 * would loop the message back through our own MX. The managed-domain check is
 * async because it may hit the directory cache; it is resolved once per
 * distinct domain rather than once per recipient.
 */
export async function selectDeliverTargetsWithManaged(
  targets: string[],
  localDomains: string[],
  isManagedDomain: (domain: string) => Promise<boolean>,
): Promise<{ deliver: string[]; rejected: string[] }> {
  const domains = new Set<string>();
  for (const target of targets) {
    const parts = splitAddress(target);
    if (parts) domains.add(parts.domain);
  }

  const managed = new Map<string, boolean>();
  await Promise.all(
    Array.from(domains).map(async (domain) => {
      if (localDomains.includes(domain)) {
        managed.set(domain, true);
        return;
      }
      try {
        managed.set(domain, await isManagedDomain(domain));
      } catch {
        // Cannot prove it is ours: fall back to "not local", which means the
        // normal relay path — mail either delivers or bounces downstream,
        // rather than being silently dropped here.
        managed.set(domain, false);
      }
    }),
  );

  const local = Array.from(domains).filter((d) => managed.get(d));
  return selectDeliverTargets(targets, [...localDomains, ...local]);
}
