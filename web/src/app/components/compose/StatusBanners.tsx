import { Button } from '@/app/components/ui/Button'
import { AlertIcon, LockIcon } from '@/app/components/ui/icons'

/** Send failure. Body copy stays in `text-foreground`, not `text-destructive`:
 *  a muted red on the dark banner is too low-contrast to read (the very bug
 *  that prompted this). Red is carried by the icon alone, which is enough to
 *  read as an error. When the failure is the bridge-sender bounce, the same
 *  switch/buy CTA the pre-send guard uses is attached so the message is
 *  actionable, not just a wall of text. */
export function ErrorBanner({ error, fix }: { error: string; fix?: React.ReactNode }) {
  return (
    <div className="border-t border-border bg-destructive/10 px-3.5 py-2.5">
      <div className="flex items-start gap-2">
        <AlertIcon className="mt-0.5 h-3.5 w-3.5 flex-none text-destructive" />
        <p className="text-[11.5px] leading-relaxed text-foreground">{error}</p>
      </div>
      {fix && <div className="mt-2 pl-[1.375rem]">{fix}</div>}
    </div>
  )
}

/** Pre-send guard: an npub From cannot reach recipients the bridge delivers. */
export function NpubGuardBanner({ fix }: { fix: React.ReactNode }) {
  return (
    <div className="border-t border-border bg-accent px-3.5 py-2.5">
      <div className="flex items-start gap-2">
        <AlertIcon className="mt-0.5 h-3.5 w-3.5 flex-none text-muted-foreground" />
        <p className="text-[11.5px] leading-relaxed text-foreground">
          External email addresses are delivered through the bridge, which only accepts
          registered alias senders — your npub can’t reach them. (Your npub still works fine
          for any recipient reached directly over Nostr: npubs and NIP-05 names.)
        </p>
      </div>
      <div className="mt-2 pl-[1.375rem]">{fix}</div>
    </div>
  )
}

/** "Looking for encryption keys…" while discovery is in flight. */
export function DiscoveryBanner() {
  return (
    <div className="flex items-start gap-2 border-t border-border bg-background/60 px-3.5 py-2">
      <LockIcon className="mt-px h-3.5 w-3.5 flex-none text-subtle" />
      <p className="text-[11.5px] leading-relaxed text-subtle">
        Looking for encryption keys for your recipients…
      </p>
    </div>
  )
}

/** The outbound bridge failed to resolve: legacy/external recipients cannot be
 *  delivered this session. Shown proactively (not only on a failed send) so the
 *  failure is visible while composing, not after hitting Send (audit D4). */
export function BridgeUnavailableBanner({ message }: { message: string }) {
  return (
    <div className="border-t border-border bg-destructive/10 px-3.5 py-2.5">
      <div className="flex items-start gap-2">
        <AlertIcon className="mt-0.5 h-3.5 w-3.5 flex-none text-destructive" />
        <p className="text-[11.5px] leading-relaxed text-foreground">
          {message} Recipients on mailstr-hosted addresses still work over Nostr.
        </p>
      </div>
    </div>
  )
}

/** Encryption status line: fully encrypted or mixed delivery. */
export function EncryptedBanner({
  mixed,
  encryptedCount,
  missingKeys,
}: {
  mixed: boolean
  encryptedCount: number
  missingKeys: string[]
}) {
  return (
    <div className="flex items-start gap-2 border-t border-border bg-background/60 px-3.5 py-2">
      <LockIcon className="mt-px h-3.5 w-3.5 flex-none text-muted-foreground" />
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        {mixed
          ? `Encrypted for ${encryptedCount} recipient${encryptedCount === 1 ? '' : 's'}; ${missingKeys.join(', ')} receive plaintext.`
          : 'Encrypted with PGP. The subject line is not encrypted.'}
      </p>
    </div>
  )
}

/** The alias fix shared by the pre-send npub guard and the send-time bounce
 *  banner: switch to an alias you already own, or open the in-app buy flow. */
export function AliasFix({
  alias,
  onSwitch,
  onBuyAddress,
}: {
  alias?: string
  onSwitch: () => void
  onBuyAddress: () => void
}) {
  if (!alias) {
    return (
      <Button size="sm" onClick={onBuyAddress}>
        Get an alias →
      </Button>
    )
  }
  return (
    <Button size="sm" onClick={onSwitch} className="min-w-0 max-w-full">
      <span className="truncate">Send from {alias}</span>
    </Button>
  )
}