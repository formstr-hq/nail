/**
 * Bind the receiving server's spam verdict to the bridge's signature.
 *
 * The message rspamd saw carries `X-Spam-Flag: YES` (see the mail-server
 * `milter_headers` config), but those bytes are also controlled by the sender up
 * to the moment they reach us: a message can arrive with its own `X-Spam-Flag:
 * NO`, and a naive client would trust it. The bridge is the last hop — it is
 * the component that signs the gift wrap the client verifies — so it strips
 * every sender-supplied spam header and writes one authoritative
 * `X-Bridge-Spam` line instead.
 *
 * The verdict itself comes from the MTA's headers. A sender can still add
 * `X-Spam-Flag: YES` and self-mark (annoying, not dangerous), but cannot
 * suppress a real verdict: rspamd's spam-header routine removes the sender's
 * copy before adding its own, and the bridge scans every copy for a YES.
 * What the sender *cannot* forge is `X-Bridge-Spam`, because it is written
 * here, after the MTA.
 *
 * This is the only header the bridge rewrites. Everything else stays
 * byte-identical, because the raw message is the mail's identity (§1): the
 * operation runs on the header block only and never decodes the body.
 */

const STRIPPED_HEADER = /^x-(?:spam|spamd|rspamd|bridge-spam)(?:-|$)/i
const FLAG_HEADER = /^x-spam-flag\s*:\s*(.*)$/i
const BRIDGE_HEADER = 'X-Bridge-Spam'

interface SplitMessage {
  /** Header lines with folds resolved, in order. */
  headers: string[]
  /** Raw bytes starting at the blank line separating headers from body. */
  body: Buffer
  /** The line ending the message used, so the rewrite does not mix styles. */
  eol: string
}

function split(raw: Buffer): SplitMessage | null {
  // Find the header/body separator without decoding the body.
  let sep = raw.indexOf('\r\n\r\n')
  let eol = '\r\n'
  if (sep === -1) {
    sep = raw.indexOf('\n\n')
    eol = '\n'
  }
  if (sep === -1) return null

  const headerText = raw.subarray(0, sep).toString('latin1')
  const body = raw.subarray(sep)
  const lines = headerText.split(eol === '\r\n' ? /\r\n/ : /\n/)

  // Unfold: a line starting with whitespace continues the previous header.
  const headers: string[] = []
  for (const line of lines) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1] += eol + line
    } else {
      headers.push(line)
    }
  }
  return { headers, body, eol }
}

function isSpam(headers: string[]): boolean {
  for (const header of headers) {
    const match = FLAG_HEADER.exec(header.split(/\r?\n/)[0])
    if (match && /^yes\b/i.test(match[1].trim())) return true
  }
  return false
}

/**
 * Strip every sender-supplied spam header and append the authoritative marker.
 * Returns `raw` unchanged for a malformed message with no header/body split.
 */
export function stampSpamMarker(raw: Buffer): Buffer {
  const splitMessage = split(raw)
  if (!splitMessage) return raw

  const spam = isSpam(splitMessage.headers)
  const { headers, body, eol } = splitMessage

  const kept: string[] = []
  for (const header of headers) {
    const name = header.split(/\r?\n/)[0].split(':')[0].trim()
    if (STRIPPED_HEADER.test(name)) continue
    kept.push(header)
  }

  kept.push(`${BRIDGE_HEADER}: ${spam ? 'yes' : 'no'}`)

  // Header block only; `body` still starts with the original blank line.
  return Buffer.concat([Buffer.from(kept.join(eol), 'latin1'), body])
}
