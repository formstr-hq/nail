import { describe, it, expect } from 'vitest'
import { splitMimeAttachments } from './mimeAttachments'

const LINK = `https://drive.formstr.app/#shared=naddr1example&k=${'a'.repeat(64)}`
const LINKS_TEXT = `--- Mailstr attachments ---\n- notes.txt: ${LINK}\n--- End Mailstr attachments ---\n`

describe('splitMimeAttachments', () => {
  it('hides attachments.txt and turns its links into attachment chips', () => {
    const result = splitMimeAttachments([
      {
        filename: 'attachments.txt',
        mimeType: 'text/plain',
        content: LINKS_TEXT,
      },
      {
        filename: 'inline.txt',
        mimeType: 'text/plain',
        content: 'hello',
      },
    ])

    expect(result.inline.map((a) => a.filename)).toEqual(['inline.txt'])
    expect(result.shared).toEqual([
      {
        filename: 'notes.txt',
        contentType: 'application/octet-stream',
        shareUrl: LINK,
      },
    ])
  })

  it('recognizes the file by its content even when the filename differs', () => {
    const result = splitMimeAttachments([
      {
        filename: 'Attachments - open me.txt',
        mimeType: 'text/plain',
        content: LINKS_TEXT,
      },
    ])

    expect(result.inline).toEqual([])
    expect(result.shared).toHaveLength(1)
    expect(result.shared[0]!.shareUrl).toBe(LINK)
  })

  it('keeps ordinary text attachments inline', () => {
    const result = splitMimeAttachments([
      { filename: 'notes.txt', mimeType: 'text/plain', content: 'hello' },
    ])

    expect(result.inline).toHaveLength(1)
    expect(result.shared).toEqual([])
  })
})
