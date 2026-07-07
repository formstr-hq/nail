import { useState } from 'react'
import { useAccountStore } from '@/store/account'

export function LoginPage() {
  const { login, generateAndLogin } = useAccountStore()
  const [nsec, setNsec] = useState('')
  const [error, setError] = useState('')
  const hasNip07 = typeof window !== 'undefined' && !!window.nostr

  async function handleNip07() {
    try {
      await login('nip07')
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleNsec() {
    try {
      await login('nsec', nsec)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 p-8">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Mail by Form*</h1>
          <p className="text-sm text-muted-foreground">Nostr-native email</p>
        </div>

        <div className="space-y-3">
          {hasNip07 && (
            <button
              onClick={handleNip07}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Sign in with Extension (NIP-07)
            </button>
          )}

          <div className="space-y-2">
            <input
              type="password"
              placeholder="nsec1..."
              value={nsec}
              onChange={(e) => setNsec(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              onClick={handleNsec}
              disabled={!nsec}
              className="w-full rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
            >
              Sign in with nsec
            </button>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-background px-2 text-muted-foreground">or</span>
            </div>
          </div>

          <button
            onClick={generateAndLogin}
            className="w-full rounded-md border border-input px-4 py-2 text-sm hover:bg-accent transition-colors"
          >
            Generate new key
          </button>
        </div>

        {error && <p className="text-sm text-destructive text-center">{error}</p>}

        <p className="text-xs text-center text-muted-foreground">
          Your private key never leaves this device.
        </p>
      </div>
    </div>
  )
}
