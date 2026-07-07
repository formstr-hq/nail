import { useState } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { sendMail } from '@/lib/mail/send'
import { BRIDGE_DOMAIN } from '@/lib/nostr/constants'

interface ComposeModalProps {
  onClose: () => void
  replyTo?: { to: string; subject: string; messageId?: string; references?: string[] }
}

export function ComposeModal({ onClose, replyTo }: ComposeModalProps) {
  const { account } = useAccountStore()
  const { settings } = useSettingsStore()
  const [to, setTo] = useState(replyTo?.to ?? '')
  const [subject, setSubject] = useState(replyTo ? `Re: ${replyTo.subject}` : '')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const defaultAddress = account ? `${account.npub}@${BRIDGE_DOMAIN}` : ''
  const fromAddress = settings.senderAddress || defaultAddress

  async function handleSend() {
    if (!account || !to.trim() || !subject.trim()) return
    setSending(true)
    setError('')
    try {
      await sendMail({
        from: { address: fromAddress },
        senderPubkey: account.pubkey,
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        subject,
        body,
        inReplyTo: replyTo?.messageId,
        references: replyTo?.references,
      })
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-6 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-lg rounded-lg border border-border bg-card shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-medium">New Message</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">&times;</button>
        </div>

        <div className="flex flex-col divide-y divide-border">
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="To (npub, NIP-05, or email)"
            className="px-4 py-2 text-sm bg-transparent focus:outline-none"
          />
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="px-4 py-2 text-sm bg-transparent focus:outline-none"
          />
        </div>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your message…"
          rows={10}
          className="flex-1 px-4 py-3 text-sm bg-transparent focus:outline-none resize-none"
        />

        {error && <p className="px-4 py-2 text-xs text-destructive">{error}</p>}

        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <span className="text-xs text-muted-foreground truncate">From: {fromAddress}</span>
          <button
            onClick={handleSend}
            disabled={sending || !to.trim() || !subject.trim()}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
