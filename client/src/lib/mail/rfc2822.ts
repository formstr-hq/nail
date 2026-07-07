import type { MailAddress } from '@/types/mail'

export function buildRfc2822({
  from,
  to,
  cc,
  subject,
  body,
  bodyHtml,
  inReplyTo,
  references,
  messageId,
}: {
  from: MailAddress
  to: MailAddress[]
  cc?: MailAddress[]
  subject: string
  body: string
  bodyHtml?: string
  inReplyTo?: string
  references?: string[]
  messageId?: string
}): string {
  const id = messageId ?? `<${crypto.randomUUID()}@mail.formstr.app>`
  const date = new Date().toUTCString()

  const formatAddress = (a: MailAddress) =>
    a.name ? `${a.name} <${a.address}>` : a.address

  const lines: string[] = [
    `Message-ID: ${id}`,
    `Date: ${date}`,
    `From: ${formatAddress(from)}`,
    `To: ${to.map(formatAddress).join(', ')}`,
  ]

  if (cc?.length) lines.push(`CC: ${cc.map(formatAddress).join(', ')}`)
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`)
  if (references?.length) lines.push(`References: ${references.join(' ')}`)

  lines.push(`Subject: ${subject}`)
  lines.push('MIME-Version: 1.0')

  if (bodyHtml) {
    const boundary = `----=_Part_${crypto.randomUUID().replace(/-/g, '')}`
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    lines.push('')
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/plain; charset=UTF-8')
    lines.push('')
    lines.push(body)
    lines.push(`--${boundary}`)
    lines.push('Content-Type: text/html; charset=UTF-8')
    lines.push('')
    lines.push(bodyHtml)
    lines.push(`--${boundary}--`)
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8')
    lines.push('')
    lines.push(body)
  }

  return lines.join('\r\n')
}

export async function parseRfc2822(raw: string) {
  // postal-mime works in browser and Node
  const { default: PostalMime } = await import('postal-mime')
  const parser = new PostalMime()
  return parser.parse(raw)
}
