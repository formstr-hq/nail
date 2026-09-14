import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'

/**
 * Destructive actions without a modal: the first click arms the button, the
 * second fires. The armed state reverts after a few seconds (and on blur), so
 * a forgotten half-confirm never sits live. Label text changes are the
 * confirmation copy — no dialog, no layout shift.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  title,
  size = 'md',
  className = '',
  children,
}: {
  label: string
  confirmLabel: string
  onConfirm: () => void
  disabled?: boolean
  title?: string
  size?: 'sm' | 'md'
  className?: string
  children?: React.ReactNode
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const disarm = () => setArmed(false)

  return (
    <Button
      variant="danger"
      size={size}
      disabled={disabled}
      title={title ?? label}
      aria-label={armed ? confirmLabel : label}
      className={[
        armed ? 'border-destructive bg-destructive/10 font-semibold' : '',
        className,
      ].join(' ')}
      onBlur={disarm}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          timer.current = setTimeout(disarm, 4000)
          return
        }
        if (timer.current) clearTimeout(timer.current)
        setArmed(false)
        onConfirm()
      }}
    >
      {children}
      {/* The label always shows (unlike the navigation buttons that collapse
          to icons on narrow screens): for a destructive action, the text IS
          the confirmation, so hiding it on mobile would hide the armed state. */}
      <span>{armed ? confirmLabel : label}</span>
    </Button>
  )
}
