import type { Contact } from '@/app/lib/mail/contacts'

export interface RecipientFieldProps {
  to: string
  toInputRef: React.RefObject<HTMLInputElement | null>
  onToChange: (value: string) => void
  onFocus: () => void
  onBlur: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  suggestions: Contact[]
  activeIndex: number
  onPickSuggestion: (address: string) => void
}

/** The To field with its contact autocomplete dropdown. */
export function RecipientField(props: RecipientFieldProps) {
  const {
    to,
    toInputRef,
    onToChange,
    onFocus,
    onBlur,
    onKeyDown,
    suggestions,
    activeIndex,
    onPickSuggestion,
  } = props
  const showSuggestions = suggestions.length > 0
  return (
    <div className="relative">
      <label className="flex items-center gap-2 px-3.5">
        {/* Wide enough for the longest label, so both inputs share one gutter. */}
        <span className="eyebrow w-16 flex-none">To</span>
        <input
          ref={toInputRef}
          value={to}
          onChange={(e) => onToChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          placeholder="npub, name@domain, or an email address"
          autoComplete="off"
          role="combobox"
          aria-expanded={showSuggestions}
          aria-autocomplete="list"
          className="h-9 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-subtle focus:outline-none"
        />
      </label>
      {showSuggestions && (
        <ul className="absolute left-2 right-2 top-full z-20 max-h-56 overflow-y-auto rounded-md border border-border bg-card py-1 shadow-lg">
          {suggestions.map((c, i) => (
            <li key={c.key}>
              <button
                type="button"
                // Keep focus on the input so onBlur doesn't fire before this click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPickSuggestion(c.address)}
                className={[
                  'flex w-full items-baseline gap-2 px-3 py-1.5 text-left',
                  i === activeIndex ? 'bg-accent' : 'hover:bg-accent/60',
                ].join(' ')}
              >
                {c.name && (
                  <span className="flex-none text-[12.5px] font-medium text-foreground">
                    {c.name}
                  </span>
                )}
                <span className="truncate font-mono text-[11px] text-subtle">{c.address}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The Subject line. */
export function SubjectField({
  subject,
  onChange,
}: {
  subject: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex items-center gap-2 px-3.5">
      {/* Wide enough for the longest label, so both inputs share one gutter. */}
      <span className="eyebrow w-16 flex-none">Subject</span>
      <input
        value={subject}
        onChange={(e) => onChange(e.target.value)}
        placeholder="What is this about?"
        className="h-9 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-subtle focus:outline-none"
      />
    </label>
  )
}