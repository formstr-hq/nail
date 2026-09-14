import { Button, IconButton } from '@/app/components/ui/Button'
import { XIcon, MinimizeIcon, ExpandIcon } from '@/app/components/ui/icons'

/** The docked-pill form the composer takes when minimized on desktop. */
export function ComposerMinimized({
  subject,
  onRestore,
}: {
  subject: string
  onRestore: () => void
}) {
  return (
    <div className="fixed bottom-0 right-4 z-50 md:right-6">
      <button
        type="button"
        onClick={onRestore}
        className="flex w-64 items-center gap-2 rounded-t-lg border border-b-0 border-border bg-card px-3 py-2 text-left shadow-lg transition-colors hover:bg-accent"
      >
        <span className="flex-1 truncate text-[12.5px] font-medium text-foreground">
          {subject.trim() || 'New message'}
        </span>
        <ExpandIcon className="h-3.5 w-3.5 flex-none text-muted-foreground" />
      </button>
    </div>
  )
}

/** Title bar: reply/new label plus minimize and close. */
export function ComposerHeader({
  isReply,
  onMinimize,
  onClose,
}: {
  isReply: boolean
  onMinimize: () => void
  onClose: () => void
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-3 py-2">
      <span className="eyebrow flex-1">{isReply ? 'Reply' : 'New message'}</span>
      <IconButton title="Minimize" onClick={onMinimize}>
        <MinimizeIcon className="h-4 w-4" />
      </IconButton>
      <IconButton title="Close" onClick={onClose}>
        <XIcon className="h-4 w-4" />
      </IconButton>
    </div>
  )
}

/** Inline confirmation shown before a dirty draft is discarded. Escape never
 *  lands here (the window handler backs out of it first). */
export function DiscardBanner({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void
  onDiscard: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-accent px-3 py-2">
      <p className="flex-1 text-[12px] text-foreground">Discard this draft?</p>
      <Button size="sm" onClick={onKeep}>
        Keep writing
      </Button>
      <Button size="sm" variant="danger" onClick={onDiscard}>
        Discard
      </Button>
    </div>
  )
}