/** Same labelled-block shape the other settings sections use. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="eyebrow">{label}</div>
      {hint && <p className="text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}