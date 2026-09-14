import { RelayManager } from '@/app/components/RelayManager'
import { Field } from '@/app/components/settings/Field'

export function RelaysSection({
  relays,
  onChange,
}: {
  relays: string[] | null
  onChange: (relays: string[]) => void
}) {
  return (
    <Field
      label="Inbox relays"
      hint="Where your encrypted mail is delivered and read from (kind 10050)."
    >
      {relays === null ? (
        <p className="text-[11.5px] text-subtle">Loading your relays…</p>
      ) : (
        <RelayManager relays={relays} onChange={onChange} />
      )}
    </Field>
  )
}