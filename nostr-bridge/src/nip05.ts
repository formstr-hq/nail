export async function lookupNip05Pubkey(
  email: string,
  baseUrl?: string,
): Promise<string | null> {
  const atIdx = email.indexOf("@");
  if (atIdx < 1) return null;
  const localPart = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);

  const resolverBase = baseUrl ?? `https://${domain}`;
  const url = `${resolverBase}/.well-known/nostr.json?name=${encodeURIComponent(localPart)}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { names?: Record<string, string> };
    return body.names?.[localPart] ?? null;
  } catch {
    return null;
  }
}
