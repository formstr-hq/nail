import { Field } from '@/app/components/settings/Field'

export function ComposingSection({
  signature,
  onChange,
}: {
  signature: string
  onChange: (value: string) => void
}) {
  return (
    <Field
      label="Signature"
      hint="Added to the bottom of new messages, where you can still edit it before sending."
    >
      <textarea
        value={signature}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Sent with Mail by Form*"
        rows={3}
        className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-subtle focus:outline-none"
      />
    </Field>
  )
}