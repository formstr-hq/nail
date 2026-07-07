import { useMailStore } from '@/store/mail'

export function EmailView() {
  const { emails, selectedId } = useMailStore()
  const email = selectedId ? emails[selectedId] : null

  if (!email) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Select a message to read
      </div>
    )
  }

  const date = new Date(email.timestamp * 1000).toLocaleString()

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">{email.subject}</h2>
        <div className="text-sm text-muted-foreground space-y-0.5">
          <div>
            <span className="font-medium text-foreground">From:</span>{' '}
            {email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}
          </div>
          <div>
            <span className="font-medium text-foreground">To:</span>{' '}
            {email.to.map((a) => a.address).join(', ')}
          </div>
          {email.cc?.length ? (
            <div>
              <span className="font-medium text-foreground">CC:</span>{' '}
              {email.cc.map((a) => a.address).join(', ')}
            </div>
          ) : null}
          <div>
            <span className="font-medium text-foreground">Date:</span> {date}
          </div>
        </div>
      </div>

      <hr className="border-border" />

      {email.bodyHtml ? (
        <iframe
          srcDoc={email.bodyHtml}
          sandbox="allow-same-origin"
          className="w-full min-h-96 border-0"
          title="Email body"
        />
      ) : (
        <pre className="text-sm whitespace-pre-wrap font-sans">{email.body}</pre>
      )}

      {email.attachments.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Attachments</h3>
          {email.attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-2 text-sm text-muted-foreground border border-border rounded-md px-3 py-2">
              <span className="truncate">{a.filename}</span>
              <span className="shrink-0">({Math.round(a.size / 1024)} KB)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
