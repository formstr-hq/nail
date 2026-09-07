import { describe, it, expect, vi, afterEach } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import { decryptAttachment, resolveAttachment, safeFilename, formatSize } from './attachments'

/**
 * Encrypt exactly the way `nostr-bridge/src/blossom-client.ts` does, using
 * Node crypto rather than the code under test. If the client's WebCrypto path
 * can read this, the two sides genuinely interoperate — a helper that shared
 * the client's own implementation would prove nothing.
 */
function bridgeEncrypt(plaintext: Buffer) {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return { ciphertext, keyHex: key.toString('hex'), nonceHex: iv.toString('hex') }
}

afterEach(() => vi.unstubAllGlobals())

describe('decryptAttachment', () => {
  it('reads a blob the bridge encrypted', async () => {
    const plaintext = Buffer.from('relay-trace: seal ok\nrumor ok\n', 'utf8')
    const { ciphertext, keyHex, nonceHex } = bridgeEncrypt(plaintext)

    const out = await decryptAttachment(new Uint8Array(ciphertext), keyHex, nonceHex)
    expect(Buffer.from(out).toString('utf8')).toBe(plaintext.toString('utf8'))
  })

  it('round-trips bytes that are not valid UTF-8', async () => {
    const plaintext = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x01])
    const { ciphertext, keyHex, nonceHex } = bridgeEncrypt(plaintext)

    const out = await decryptAttachment(new Uint8Array(ciphertext), keyHex, nonceHex)
    expect(Buffer.from(out).equals(plaintext)).toBe(true)
  })

  // The auth tag is the whole point of GCM: a tampered blob must fail loudly,
  // never decrypt to garbage that then gets written to disk.
  it('refuses a blob whose ciphertext was altered', async () => {
    const { ciphertext, keyHex, nonceHex } = bridgeEncrypt(Buffer.from('invoice', 'utf8'))
    ciphertext[0] ^= 0xff

    await expect(decryptAttachment(new Uint8Array(ciphertext), keyHex, nonceHex)).rejects.toThrow(
      /integrity/i,
    )
  })

  it('refuses a blob whose auth tag was altered', async () => {
    const { ciphertext, keyHex, nonceHex } = bridgeEncrypt(Buffer.from('invoice', 'utf8'))
    ciphertext[ciphertext.length - 1] ^= 0xff

    await expect(decryptAttachment(new Uint8Array(ciphertext), keyHex, nonceHex)).rejects.toThrow(
      /integrity/i,
    )
  })

  it('refuses the wrong key', async () => {
    const { ciphertext, nonceHex } = bridgeEncrypt(Buffer.from('invoice', 'utf8'))
    const wrong = randomBytes(32).toString('hex')

    await expect(decryptAttachment(new Uint8Array(ciphertext), wrong, nonceHex)).rejects.toThrow(
      /integrity/i,
    )
  })

  it.each([
    ['too short', 'ab'],
    ['not hex', 'z'.repeat(64)],
    ['empty', ''],
  ])('rejects a malformed key (%s)', async (_label, keyHex) => {
    const { ciphertext, nonceHex } = bridgeEncrypt(Buffer.from('x', 'utf8'))
    await expect(decryptAttachment(new Uint8Array(ciphertext), keyHex, nonceHex)).rejects.toThrow(
      /malformed/i,
    )
  })

  it('rejects a blob shorter than the auth tag', async () => {
    const { keyHex, nonceHex } = bridgeEncrypt(Buffer.from('x', 'utf8'))
    await expect(decryptAttachment(new Uint8Array(4), keyHex, nonceHex)).rejects.toThrow(/short/i)
  })
})

describe('resolveAttachment', () => {
  const base = { filename: 'f.bin', contentType: 'application/octet-stream' }

  it('returns inline bytes without touching the network', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const data = new Uint8Array([1, 2, 3])
    await expect(resolveAttachment({ ...base, data })).resolves.toEqual(data)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches and decrypts a hosted attachment', async () => {
    const plaintext = Buffer.from('hosted payload', 'utf8')
    const { ciphertext, keyHex, nonceHex } = bridgeEncrypt(plaintext)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(ciphertext))),
    )

    const out = await resolveAttachment({
      ...base,
      blossomUrl: 'https://blossom.example/blob',
      blossomKey: keyHex,
      blossomNonce: nonceHex,
    })
    expect(Buffer.from(out).toString('utf8')).toBe('hosted payload')
  })

  // parseImetaTags allows an attachment with no decryption fields, so hosting
  // in the clear is legitimate rather than an error.
  it('returns a hosted attachment unchanged when it carries no key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([9, 8, 7]))),
    )
    const out = await resolveAttachment({ ...base, blossomUrl: 'https://blossom.example/plain' })
    expect(Array.from(out)).toEqual([9, 8, 7])
  })

  // The URL comes from whoever sent the message.
  it.each([
    'http://blossom.example/blob',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not a url',
  ])('refuses to fetch %s', async (blossomUrl) => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(resolveAttachment({ ...base, blossomUrl })).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports a failed download by status, naming the host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    )
    await expect(
      resolveAttachment({ ...base, blossomUrl: 'https://blossom.example/gone' }),
    ).rejects.toThrow(/blossom\.example refused the download \(404\)/)
  })

  // An unreachable host, a DNS failure and a missing CORS header all reject
  // the promise with a bare "Failed to fetch", which tells the reader nothing.
  it('turns a network-level rejection into a message naming the host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(
      resolveAttachment({ ...base, blossomUrl: 'https://blossom.example/blob' }),
    ).rejects.toThrow(/Could not reach blossom\.example/)
  })
})

describe('safeFilename', () => {
  // The sender chooses this string, and it becomes a download target.
  it('flattens path separators so a name cannot escape the download folder', () => {
    // Separators flatten first, then the leading dots are stripped, so the
    // traversal is gone twice over.
    expect(safeFilename('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(safeFilename('C:\\windows\\system32\\evil.dll')).toBe('C:_windows_system32_evil.dll')
  })

  it('strips a leading dot so the file is not hidden', () => {
    expect(safeFilename('.bashrc')).toBe('bashrc')
  })

  // Literal control characters are written as escapes here on purpose: a
  // raw U+202E in source is itself the Trojan Source trick, and it makes
  // git treat the file as binary so the test stops being reviewable.
  it('removes control characters that could disguise the extension', () => {
    expect(safeFilename('invoice\u202efdp.exe')).toBe('invoicefdp.exe')
    expect(safeFilename('a\u0000b\u001f.txt')).toBe('ab.txt')
  })

  it('falls back rather than returning an empty name', () => {
    expect(safeFilename('')).toBe('attachment')
    expect(safeFilename('...')).toBe('attachment')
  })

  it('caps absurd lengths', () => {
    expect(safeFilename('a'.repeat(500))).toHaveLength(200)
  })
})

describe('formatSize', () => {
  it('scales units', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(900)).toBe('900 B')
    expect(formatSize(2048)).toBe('2 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('returns null when the size is not known', () => {
    expect(formatSize(undefined)).toBeNull()
  })
})
