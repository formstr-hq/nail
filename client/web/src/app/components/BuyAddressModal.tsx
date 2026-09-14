import { Suspense, lazy } from 'react'
import { useAccountStore } from '@/app/store/account'
import { Button } from '@/app/components/ui/Button'

/**
 * The landing's SignupWizard is heavy (signer + QR + invoice libs). This
 * container only mounts when the user opens the buy flow, so it stays out of
 * the app's initial bundle — the landing already code-splits it the same way.
 */
const SignupWizard = lazy(() => import('@/components/SignupWizard'))

/**
 * In-app "buy a new address" — the landing's purchase wizard embedded over
 * the mail client instead of a new-tab deep link to `/`.
 *
 * Why this can reuse SignupWizard unchanged: it's one app since the merge,
 * so `@/lib/signer` and `@/lib/api` are the very instances the client is
 * signed in with — a logged-in user steps straight into address selection.
 * What's adapted:
 *
 *  - `.landing` wraps it to pin the landing's fixed light palette — the
 *    wizard styles itself with `bg-primary text-white` and hardcoded greys
 *    (gray-500, emerald-600, red-600), which under the app's dark theme would
 *    invert to unreadable white-on-white. Inside `.landing`, `primary` is
 *    ink-on-white regardless of `<html class="dark">`. See the .landing block
 *    in index.css.
 *  - `skipLogin` starts at address selection (no login UI flash) and
 *    `onComplete` hands control back instead of the inbox redirect.
 *
 * The wizard renders its own full-screen modal (backdrop, header, close X),
 * so this host adds no chrome of its own.
 */
export function BuyAddressModal({
  onClose,
  onComplete,
}: {
  onClose: () => void
  onComplete: () => void
}) {
  const account = useAccountStore((s) => s.account)

  return (
    // A plain div: the wizard renders its own full-screen modal (backdrop,
    // header, close X) — this host only scopes the landing palette, so a
    // dialog role here would be an empty, zero-size box.
    <div className="landing">
      {account ? (
        <Suspense fallback={null}>
          <SignupWizard
            purchaseMode
            skipLogin
            initialPubkey={account.pubkey}
            onClose={onClose}
            onComplete={onComplete}
          />
        </Suspense>
      ) : (
        // MailApp only mounts with a live session, so this is a safety net —
        // but a dead signer mid-session must fail with a message, not a dead
        // wizard that errors on the first signature.
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 text-center shadow-2xl">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Your signer session is locked, so the purchase can't be signed.
              Sign in again to continue.
            </p>
            <Button variant="primary" onClick={onClose} className="mt-4 w-full">
              Back
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}