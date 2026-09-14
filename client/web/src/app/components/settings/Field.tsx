/** A labelled block with a one-line explanation. Used for every setting. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="eyebrow">{label}</div>
      {hint && (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
      {children}
    </div>
  )
}

export const inputClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-[13px] text-foreground placeholder:text-subtle focus:outline-none'