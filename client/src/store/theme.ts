import { create } from 'zustand'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'mailstr.theme'

function readStored(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // Private browsing and blocked storage both throw here. A theme is not
    // worth failing a boot over — fall through to the OS preference.
  }
  return 'system'
}

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
 */
export function applyStoredTheme(): void {
  const preference = readStored()
  paint(preference)
  // Only `system` tracks the OS; an explicit choice stays put.
  systemQuery()?.addEventListener('change', () => {
    if (useThemeStore.getState().preference === 'system') paint('system')
  })
}

interface ThemeState {
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

export const useThemeStore = create<ThemeState>()((set) => ({
  preference: readStored(),
  setPreference: (preference) => {
    paint(preference)
    try {
      localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      // Storage refused it — the theme still applies for this session.
    }
    set({ preference })
  },
}))
