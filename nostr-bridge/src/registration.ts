export async function checkRegistration(
  registrationApiUrl: string,
  email: string,
): Promise<string | null> {
  const res = await fetch(`${registrationApiUrl}/check/${encodeURIComponent(email)}`, {
    signal: AbortSignal.timeout(5000),
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Registration API error: ${res.status}`);

  const body = (await res.json()) as { nostr_pubkey?: string };
  if (!body.nostr_pubkey) throw new Error("Registration API response missing nostr_pubkey");
  return body.nostr_pubkey;
}
