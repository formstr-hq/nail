import { useMailStore } from '@/store/mail'
import { useAccountStore } from '@/store/account'
import type { EmailFolder } from '@/types/mail'

const FOLDERS: { id: EmailFolder; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'sent', label: 'Sent' },
  { id: 'archive', label: 'Archive' },
  { id: 'spam', label: 'Spam' },
  { id: 'trash', label: 'Trash' },
]

interface SidebarProps {
  onCompose: () => void
  onSettings: () => void
}

export function Sidebar({ onCompose, onSettings }: SidebarProps) {
  const { folder, setFolder, emails } = useMailStore()
  const { account, logout } = useAccountStore()

  const unread = Object.values(emails).filter((e) => !e.read && !e.labels.includes('trash')).length

  return (
    <aside className="w-56 flex flex-col h-full border-r border-border bg-card">
      <div className="p-4 border-b border-border">
        <span className="font-semibold text-sm">Mail by Form*</span>
      </div>

      <div className="p-3">
        <button
          onClick={onCompose}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Compose
        </button>
      </div>

      <nav className="flex-1 px-2 space-y-0.5">
        {FOLDERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFolder(f.id)}
            className={`w-full flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
              folder === f.id
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-accent hover:text-accent-foreground'
            }`}
          >
            <span>{f.label}</span>
            {f.id === 'inbox' && unread > 0 && (
              <span className="text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">
                {unread}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="p-3 border-t border-border space-y-2">
        <div className="text-xs text-muted-foreground truncate">
          {account?.npub.slice(0, 20)}…
        </div>
        <div className="flex gap-2">
          <button
            onClick={onSettings}
            className="flex-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Settings
          </button>
          <button
            onClick={logout}
            className="flex-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  )
}
