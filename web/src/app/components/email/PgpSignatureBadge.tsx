import type { SignatureState } from '@/app/lib/pgp/openpgp'
import { LockIcon } from '@/app/components/ui/icons'

/**
 * The one-line signature verdict shown above a decrypted PGP message. Honest
 * and specific — "signed by a key you don't have" is not "verified", and a
 * failed signature is a loud warning, never a quiet pass. Mirrors SenderProof.
 */
export function PgpSignatureBadge({ signature }: { signature: SignatureState }) {
  const map = {
    valid: { text: 'Signature verified', cls: 'border-border bg-background/60 text-muted-foreground' },
    'unknown-key': {
      text: 'Signed, but by a key you don’t have — import it to verify',
      cls: 'border-border bg-background/60 text-muted-foreground',
    },
    invalid: {
      text: 'BAD SIGNATURE — this message failed verification',
      cls: 'border-destructive bg-destructive/10 text-destructive',
    },
    none: { text: 'Not signed', cls: 'border-border bg-background/60 text-subtle' },
  }[signature.status]
  return (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] ${map.cls}`}>
      <LockIcon className="h-3 w-3 flex-none" />
      <span>Decrypted · {map.text}</span>
    </div>
  )
}
