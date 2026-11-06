import { describe, it, expect } from 'vitest'
import { chunkTags, splitMessage } from '@protocol'
import { ChunkAssembler, type ChunkPart } from './chunkAssembler'

const SENDER = 'a'.repeat(64)
const RECIPIENT = 'b'.repeat(64)

async function partsFor(raw: string): Promise<ChunkPart[]> {
  const { slices, msgid, totalBytes } = await splitMessage(raw, {
    senderPubkey: SENDER,
    recipientPubkey: RECIPIENT,
  })
  return slices.map((content, i) => ({
    tags: chunkTags(msgid, i, slices.length, totalBytes),
    content,
    wrapId: `wrap-${i}`,
    wrapSecret: `secret-${i}`,
  }))
}

const BIG = 'x'.repeat(120_000)

describe('ChunkAssembler', () => {
  it('buffers parts and emits one message when the set is complete', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)
    expect(parts.length).toBeGreaterThan(1)

    // Last part first: relays deliver out of order.
    const ordered = [parts[parts.length - 1], ...parts.slice(0, -1)]
    let result
    for (const part of ordered) result = await assembler.add(part)

    expect(result?.status).toBe('complete')
    if (result?.status !== 'complete') return
    expect(result.message.raw).toBe(BIG)
    expect(result.message.id).toBe(parts[0].wrapId)
    expect(result.message.wrapIds).toEqual(parts.map((p) => p.wrapId))
    expect(result.message.wrapSecrets).toEqual(
      parts.map((p) => ({ id: p.wrapId, secret: p.wrapSecret })),
    )
    expect(assembler.pendingGroups).toBe(0)
  })

  it('reports partial progress while parts are missing', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)

    const first = await assembler.add(parts[0])
    expect(first.status).toBe('partial')
    if (first.status !== 'partial') return
    expect(first.raw).toBe(parts[0].content)
    expect(first.id).toBe(parts[0].wrapId)
    expect(first.have).toBe(1)
    expect(first.total).toBe(parts.length)
    expect(first.missing).toEqual(
      Array.from({ length: parts.length - 1 }, (_, i) => i + 1),
    )

    const second = await assembler.add(parts[1])
    expect(second.status).toBe('partial')
    if (second.status !== 'partial') return
    expect(second.raw).toBe(parts[0].content + parts[1].content)
    expect(second.have).toBe(2)
    expect(second.missing).toEqual(
      Array.from({ length: parts.length - 2 }, (_, i) => i + 2),
    )
    expect(assembler.pendingGroups).toBe(1)
  })

  it('only renders the contiguous prefix when a middle part is missing', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)

    await assembler.add(parts[0])
    await assembler.add(parts[2])
    const result = await assembler.add(parts[3])
    expect(result.status).toBe('partial')
    if (result.status !== 'partial') return
    expect(result.raw).toBe(parts[0].content)
    expect(result.wrapIds).toEqual([parts[0].wrapId, parts[2].wrapId, parts[3].wrapId])
    expect(result.missing).toEqual(
      Array.from({ length: parts.length }, (_, i) => i).filter(
        (i) => i !== 0 && i !== 2 && i !== 3,
      ),
    )
  })

  it('emits a headerless placeholder before chunk 0 arrives', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)

    const result = await assembler.add(parts[1])
    expect(result.status).toBe('partial')
    if (result.status !== 'partial') return
    expect(result.headerless).toBe(true)
    expect(result.id).toMatch(/^pending:/)
    expect(result.raw).toBe(parts[1].content)
    expect(result.missing).toContain(0)
    expect(result.have).toBe(1)
  })

  it('ignores a replayed part after the message was emitted', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)
    for (const part of parts) await assembler.add(part)

    await expect(assembler.add(parts[0])).resolves.toEqual({ status: 'duplicate' })
  })

  it('treats an identical replay before completion as buffered, not a conflict', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)

    await assembler.add(parts[0])
    await expect(assembler.add(parts[0])).resolves.toEqual({
      status: 'buffered',
      have: 1,
      total: parts.length,
    })
  })

  it('accepts a re-published part with a new wrap id as the same slice', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)

    // A bridge retry re-wraps the same slice with a fresh ephemeral key: the
    // content matches but the wrap id does not. That is a duplicate, not a
    // conflict, and the extra wrap must still be deletable.
    const retry = { ...parts[0], wrapId: 'retry-wrap-0', wrapSecret: 'retry-secret-0' }
    await assembler.add(parts[0])
    await expect(assembler.add(retry)).resolves.toEqual({
      status: 'buffered',
      have: 1,
      total: parts.length,
    })

    let result
    for (const part of parts.slice(1)) result = await assembler.add(part)

    expect(result?.status).toBe('complete')
    if (result?.status !== 'complete') return
    expect(result.message.raw).toBe(BIG)
    expect(result.message.wrapIds).toContain(retry.wrapId)
    expect(result.message.wrapSecrets).toContainEqual({
      id: retry.wrapId,
      secret: retry.wrapSecret,
    })
  })

  it('rejects a second part at the same index with different bytes', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)

    await assembler.add(parts[0])
    const forged = { ...parts[0], content: parts[0].content.slice(0, -1) + 'Z' }
    const result = await assembler.add(forged)

    expect(result).toMatchObject({ status: 'invalid' })
    // The poisoned group is dropped rather than stitched.
    expect(assembler.pendingGroups).toBe(0)
  })

  it('rejects a group whose parts disagree about the total', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)

    await assembler.add(parts[0])
    const meta = parts[0].tags.find((t) => t[0] === 'chunk')!
    const forged = {
      ...parts[1],
      tags: [
        ['chunk', meta[1], '1', String(parts.length + 1)],
        ['chunk-size', parts[0].tags[1][1]],
      ],
    }

    const result = await assembler.add(forged)
    expect(result).toMatchObject({ status: 'invalid' })
  })

  it('reports a hash mismatch instead of returning corrupt mail', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)
    const tampered = parts.map((p, i) =>
      i === 1 ? { ...p, content: p.content.slice(0, -1) + 'Z' } : p,
    )

    let result
    for (const part of tampered) result = await assembler.add(part)

    expect(result).toMatchObject({ status: 'invalid', reason: expect.stringContaining('hash') })
  })

  it('drops a group older than its TTL', async () => {
    let now = 0
    const assembler = new ChunkAssembler(1_000, () => now)
    const parts = await partsFor(BIG)

    await assembler.add(parts[0])
    now = 2_000
    expect(assembler.expire()).toHaveLength(1)
    expect(assembler.pendingGroups).toBe(0)
  })

  it('reset forgets in-flight groups', async () => {
    const assembler = new ChunkAssembler()
    const parts = await partsFor(BIG)
    await assembler.add(parts[0])
    assembler.reset()
    expect(assembler.pendingGroups).toBe(0)
  })
})
