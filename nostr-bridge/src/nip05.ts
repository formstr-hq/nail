import { normalizeLocalpart, splitAddress } from "./protocol/address.js";

export type Nip05Result =
  | { status: "found"; pubkey: string }
  | { status: "not-found" }
  | { status: "error"; message: string };

/**
 * Resolve an address through NIP-05.
 *
 * The three outcomes are deliberately distinct. "not-found" is permanent and
 * must produce a 550; "error" is transient and must produce a 451. Collapsing
 * them (as the previous `null`-returning version did) turns a backend outage
 * into a permanent bounce for every inbound message.
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

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }

  if (res.status === 404) return { status: "not-found" };
  if (!res.ok) return { status: "error", message: `HTTP ${res.status}` };

  let body: { names?: Record<string, string> };
  try {
    body = (await res.json()) as { names?: Record<string, string> };
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }

  const pubkey = body.names?.[name];
  return pubkey ? { status: "found", pubkey } : { status: "not-found" };
}
