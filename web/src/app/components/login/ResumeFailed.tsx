import { Button } from '@/app/components/ui/Button'

/** Locked non-ncryptsec session that couldn't silently resume. */
export function ResumeFailed({ onUseAnother }: { onUseAnother: () => void }) {
  return (
    <div className="flex flex-col gap-3 text-center">
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Your signer didn't answer, so this session couldn't be resumed. Signing in again will
        reconnect it.
      </p>
      <Button variant="primary" onClick={onUseAnother} className="w-full">
        Sign in again
      </Button>
    </div>
  )
}
