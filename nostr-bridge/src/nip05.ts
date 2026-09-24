import { normalizeLocalpart, splitAddress } from "./protocol/address.js";

export type Nip05Result =
  | { status: "found"; pubkey: string }
  | { status: "not-found" }
  | { status: "error"; message: string };

/**
 * Resolver settings, read from the environment at call time.
 *
 * Deliberately NOT from config.ts: that module parses the bridge key and
 * throws at import time, and nip05.ts is imported by units (tests, tooling)
 * that must not require a full bridge environment. These two values are
 * optional by nature — absent means "no resolver fallback".
 */
function resolverSettings(): { url: string; key: string } {
  return {
    url: process.env.NIP05_RESOLVER_URL ?? "",
    key: process.env.NIP05_RESOLVER_KEY ?? "",
  };
}

/**
 * Resolve an address through the backend resolver.
 *
 * Tenant (workspace) domains have no public web presence, so their addresses
 * cannot be resolved by fetching `https://<domain>/.well-known/nostr.json` —
 * there is nothing listening. The backend already holds these records and
 * exposes them at `/api/nip-05/resolve`. This is the fallback path for exactly
 * those domains; platform domains keep using their own well-known.
 *
 * Same three-outcome contract as lookupNip05: a 404 means "no such address"
 * (permanent), anything else that fails means "try again" (transient).
 *
 * Returns `null` when the resolver is not configured at all — distinct from a
 * resolver error. "Not configured" means this deployment has no fallback, so
 * the calling lookup (the well-known) must supply the verdict; a resolver
 * error, by contrast, is a genuine failure to determine anything.
 */
async function lookupResolver(address: string): Promise<Nip05Result | null> {
  const { url: resolverUrl, key: resolverKey } = resolverSettings();
  if (!resolverUrl) return null;

  const url = `${resolverUrl.replace(/\/$/, "")}/api/nip-05/resolve?address=${encodeURIComponent(address)}`;

  let res: Response;
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (resolverKey) {
      headers.authorization = `Bearer ${resolverKey}`;
    }
    res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }

  if (res.status === 404) return { status: "not-found" };
  if (!res.ok) return { status: "error", message: `HTTP ${res.status}` };

  let body: { pubkey?: string };
  try {
    body = (await res.json()) as { pubkey?: string };
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }

  return body.pubkey
    ? { status: "found", pubkey: body.pubkey }
    : { status: "not-found" };
}

/**
 * Resolve an address through NIP-05.
 *
 * The three outcomes are deliberately distinct. "not-found" is permanent and
 * must produce a 550; "error" is transient and must produce a 451. Collapsing
 * them (as the previous `null`-returning version did) turns a backend outage
 * into a permanent bounce for every inbound message.
 *
 * Fallback order, and the rule that decides it:
 *
 * 1. A well-known that answers with a usable NIP-05 document is authoritative:
 *    a hit resolves. An absent name also gets one resolver check (cheap
 *    server-to-server; a managed domain may serve a well-known for other
 *    reasons while the record lives in the backend), but if the resolver finds
 *    nothing the domain's own answer stands.
 * 2. Otherwise — a 404, a non-JSON body (an SPA answering 200 for everything),
 *    or an unreachable host — the domain gave us no usable answer. This is
 *    exactly the tenant case (a workspace domain need not run a web server),
 *    so the backend resolver decides. Its 404 is "not-found"; its success is
 *    "found"; its failure is a transient "error" (defer, never bounce).
 * 3. With no resolver configured, a 404 remains a definitive "not-found", but
 *    an unreachable well-known becomes "error" — unresolved is transient, and
 *    must not silently become a bounce.
 */
export async function lookupNip05(
  address: string,
  baseUrl?: string,
): Promise<Nip05Result> {
  const parts = splitAddress(address);
  if (!parts) return { status: "error", message: `malformed address: ${address}` };

  const name = normalizeLocalpart(address);
  const base = baseUrl ?? `https://${parts.domain}`;
  const url = `${base}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;

  // "answered" carries a usable body; "absent" is a definitive no; "unusable"
  // means there was no answer at all (see the doc comment above).
  let wellKnown:
    | { kind: "answered"; names?: Record<string, string> }
    | { kind: "absent" }
    | { kind: "unusable" };

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.status === 404) {
      wellKnown = { kind: "absent" };
    } else if (!res.ok) {
      wellKnown = { kind: "unusable" };
    } else {
      try {
        const body = (await res.json()) as { names?: Record<string, string> };
        wellKnown = { kind: "answered", names: body.names };
      } catch {
        // An SPA answering 200 for every path lands here, not in "absent".
        wellKnown = { kind: "unusable" };
      }
    }
  } catch {
    wellKnown = { kind: "unusable" };
  }

  if (wellKnown.kind === "answered") {
    const pubkey = wellKnown.names?.[name];
    if (pubkey) return { status: "found", pubkey };
    // The domain serves a real NIP-05 document and does not list this name.
    // Normally that is its final answer. Give the resolver one look anyway
    // (cheap server-to-server, and a managed domain could serve a well-known
    // for other reasons while the record lives in the backend) — but if the
    // resolver finds nothing, the domain's own answer stands.
    const viaResolver = await lookupResolver(address);
    return viaResolver?.status === "found" ? viaResolver : { status: "not-found" };
  }

  // "absent" (404, so nothing serves NIP-05 there) and "unusable" both mean
  // the domain gave us no usable answer. This is the normal tenant path — a
  // workspace domain need not run a web server at all — so the resolver is the
  // authority: its 404 is "not-found", its success is "found", and its failure
  // stays transient (defer, never bounce).
  const viaResolver = await lookupResolver(address);
  if (viaResolver !== null) return viaResolver;

  // No resolver configured at all. A 404 is still a definitive no; an
  // unreachable well-known leaves the address unresolved, which must be
  // transient so inbound mail defers rather than bouncing.
  return wellKnown.kind === "absent"
    ? { status: "not-found" }
    : { status: "error", message: "no usable NIP-05 source" };
}
