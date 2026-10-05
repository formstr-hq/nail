import { XIcon } from '@/app/components/ui/icons'

/**
 * A transient confirmation strip ("snackbar"). Used for events whose outcome
 * the user should notice — domain added, verified, removed — but which do not
 * change what is on screen enough to be self-evident.
 *
 * Deliberately not used for the setup steps: those are persistent state (what
 * is done, what is left), and a message that disappears after a few seconds
 * cannot carry that. A snackbar is for *events*, not for status.
 */
export function Snackbar({
  message,
  action,
  onAction,
  onDismiss,
}: {
  message: string
  action?: string
  onAction?: () => void
  onDismiss: () => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-4"
    >
      <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border border-border bg-foreground px-3.5 py-2.5 text-background shadow-2xl">
        <span className="min-w-0 flex-1 text-[12.5px] leading-snug">{message}</span>
        {action && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="flex-none text-[12px] font-semibold text-background/90 underline underline-offset-2 hover:text-background"
          >
            {action}
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex-none text-background/70 hover:text-background"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

/** Convenience type for the `onToast` callback threaded through the page. */
export type Toast = (message: string, opts?: { action?: string; onAction?: () => void }) => void
