import { describe, it, expect } from 'vitest'
import { parseAttachmentLinks, parseAttachmentsTxt } from './attachmentLinks'

const LINK = `https://drive.formstr.app/#shared=naddr1example&k=${'a'.repeat(64)}`
const BLOCK = `--- Mailstr attachments ---\n- notes.txt: ${LINK}\n--- End Mailstr attachments ---`

describe('parseAttachmentLinks', () => {
  it('turns a link block into an attachment and removes it from the body', () => {
    const result = parseAttachmentLinks(`hello\n\n${BLOCK}\n`)
    expect(result.body).toBe('hello')
    expect(result.attachments).toEqual([
      {
        filename: 'notes.txt',
        contentType: 'application/octet-stream',
        shareUrl: LINK,
      },
    ])
  })

  it('leaves a block with no valid share link alone', () => {
    const text = 'hello\n\n--- Mailstr attachments ---\n- not a link\n--- End Mailstr attachments ---'
    expect(parseAttachmentLinks(text)).toEqual({ body: text, attachments: [] })
  })

  it('ignores a non-https share link', () => {
    const text = `--- Mailstr attachments ---\n- x.txt: http://drive.example/#shared=naddr&k=${'a'.repeat(64)}\n--- End Mailstr attachments ---`
    expect(parseAttachmentLinks(text).attachments).toEqual([])
  })
})

describe('parseAttachmentsTxt', () => {
  it('parses the MIME part content into an attachment chip', () => {
    expect(parseAttachmentsTxt(BLOCK)).toEqual([
      {
        filename: 'notes.txt',
        contentType: 'application/octet-stream',
        shareUrl: LINK,
      },
    ])
  })
})
