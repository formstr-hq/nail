import { useCallback, useEffect, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { Button } from '@/app/components/ui/Button'
import { AlertIcon, BackIcon, InboxIcon } from '@/app/components/ui/icons'
import { Field } from '@/app/components/settings/Field'
import { fetchMyDomains, registerDomain, removeDomain, type WorkspaceDomain } from '@/app/lib/api/workspace'
import { Nip98AuthError } from '@/app/lib/api/addresses'
import { DomainDetail } from './DomainDetail'
import { DomainsPanel } from './DomainsPanel'
import { VerifyStatus } from './presenters'
import { Snackbar, type Toast } from './Snackbar'

/**
 * The Workspace page: run your own mail domain on this bridge.
 *
 * A top-level route (`/mails/workspace`), not a Settings pane — it is a
 * multi-step flow, so it needs the room. It is a master/detail layout: domain
 * management on the left, one domain's workspace on the right, and the workspace
 * itself split into tabs (Setup / Participants / Billing) so DNS records, member
 * management and billing are not stacked on one screen.
 *
 * Verification state is fetched from the server rather than inferred (only the
 * server resolves DNS), and DNS records are shown exactly as the API returns
 * them so the UI cannot drift from the verifier.
 */
export function WorkspacePage({ onBack }: { onBack: () => void }) {
  const { account, active } = useAccountStore()
  const [domains, setDomains] = useState<WorkspaceDomain[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; action?: string; onAction?: () => void } | null>(
    null,
  )

  const notify = useCallback<Toast>((message, opts) => {
    setToast({ message, action: opts?.action, onAction: opts?.onAction })
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const load = useCallback(async () => {
    if (!active) return
    setLoading(true)
    setError(null)
    try {
      const list = await fetchMyDomains(active)
      setDomains(list)
      setSelected((current) =>
        current && list.some((d) => d.domain === current)
          ? current
          : (list[0]?.domain ?? null),
      )
    } catch (e) {
      setError(
        e instanceof Nip98AuthError
          ? 'Session rejected — sign in again'
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally {
      setLoading(false)
    }
  }, [active])

  useEffect(() => {
    // Deferred a microtask — a synchronous setState in an effect body causes
    // cascading renders (the codebase's useOwnedAddresses does the same).
    let alive = true
    queueMicrotask(() => {
      if (alive) void load()
    })
    return () => {
      alive = false
    }
  }, [load])

  const current = domains.find((d) => d.domain === selected) ?? null

  const handleAdded = useCallback(
    async (domain: string) => {
      if (!active) return
      await registerDomain(active, domain)
      notify(`${domain} added — publish its DNS record, then verify.`)
      await load()
    },
    [active, notify, load],
  )

  const handleDelete = useCallback(
    async (d: WorkspaceDomain) => {
      if (!active) return
      // An active domain takes its addresses offline, so make that explicit. A
      // pending claim routes nothing and needs no ceremony. The server is the
      // real guard: it refuses while any address is assigned.
      if (d.status === 'active') {
        const ok = window.confirm(
          `Delete ${d.domain}? This stops mail for the domain. It must have no assigned addresses.`,
        )
        if (!ok) return
      }
      try {
        await removeDomain(active, d.domain)
        notify(
          d.status === 'active' ? `${d.domain} removed` : `Pending domain ${d.domain} removed`,
        )
        if (selected === d.domain) setSelected(null)
        await load()
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e))
      }
    },
    [active, notify, load, selected],
  )

  return (
    <div className="mail-app safe-y flex h-[100dvh] flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border px-3 py-3 md:px-6">
        <Button size="sm" variant="ghost" onClick={onBack} className="flex-none">
          <BackIcon className="h-4 w-4" /> Back to mail
        </Button>
        <div className="min-w-0 flex-1">
          <div className="eyebrow">Settings</div>
          <h1 className="text-base font-semibold tracking-tight">Workspace</h1>
        </div>
        {current && (
          <VerifyStatus status={current.status} verifiedAt={current.verified_at ?? null} />
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!active || !account ? (
          <div className="mx-auto max-w-2xl px-4 py-5 md:px-6">
            <Field label="Workspace">
              <p className="text-[11.5px] text-subtle">Sign in to manage a mail domain.</p>
            </Field>
          </div>
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-5 md:flex-row md:px-6">
            <aside className="md:w-72 md:flex-none">
              <DomainsPanel
                domains={domains}
                selected={selected}
                loading={loading}
                onSelect={setSelected}
                onAdded={handleAdded}
                onDelete={(d) => void handleDelete(d)}
              />
            </aside>

            <section className="min-w-0 flex-1">
              {error ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
                  <AlertIcon className="mt-px h-3.5 w-3.5 flex-none text-destructive" />
                  <p className="flex-1 text-[11.5px] leading-relaxed text-destructive">{error}</p>
                  <Button size="sm" onClick={() => void load()} className="flex-none">
                    Try again
                  </Button>
                </div>
              ) : current ? (
                <DomainDetail
                  key={current.domain}
                  active={active}
                  domain={current}
                  ownPubkey={account.pubkey}
                  notify={notify}
                  onChanged={load}
                />
              ) : (
                <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input p-8 text-center">
                  <InboxIcon className="h-6 w-6 text-subtle" />
                  <p className="text-[12.5px] text-muted-foreground">
                    {domains.length === 0
                      ? 'Add a domain to get started.'
                      : 'Select a domain to manage it.'}
                  </p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {toast && (
        <Snackbar
          message={toast.message}
          action={toast.action}
          onAction={toast.onAction}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  )
}
