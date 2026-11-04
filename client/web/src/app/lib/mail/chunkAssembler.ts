import { readChunkMeta, reassembleChunks, type ChunkMeta } from '@protocol'

/**
 * Buffer for messages delivered as multiple gift wraps.
 *
 * The bridge splits a body that cannot fit one NIP-44 payload into ordered
 * chunks (see `@protocol/chunked-mail`), each in its own kind-1059 with its own
 * ephemeral key. A chunk's rumor content is a byte range, not a message, so it
 * must never reach the RFC 2822 parser: it is buffered here until every part
 * has arrived, then verified and stitched.
 *
 * In-memory and per subscription on purpose. Relays replay the whole history
 * on connect, so a session that reloads simply rebuilds the groups from the
 * same events; persisting partial ciphertext would only add a second, staler
 * source of truth. A group that never completes is dropped after `ttlMs` —
 * that is a relay that lost a part, not something a retry on this device fixes.
 *
 * The assembled identity is chunk 0's wrap id, not the msgid: it is just as
 * stable across replays, and it keeps existing behaviour that keys mail state
 * (read/archived/trashed, the kind-34578 metadata event) on the wrap id
 * unchanged. `wrapIds` carries the rest so delete-forever can publish one
 * NIP-09 per part, each signed with that part's own embedded key.
 */

/** One part's wrap id and the ephemeral key from its rumor (WRAP_KEY_TAG). */
export interface WrapSecret {
  id: string
  secret: string
}

export interface ChunkPart {
  /** The rumor's raw tags — chunk metadata is read from them. */
  tags: string[][]
  /** Byte-string slice carried in the rumor content. */
  content: string
  /** Gift-wrap event id this part arrived in. */
  wrapId: string
  /** Ephemeral key from the rumor, when present. */
  wrapSecret?: string
}

export interface AssembledMessage {
  msgid: string
  raw: string
  /** Chunk 0's wrap id; becomes `Email.id`. */
  id: string
  wrapIds: string[]
  /** One entry per part, for the delete-forever path. */
  wrapSecrets: WrapSecret[]
}

export type ChunkAddResult =
  | { status: 'complete'; message: AssembledMessage }
  | { status: 'buffered'; have: number; total: number }
  /** A part we have already handed to the inbox (relay replay). Ignore it. */
  | { status: 'duplicate' }
  | { status: 'invalid'; reason: string }

interface Group {
  meta: ChunkMeta
  createdAt: number
  parts: Map<number, { content: string; wrapId: string; wrapSecret?: string }>
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
/** How many completed msgids to remember for replays (bounded, FIFO). */
const COMPLETED_MEMORY = 500

export class ChunkAssembler {
  private readonly groups = new Map<string, Group>()
  private readonly completed = new Set<string>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(ttlMs: number = DEFAULT_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs
    this.now = now
  }

  /** How many messages are waiting for at least one more part. */
  get pendingGroups(): number {
    return this.groups.size
  }

  /**
   * Add one part. Returns `complete` once the group is whole, `buffered`
   * while parts are missing, `duplicate` for a replayed part whose message has
   * already been emitted, and `invalid` for inconsistent or corrupt groups.
   */
  async add(part: ChunkPart): Promise<ChunkAddResult> {
    this.expire()

    const meta = readChunkMeta(part.tags)
    if (!meta) return { status: 'invalid', reason: 'missing chunk tags' }

    if (this.completed.has(meta.msgid)) return { status: 'duplicate' }

    let group = this.groups.get(meta.msgid)
    if (!group) {
      group = { meta, createdAt: this.now(), parts: new Map() }
      this.groups.set(meta.msgid, group)
    } else if (
      group.meta.total !== meta.total ||
      group.meta.totalBytes !== meta.totalBytes
    ) {
      // Two events claim the same msgid with different shapes: one is forged
      // or corrupted. Drop the group rather than stitch incompatible bytes.
      this.groups.delete(meta.msgid)
      return { status: 'invalid', reason: 'conflicting chunk metadata' }
    }

    const previous = group.parts.get(meta.index)
    if (previous) {
      // Same index twice with different bytes is a hard conflict. An identical
      // replay (two relays holding the same event) is simply ignored.
      if (previous.content !== part.content || previous.wrapId !== part.wrapId) {
        this.groups.delete(meta.msgid)
        return { status: 'invalid', reason: `conflicting part ${meta.index}` }
      }
      return { status: 'buffered', have: group.parts.size, total: meta.total }
    }

    group.parts.set(meta.index, {
      content: part.content,
      wrapId: part.wrapId,
      wrapSecret: part.wrapSecret,
    })

    if (group.parts.size < meta.total) {
      return { status: 'buffered', have: group.parts.size, total: meta.total }
    }

    const ordered = Array.from({ length: meta.total }, (_, i) => group!.parts.get(i))
    if (ordered.some((p) => p === undefined)) {
      return { status: 'buffered', have: group.parts.size, total: meta.total }
    }

    const result = await reassembleChunks(
      ordered.map((p, i) => ({
        tags: [
          ['chunk', meta.msgid, String(i), String(meta.total)],
          ['chunk-size', String(meta.totalBytes)],
        ],
        content: p!.content,
      })),
    )

    this.groups.delete(meta.msgid)

    if (!result.ok) {
      return { status: 'invalid', reason: `reassembly ${result.reason}` }
    }

    this.rememberCompleted(meta.msgid)

    const wrapSecrets: WrapSecret[] = []
    for (const p of ordered) {
      if (p?.wrapSecret) wrapSecrets.push({ id: p.wrapId, secret: p.wrapSecret })
    }

    return {
      status: 'complete',
      message: {
        msgid: meta.msgid,
        raw: result.raw,
        id: ordered[0]!.wrapId,
        wrapIds: ordered.map((p) => p!.wrapId),
        wrapSecrets,
      },
    }
  }

  /** Drop groups older than the TTL; returns the msgids that were abandoned. */
  expire(): string[] {
    const cutoff = this.now() - this.ttlMs
    const expired: string[] = []
    for (const [msgid, group] of this.groups) {
      if (group.createdAt < cutoff) {
        this.groups.delete(msgid)
        expired.push(msgid)
      }
    }
    return expired
  }

  /** Forget all in-flight groups (account switch / session teardown). */
  reset(): void {
    this.groups.clear()
    this.completed.clear()
  }

  private rememberCompleted(msgid: string): void {
    this.completed.add(msgid)
    if (this.completed.size <= COMPLETED_MEMORY) return
    // Sets iterate in insertion order, so this evicts the oldest.
    const oldest = this.completed.values().next().value
    if (oldest !== undefined) this.completed.delete(oldest)
  }
}
