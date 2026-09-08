import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type ThemePreference = 'light' | 'dark' | 'system'

const systemQuery = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

/** The theme actually painted, once `system` has been resolved. */
export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference
  return systemQuery()?.matches ? 'dark' : 'light'
}

function paint(preference: ThemePreference): void {
  const root = document.documentElement
  root.classList.toggle('dark', resolveTheme(preference) === 'dark')
  // Native form controls and scrollbars read this, not the class.
  root.style.colorScheme = resolveTheme(preference)
}

/**
 * Applied before React mounts so the first paint is already the right theme —
 * mounting first would flash the light palette at anyone who chose dark.
 *
 * Reads the same raw `mailstr.theme` value the persist middleware reads below,
 * so the store's hydration and this pre-paint never disagree.
 */
export function applyStoredTheme(): void {
  try {
    const raw = localStorage.getItem('mailstr.theme')
    // New format (persist middleware JSON envelope) or the legacy bare value.
    if (raw === 'light' || raw === 'dark' || raw === 'system') paint(raw)
    else if (raw) {
      const parsed = JSON.parse(raw) as { state?: { preference?: ThemePreference } }
      if (parsed?.state?.preference) paint(parsed.state.preference)
    }
  } catch {
    // Private browsing and blocked storage both throw here. A theme is not
    // worth failing a boot over — fall through to the OS preference.
    paint('system')
  }
  // Only `system` tracks the OS; an explicit choice stays put.
  systemQuery()?.addEventListener('change', () => {
    if (useThemeStore.getState().preference === 'system') paint('system')
  })
}

interface ThemeState {
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      preference: 'system',
      setPreference: (preference) => {
        paint(preference)
        set({ preference })
      },
    }),
    {
      name: 'mailstr.theme',
      storage: createJSONStorage(() => localStorage),
      // The OS listener reads the store directly; painting happens in
      // setPreference, so nothing extra needs persisting.
    },
  ),
)