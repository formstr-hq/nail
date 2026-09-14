import { Loader2 } from 'lucide-react'

/** Step 1.5 — checking whether this account already owns a mailbox. */
export function ResolvingStep() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <span className="relative flex h-10 w-10 items-center justify-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/20" />
        <Loader2 size={24} className="animate-spin text-primary" />
      </span>
      <p className="text-sm text-gray-500">Checking your account…</p>
    </div>
  )
}
