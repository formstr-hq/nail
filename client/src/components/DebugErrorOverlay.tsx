import { Component, type ReactNode } from 'react'

/*
 * On-device error surface. The Android build has no devtools/logcat available
 * to us, so instead of a silent white-screen or a swallowed rejection, any
 * uncaught error is shown here — message + stack, with a copy button — so it can
 * be read off the phone and reported. Catches three kinds:
 *   - React render errors (this boundary),
 *   - window 'error' events, and
 *   - unhandled promise rejections (where the NIP-55 plugin's async failures land).
 */

interface CapturedError {
  message: string
  stack?: string
  source: string
}

let push: ((e: CapturedError) => void) | null = null

/** Wire the global listeners once, before React renders. */
export function installGlobalErrorCapture(): void {
  window.addEventListener('error', (e) => {
    const err = e.error as Error | undefined
    push?.({ message: err?.message ?? e.message ?? 'Unknown error', stack: err?.stack, source: 'error' })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined
    push?.({ message: r?.message ?? String(e.reason), stack: r?.stack, source: 'unhandledrejection' })
  })
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { errors: CapturedError[]; reactCrashed: boolean }> {
  state = { errors: [] as CapturedError[], reactCrashed: false }

  componentDidMount(): void {
    push = (e) => this.setState((s) => ({ errors: [...s.errors, e] }))
  }

  static getDerivedStateFromError(): { reactCrashed: boolean } {
    return { reactCrashed: true }
  }

  componentDidCatch(err: Error): void {
    this.setState((s) => ({ errors: [...s.errors, { message: err.message, stack: err.stack, source: 'react' }] }))
  }

  private copy = (): void => {
    const text = this.state.errors.map((e) => `[${e.source}] ${e.message}\n${e.stack ?? ''}`).join('\n\n')
    void navigator.clipboard?.writeText(text)
  }

  render(): ReactNode {
    const { errors, reactCrashed } = this.state
    const overlay =
      errors.length > 0 ? (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            maxHeight: '55dvh',
            overflow: 'auto',
            zIndex: 2147483647,
            background: '#1a0d0d',
            color: '#ffd9d9',
            font: '11px/1.5 ui-monospace, Menlo, monospace',
            padding: '12px 12px calc(12px + env(safe-area-inset-bottom))',
            borderTop: '2px solid #b91c1c',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <strong style={{ color: '#fca5a5' }}>App error ({errors.length})</strong>
            <button onClick={this.copy} style={{ marginLeft: 'auto', color: '#fff', background: '#b91c1c', border: 0, borderRadius: 6, padding: '2px 10px' }}>
              Copy
            </button>
            <button onClick={() => location.reload()} style={{ color: '#fff', background: '#333', border: 0, borderRadius: 6, padding: '2px 10px' }}>
              Reload
            </button>
          </div>
          {errors.map((e, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ color: '#fca5a5' }}>[{e.source}] {e.message}</div>
              {e.stack && <div style={{ opacity: 0.75 }}>{e.stack}</div>}
            </div>
          ))}
        </div>
      ) : null

    // A React render crash unmounts the tree; show the errors as the whole page.
    if (reactCrashed) {
      return (
        <div style={{ minHeight: '100dvh', background: '#1a0d0d' }}>{overlay}</div>
      )
    }
    return (
      <>
        {this.props.children}
        {overlay}
      </>
    )
  }
}
