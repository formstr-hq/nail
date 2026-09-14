import type { ThemePreference } from '@/app/store/theme'
import { Field } from '@/app/components/settings/Field'

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

export function AppearanceSection({
  preference,
  onThemeChange,
  debugPanel,
  onDebugPanelChange,
}: {
  preference: ThemePreference
  onThemeChange: (t: ThemePreference) => void
  debugPanel: boolean
  onDebugPanelChange: (on: boolean) => void
}) {
  return (
    <>
      <Field label="Theme">
        <div
          role="radiogroup"
          aria-label="Theme"
          className="flex gap-1 rounded-md border border-input bg-background p-1"
        >
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={preference === t.id}
              onClick={() => onThemeChange(t.id)}
              className={[
                'flex-1 rounded-sm px-2 py-1.5 text-[12px] font-medium transition-colors duration-[120ms]',
                preference === t.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Developer mode"
        hint="Adds a debug panel under each message showing its raw decoded event — kind, sender key, tags and content. This device only."
      >
        <div
          role="radiogroup"
          aria-label="Developer mode"
          className="flex gap-1 rounded-md border border-input bg-background p-1"
        >
          {[
            { on: true, label: 'On' },
            { on: false, label: 'Off' },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={debugPanel === o.on}
              onClick={() => onDebugPanelChange(o.on)}
              className={[
                'flex-1 rounded-sm px-2 py-1.5 text-[12px] font-medium transition-colors duration-[120ms]',
                debugPanel === o.on
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Field>
    </>
  )
}