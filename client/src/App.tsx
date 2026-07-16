import { useState, useEffect } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { useInbox } from '@/hooks/useInbox'
import { useLocalRelayLifecycle } from '@/hooks/useLocalRelayLifecycle'
import { LoginPage } from '@/components/LoginPage'
import { Sidebar } from '@/components/Sidebar'
import { EmailList } from '@/components/EmailList'
import { EmailView } from '@/components/EmailView'
import { ComposeModal } from '@/components/ComposeModal'
import { SettingsModal } from '@/components/SettingsModal'

function MailApp() {
  const [composing, setComposing] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const { account, active } = useAccountStore()
  const { load } = useSettingsStore()
  useInbox()

  useEffect(() => {
    if (!account || !active) return
    load(account.pubkey, active).catch(console.error)
  }, [account, active, load])

  return (
    <div className="flex h-screen bg-background">
      <Sidebar onCompose={() => setComposing(true)} onSettings={() => setShowSettings(true)} />
      <div className="flex flex-1 overflow-hidden">
        <div className="w-80 flex flex-col border-r border-border overflow-hidden">
          <EmailList />
        </div>
        <EmailView />
      </div>
      {composing && <ComposeModal onClose={() => setComposing(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}

export default function App() {
  const { account, active, ready, init } = useAccountStore()
  // Lives in App (not MailApp) so logout tears down via effect deps rather
  // than relying on unmount ordering.
  useLocalRelayLifecycle()

  useEffect(() => {
    void init()
  }, [init])

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  return account && active ? <MailApp /> : <LoginPage />
}
