/** Group a 40-hex fingerprint into the conventional space-separated blocks. */
export function formatFingerprint(fp: string): string {
  return fp.toUpperCase().replace(/(.{4})/g, '$1 ').trim()
}

export const inputClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] text-foreground placeholder:text-subtle focus:outline-none'
export const areaClass =
  'w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] text-foreground placeholder:text-subtle focus:outline-none'

/** Re-armor just the public half of an armored private key. */
export async function extractPublicKey(armoredPrivate: string): Promise<string> {
  const openpgp = await import('openpgp')
  const key = await openpgp.readPrivateKey({ armoredKey: armoredPrivate })
  return key.toPublic().armor()
}