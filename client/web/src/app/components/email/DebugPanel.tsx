import { useState } from 'react'
import { useDevStore } from '@/app/store/dev'
import type { Email, SenderProof } from '@/app/types/mail'

/**
 * A collapsed disclosure showing the raw decoded rumor — the ground truth for
 * "why does this message look like this?". Kind, sealing key, tags and the
 * exact content as it arrived, before any RFC 2822 interpretation. Collapsed by
 * default so it never intrudes on normal reading.
 *
 * Dev-only: it exposes raw event internals, which a shipped app has no reason
 * to render (the store's opt-in survives upgrades, so this checks the build
 * target rather than only the preference).
 *
 * `proof` is passed in rather than read off the email: it is derived at render
 * time (useSenderIdentity) and never stored, so the debug view reports the
 * verdict actually shown to the reader alongside the raw facts.
 */
export function DebugPanel({ email, proof }: { email: Email; proof: SenderProof }) {
  const debugPanel = useDevStore((s) => s.debugPanel)
  const [copied, setCopied] = useState(false)
  if (!import.meta.env.DEV || !debugPanel) return null
  const debug = email.debug!
  const json = JSON.stringify(
    { ...debug, senderProof: proof, giftWrapId: email.id },
    null,
    2,
  )

  async function copy() {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard blocked (insecure origin / permission) — the JSON is still
      // on screen to select by hand, so there is nothing to recover here.
    }
  }

  return (
    <details className="mt-8 rounded-md border border-border bg-background/40">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-subtle">
        Debug · rumor event
        <span className="font-sans lowercase tracking-normal text-muted-foreground">
          kind {debug.rumor.kind} · proof {proof}
        </span>
      </summary>
      <div className="border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={copy}
          className="mb-2 rounded border border-input bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? 'Copied' : 'Copy JSON'}
        </button>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-muted-foreground">
          {json}
        </pre>
      </div>
    </details>
  )
}
