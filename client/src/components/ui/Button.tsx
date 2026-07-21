import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-foreground border-primary hover:bg-primary/90 disabled:hover:bg-primary',
  secondary: 'bg-card text-foreground border-input hover:bg-accent disabled:hover:bg-card',
  ghost: 'bg-transparent text-muted-foreground border-transparent hover:bg-accent hover:text-foreground',
  danger: 'bg-transparent text-destructive border-transparent hover:bg-destructive/10',
}

const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-[13px] gap-2',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        'inline-flex items-center justify-center whitespace-nowrap rounded-md border font-medium',
        // 120ms is under the threshold where a click feels laggy but still
        // reads as a transition rather than a jump.
        'transition-colors duration-[120ms]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        className,
      ].join(' ')}
      {...props}
    />
  )
}

/** Square icon-only button. `title` is required — it is the accessible name. */
export function IconButton({
  title,
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button
      type={type}
      title={title}
      aria-label={title}
      className={[
        'inline-flex h-7 w-7 flex-none items-center justify-center rounded-md',
        'text-muted-foreground transition-colors duration-[120ms]',
        'hover:bg-accent hover:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      ].join(' ')}
      {...props}
    />
  )
}
