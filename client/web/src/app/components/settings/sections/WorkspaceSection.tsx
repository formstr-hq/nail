import { Button } from '@/app/components/ui/Button'
import { ChevronRightIcon } from '@/app/components/ui/icons'
import { Field } from '@/app/components/settings/Field'
import type { ActiveSigner } from '@formstr/signer'

/**
 * Settings launcher for the Workspace setup.
 *
 * Workspace is a multi-step flow (add → DNS → verify → addresses) and lives on
 * its own page, not inside this modal — the modal is built for single-pane
 * tweaks. This entry only points at it.
 */
export function WorkspaceSection({
  active,
  onOpen,
}: {
  active: ActiveSigner | null
  onOpen: () => void
}) {
  if (!active) {
    return (
      <Field label="Workspace">
        <p className="text-[11.5px] text-subtle">Sign in to manage a mail domain.</p>
      </Field>
    )
  }

  return (
    <Field
      label="Workspace"
      hint="Run email on your own domain, with addresses for your team."
    >
      <Button variant="secondary" onClick={onOpen} className="w-full justify-between">
        <span>Open workspace setup</span>
        <ChevronRightIcon className="h-4 w-4 flex-none text-subtle" />
      </Button>
      <p className="mt-1.5 text-[11px] leading-relaxed text-subtle">
        Add a domain, publish its DNS records, verify it, then assign addresses.
      </p>
    </Field>
  )
}
