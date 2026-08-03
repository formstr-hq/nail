import { useThemeStore, resolveTheme } from '@/store/theme'
import { SunIcon, MoonIcon } from './icons'
import { IconButton } from './Button'

/**
 * Flips between light and dark.
 *
 * Toggling from `system` commits to the opposite of whatever the OS currently
 * shows, which is what someone reaching for this control is asking for. There
 * is no three-way cycle: `system` stays the default for anyone who never
 * touches it, and a control that lands on an invisible third state confuses
 * more than it offers.
 */
export function ThemeToggle() {
  const { preference, setPreference } = useThemeStore()
  const current = resolveTheme(preference)
  const next = current === 'dark' ? 'light' : 'dark'

  return (
    <IconButton
      title={`Switch to ${next} theme`}
      onClick={() => setPreference(next)}
    >
      {current === 'dark' ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
    </IconButton>
  )
}
