import type { ReactNode } from 'react'

/**
 * Shared modal overlay shell. Every overlay in the app repeats the same
 * `fixed inset-0` + backdrop + z-index + mobile-safe-area pattern; centralizing
 * it here is AGENTS rule 9 (styling patterns repeated 3+ times get hoisted) and
 * makes stacking deliberate rather than a per-component `z-` guess.
 *
 * `dismiss` (click on the backdrop) is opt-in: some flows must not be dismissed
 * by a stray tap. Children are wrapped so clicks inside never bubble to the
 * backdrop.
 */
const Z: Record<'drawer' | 'modal' | 'dialog' | 'critical', string> = {
  drawer: 'z-40',
  modal: 'z-50',
  dialog: 'z-[60]',
  critical: 'z-[70]',
}

export function Overlay({
  children,
  dismiss,
  height = 'modal',
  align = 'center',
  safe,
  className = '',
}: {
  children: ReactNode
  /** Called when the backdrop is clicked. Omit for a non-dismissable overlay. */
  dismiss?: () => void
  /** Stacking tier, named instead of ad-hoc z-indexes. */
  height?: keyof typeof Z
  /** Vertical anchoring: bottom sheets on phones, centred on desktop. */
  align?: 'center' | 'bottom-sheet'
  /** Apply the safe-area classes (native app edge-to-edge). */
  safe?: 'modal' | 'bottom'
  className?: string
}) {
  const alignClass =
    align === 'bottom-sheet'
      ? 'items-end justify-center p-0 md:items-center md:p-6'
      : 'items-center justify-center p-4'
  const safeClass = safe === 'modal' ? 'safe-modal' : safe === 'bottom' ? 'safe-bottom' : ''

  return (
    <div
      className={[
        'fixed inset-0 flex bg-foreground/30',
        Z[height],
        alignClass,
        safeClass,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseDown={(e) => {
        if (dismiss && e.target === e.currentTarget) dismiss()
      }}
    >
      {children}
    </div>
  )
}
