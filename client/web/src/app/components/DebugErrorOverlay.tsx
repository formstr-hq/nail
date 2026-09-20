import { Component, type ReactNode } from 'react'

/*
 * Error surface, two modes.
 *
 * Production: a React render crash would otherwise white-screen the app, so it
 * still renders a plain, non-technical "something went wrong" with Reload. No
 * stacks, no messages, no copy button — a shipped app does not expose internals
 * to its users.
 *
 * Development: the Android build has no devtools/logcat available to us, so a
 * crash on the phone needs to be readable off the screen. There, uncaught
 * errors, unhandled rejections and render errors are collected into a copyable
 * overlay with message + stack.
 */

interface CapturedError {
  message: string
  stack?: string
  source: string
}

/**
 * Browser noise that is not an app failure. `ResizeObserver loop completed with
 * undelivered notifications` is a benign, spec-sanctioned signal that an
 * observer's callback resized its own target. Capturing it as an error buried
 * the whole page behind the overlay and hid whatever real failure came before
 * it, so it is filtered at the capture boundary.
 */
export function isBenignError(message: string): boolean {
  return /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/.test(message)
}

let push: ((e: CapturedError) => void) | null = null

/**
 * Wire the global listeners once, before React renders. Dev-only: production
 * relies on the React boundary (a crash still gets the friendly screen), and
 * a global listener there would only capture into state nothing displays.
 */
export function installGlobalErrorCapture(): void {
  if (!import.meta.env.DEV) return
  window.addEventListener('error', (e) => {
    const err = e.error as Error | undefined
    const message = err?.message ?? e.message ?? 'Unknown error'
    if (isBenignError(message)) return
    push?.({ message, stack: err?.stack, source: 'error' })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined
    const message = r?.message ?? String(e.reason)
    if (isBenignError(message)) return
    push?.({ message, stack: r?.stack, source: 'unhandledrejection' })
  })
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { errors: CapturedError[]; reactCrashed: boolean }> {
  state = { errors: [] as CapturedError[], reactCrashed: false }

  /** Repeating errors must not grow the list without bound and lock up the UI. */
  private static readonly MAX_ERRORS = 20

  componentDidMount(): void {
    if (!import.meta.env.DEV) return
    push = (e) =>
      this.setState((s) => ({
        errors: [...s.errors, e].slice(-ErrorBoundary.MAX_ERRORS),
      }))
  }

  static getDerivedStateFromError(): { reactCrashed: boolean } {
    return { reactCrashed: true }
  }

  componentDidCatch(err: Error): void {
    this.setState((s) => ({
      errors: [...s.errors, { message: err.message, stack: err.stack, source: 'react' }].slice(
        -ErrorBoundary.MAX_ERRORS,
      ),
    }))
  }

  private copy = (): void => {
    const text = this.state.errors.map((e) => `[${e.source}] ${e.message}\n${e.stack ?? ''}`).join('\n\n')
    void navigator.clipboard?.writeText(text)
  }

  render(): ReactNode {
    const { errors, reactCrashed } = this.state

    // Production: only a React render crash takes over the screen (the tree is
    // already unmounted, so something has to render). A stray unhandled
    // rejection or window error is NOT allowed to replace a working page —
    // that is exactly how a benign notification once buried the whole app.
    // Failures are still surfaced where they matter, by the component that
    // owns them (banners, InboxStatus.error).
    if (!import.meta.env.DEV) {
      if (!reactCrashed) return this.props.children
      return (
        <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-background px-8 text-center">
          <p className="text-[15px] font-semibold text-foreground">Something went wrong</p>
          <p className="max-w-[36ch] text-[12.5px] leading-relaxed text-muted-foreground">
            The app hit an unexpected error. Reloading usually clears it — your mail is stored
            on your relays and is not lost.
          </p>
          <button
            type="button"
            onClick={() => location.reload()}
            className="rounded-md border border-input bg-card px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
          >
            Reload
          </button>
        </div>
      )
    }

    // No captured (non-benign) errors and no React crash: render normally.
    if (!reactCrashed && errors.length === 0) return this.props.children

    const overlay = (
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
    )

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
