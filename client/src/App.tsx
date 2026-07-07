import { useState, useEffect } from 'react'
import { useAccountStore } from '@/store/account'
import { useSettingsStore } from '@/store/settings'
import { signerFromAccount } from '@/lib/nostr/signer'
import { useInbox } from '@/hooks/useInbox'
import { LoginPage } from '@/components/LoginPage'
import { Sidebar } from '@/components/Sidebar'
import { EmailList } from '@/components/EmailList'
import { EmailView } from '@/components/EmailView'
import { ComposeModal } from '@/components/ComposeModal'
import { SettingsModal } from '@/components/SettingsModal'

function MailApp() {
  const [composing, setComposing] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const { account, sk } = useAccountStore()
  const { load } = useSettingsStore()
  useInbox()

  useEffect(() => {
    if (!account) return
    const signer = signerFromAccount(account.method, sk)
    load(account.pubkey, signer, sk).catch(console.error)
  }, [account, sk, load])

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
  const account = useAccountStore((s) => s.account)
  return account ? <MailApp /> : <LoginPage />
}
