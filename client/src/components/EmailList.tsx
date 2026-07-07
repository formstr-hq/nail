import { useMailStore } from '@/store/mail'
import type { Email } from '@/types/mail'

function formatDate(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function EmailRow({ email, selected }: { email: Email; selected: boolean }) {
  const setSelected = useMailStore((s) => s.setSelected)
  const markRead = useMailStore((s) => s.markRead)

  function handleClick() {
    setSelected(email.id)
    markRead(email.id)
  }

  return (
    <button
      onClick={handleClick}
      className={`w-full text-left px-4 py-3 border-b border-border transition-colors ${
        selected ? 'bg-accent' : 'hover:bg-muted'
      } ${!email.read ? 'font-medium' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm truncate">
          {email.from.name || email.from.address}
        </span>
        <span className="text-xs text-muted-foreground shrink-0">
          {formatDate(email.timestamp)}
        </span>
      </div>
      <div className="text-sm truncate text-muted-foreground">{email.subject}</div>
      <div className="text-xs truncate text-muted-foreground mt-0.5">
        {email.body.slice(0, 80)}
      </div>
    </button>
  )
}

export function EmailList() {
  const { emails, folder, selectedId } = useMailStore()

  const filtered = Object.values(emails)
    .filter((e) => {
      if (folder === 'trash') return e.labels.includes('trash')
      if (folder === 'archive') return e.labels.includes('archive')
      if (folder === 'spam') return e.labels.includes('spam')
      if (folder === 'sent') {
        // Emails where we are the sender (self-copy in Sent)
        return !e.labels.some((l) => ['trash', 'archive', 'spam'].includes(l))
      }
      return !e.labels.some((l) => ['trash', 'archive', 'spam'].includes(l))
    })
    .sort((a, b) => b.timestamp - a.timestamp)

  if (!filtered.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No messages
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {filtered.map((email) => (
        <EmailRow key={email.id} email={email} selected={selectedId === email.id} />
      ))}
    </div>
  )
}
