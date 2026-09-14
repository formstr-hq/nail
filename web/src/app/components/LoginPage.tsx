import { useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { BrandGlyph } from '@/app/components/ui/icons'
import { SignerLogin } from './login/SignerLogin'
import { UnlockForm } from './login/UnlockForm'
import { ResumeFailed } from './login/ResumeFailed'

/**
 * The mail app's login page. Three states:
 *  - a locked/stale persisted signer → unlock or resume prompt (ours);
 *  - otherwise the @formstr/signer method picker (`SignerLogin`), which
 *    renders its own full-viewport modal carrying the brand header.
 */
export function LoginPage() {
  const account = useAccountStore((s) => s.account)
  // Show the full login UI instead of the unlock/resume prompt without
  // logging out first — logout() deletes the stored account (including
  // the ncryptsec), which "use a different account" must never do.
  const [useAnother, setUseAnother] = useState(false)

  const resuming = Boolean(account) && !useAnother

  // The signer package renders its own full-viewport modal; wrapping that in a
  // second header would put one behind the overlay where nobody sees it, so
  // the page chrome below belongs only to the unlock and resume paths.
  if (!resuming) {
    return (
      <div className="mail-app mail-signer bg-graph safe-y min-h-[100dvh] bg-background">
        <SignerLogin />
      </div>
    )
  }

  return (
    <div className="mail-app bg-graph safe-y flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-sm flex-col gap-6 py-10">
        <div className="flex flex-col items-center gap-2 text-center">
          <BrandGlyph size={38} />
          <h1 className="text-xl font-semibold tracking-tight">Mail by Form*</h1>
          <p className="text-[12.5px] text-muted-foreground">Email that travels over Nostr</p>
        </div>

        {account!.method === 'ncryptsec' ? (
          <UnlockForm onUseAnother={() => setUseAnother(true)} />
        ) : (
          <ResumeFailed onUseAnother={() => setUseAnother(true)} />
        )}

        <p className="text-center text-[11px] leading-relaxed text-subtle">
          Your private key stays in your signer. This app never sees it.
        </p>
      </div>
    </div>
  )
}
