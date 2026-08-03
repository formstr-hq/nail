/**
 * The mailbox name an address authorizes against. SMTP treats `Xyz@` and
 * `xyz@` as one mailbox and `xyz+tag@` as a subaddress of `xyz`, but NIP-05
 * lookup is an exact string match — so both must be normalized away before
 * the record is fetched (§3).
 */
export function normalizeLocalpart(address: string): string {
  const at = address.indexOf("@");
  const local = at > 0 ? address.slice(0, at) : address;
  const plus = local.indexOf("+");
  return (plus > 0 ? local.slice(0, plus) : local).toLowerCase();
}

export function splitAddress(
  address: string,
): { localpart: string; domain: string } | null {
  const at = address.indexOf("@");
  if (at < 1) return null;
  const domain = address.slice(at + 1).toLowerCase();
  if (!domain) return null;
  return { localpart: normalizeLocalpart(address), domain };
}

export function isNpub(value: string): boolean {
  return value.startsWith("npub1") && value.length === 63;
}

export function isHexPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
