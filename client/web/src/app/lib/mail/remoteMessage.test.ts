import { afterEach, describe, expect, it, vi } from 'vitest'
import { encryptFile } from '@formstr/drive-sdk'
import { generateSecretKey } from 'nostr-tools/pure'
import { bytesToHex } from 'nostr-tools/utils'
import type { RemoteMessageMeta } from '@protocol'
import { fetchRemoteMessage, decodeRemoteEmail, deleteRemoteMessage } from './remoteMessage'
import type { Email } from '@/app/types/mail'

const RAW = [
  'From: Big Sender <big@example.com>',
  'To: me@mailstr.app',
  'Subject: Downloaded remote message',
  'Date: Tue, 2 Jan 2024 00:00:00 +0000',
  'Message-ID: <big@example.com>',
  '',
  'The full body from Blossom.',
].join('\r\n')

function meta(file: Awaited<ReturnType<typeof encryptFile>>): RemoteMessageMeta {
  return {
    v: 1,
    provider: 'blossom',
    servers: ['https://blossom.example'],
    encryptionKey: file.encryptionKey,
    blobHash: file.blobHash,
    fileHash: file.unencryptedFileHash,
    size: file.size,
    chunkSize: file.chunkSize,
    filename: 'message.eml',
    mimeType: 'message/rfc822',
    shareUrl: 'https://drive.formstr.app/#shared=naddr1big&k=' + 'a'.repeat(64),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('remote messages', () => {
  it('fetches and verifies the encrypted full message from Blossom', async () => {
    const plain = new TextEncoder().encode(RAW)
    const encrypted = await encryptFile(plain)
    const remote = meta(encrypted)
    const fetchMock = vi.fn(async () => new Response(encrypted.bytes as unknown as BodyInit))
    vi.stubGlobal('fetch', fetchMock)

    const out = await fetchRemoteMessage(remote)

    expect(new TextDecoder().decode(out)).toBe(RAW)
    expect(fetchMock).toHaveBeenCalledWith(
      `https://blossom.example/${remote.blobHash}`,
      expect.objectContaining({ referrerPolicy: 'no-referrer' }),
    )
  })

  it('asks every Blossom server to delete the remote blob', async () => {
    const plain = new TextEncoder().encode(RAW)
    const encrypted = await encryptFile(plain)
    const remote = {
      ...meta(encrypted),
      servers: ['https://blossom.example', 'https://backup.example'],
      deleteKey: bytesToHex(generateSecretKey()),
    }
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await deleteRemoteMessage(remote)

    expect(result).toEqual({ deleted: 2, failed: 0 })
    expect(fetchMock).toHaveBeenCalledWith(
      `https://blossom.example/${remote.blobHash}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: expect.stringMatching(/^Nostr /) },
      }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      `https://backup.example/${remote.blobHash}`,
      expect.anything(),
    )
  })

  it('replaces the pointer with the parsed full email', async () => {
    const base: Email = {
      id: 'a'.repeat(64),
      fromHeader: { address: 'big@example.com' },
      to: [{ address: 'me@mailstr.app' }],
      subject: 'Downloaded remote message',
      body: 'This message is too large to deliver inline.',
      attachments: [],
      timestamp: 1_700_000_000,
      senderPubkey: 'b'.repeat(64),
      read: false,
      labelEventIds: [],
      labels: [],
      remote: {
        v: 1,
        provider: 'blossom',
        servers: ['https://blossom.example'],
        encryptionKey: 'c'.repeat(64),
        blobHash: 'd'.repeat(64),
        fileHash: 'e'.repeat(64),
        size: 100,
        chunkSize: 65536,
        filename: 'message.eml',
        mimeType: 'message/rfc822',
        shareUrl: 'https://drive.formstr.app/#shared=naddr1big&k=' + 'a'.repeat(64),
      },
    }

    const full = await decodeRemoteEmail(
      base,
      new TextEncoder().encode(RAW),
      null,
    )

    expect(full.body.trim()).toBe('The full body from Blossom.')
    expect(full.remote?.loaded).toBe(true)
    expect(full.subject).toBe('Downloaded remote message')
    expect(full.timestamp).toBe(1_700_000_000)
  })
})
