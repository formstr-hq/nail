import { describe, it, expect } from 'vitest'
import {
  bridgeTargets,
  outboundBridge,
  resolveBridgeProbes,
  senderBridge,
  type BridgeProbe,
} from './bridge'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

describe('bridgeTargets', () => {
  it('always probes the sender domain default, then every override', () => {
    const targets = bridgeTargets(['mailstr.app'], ['_smtp@other.example', 'self.example'])
    expect(targets.map((t) => t.target)).toEqual([
      '_smtp@mailstr.app',
      '_smtp@other.example',
      '_smtp@self.example',
    ])
    expect(targets.map((t) => t.isDefault)).toEqual([true, false, false])
  })

  it('probes the platform bridge plus every owned domain, even with none owned', () => {
    expect(bridgeTargets([]).map((t) => t.target)).toEqual(['_smtp@mailstr.app'])
    expect(bridgeTargets(['ACME.com', 'mailstr.app']).map((t) => t.target)).toEqual([
      '_smtp@mailstr.app',
      '_smtp@acme.com',
    ])
  })

  it('dedupes case-insensitively and drops blank overrides', () => {
    const targets = bridgeTargets(['mailstr.app'], ['_SMTP@mailstr.app', '  ', '_smtp@other.example'])
    expect(targets.map((t) => t.target)).toEqual(['_smtp@mailstr.app', '_smtp@other.example'])
  })

  it('keeps an npub/hex override as-is (no _smtp wrapping)', () => {
    const npub = 'npub1' + 'q'.repeat(58)
    const targets = bridgeTargets(['mailstr.app'], [ALICE, npub])
    expect(targets[1].target).toBe(ALICE)
    expect(targets[2].target).toBe(npub)
  })
})

describe('resolveBridgeProbes', () => {
  it('reports resolving, then resolved/failed per target, without waiting for all', async () => {
    const seen: BridgeProbe[] = []
    const targets = bridgeTargets(['mailstr.app'], ['slow.example'])
    let releaseSlow: (() => void) | undefined

    const run = resolveBridgeProbes(
      targets,
      (p) => seen.push(p),
      async (target) => {
        if (target.includes('slow')) {
          await new Promise<void>((r) => {
            releaseSlow = r
          })
          return null
        }
        return ALICE
      },
    )

    // Let the fast target settle while the slow one is still in flight.
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toContainEqual(
      expect.objectContaining({ target: '_smtp@mailstr.app', status: 'resolved', pubkey: ALICE }),
    )
    expect(seen).toContainEqual(
      expect.objectContaining({ target: '_smtp@slow.example', status: 'resolving' }),
    )
    expect(seen).not.toContainEqual(
      expect.objectContaining({ target: '_smtp@slow.example', status: 'failed' }),
    )

    releaseSlow!()
    await run
    expect(seen).toContainEqual(
      expect.objectContaining({ target: '_smtp@slow.example', status: 'failed' }),
    )
  })
})

describe('outboundBridge', () => {
  const probes = (states: Array<'resolving' | 'resolved' | 'failed'>, isDefault: boolean) =>
    states.map((status, i) => ({
      target: `t${i}`,
      label: `t${i}`,
      isDefault,
      ...(status === 'resolved' ? { status, pubkey: ALICE } : { status }),
    })) as BridgeProbe[]

  it('uses the default bridge when no override is configured', () => {
    expect(outboundBridge(probes(['resolved'], true))).toBe(ALICE)
    expect(outboundBridge(probes(['resolving'], true))).toBeNull()
    expect(outboundBridge(probes(['failed'], true))).toBeNull()
  })

  it('never silently falls back to the default when an override is configured', () => {
    const mixed: BridgeProbe[] = [
      { target: '_smtp@mailstr.app', label: 'mailstr.app', isDefault: true, status: 'resolved', pubkey: ALICE },
      { target: '_smtp@other.example', label: 'other.example', isDefault: false, status: 'failed', message: 'no' },
    ]
    expect(outboundBridge(mixed)).toBeNull()
  })

  it('uses a resolved override when one exists', () => {
    const mixed: BridgeProbe[] = [
      { target: '_smtp@mailstr.app', label: 'mailstr.app', isDefault: true, status: 'resolved', pubkey: ALICE },
      { target: '_smtp@other.example', label: 'other.example', isDefault: false, status: 'resolved', pubkey: BOB },
    ]
    expect(outboundBridge(mixed)).toBe(BOB)
  })
})

describe('outboundBridge per From', () => {
  const probe = (domain: string, state: 'resolving' | 'resolved' | 'failed', pubkey = ALICE) =>
    ({
      target: `_smtp@${domain}`,
      label: domain,
      isDefault: true,
      ...(state === 'resolved' ? { status: state, pubkey } : state === 'failed' ? { status: state, message: 'no' } : { status: state }),
    }) as BridgeProbe

  it("uses the From domain's own bridge", () => {
    const probes = [probe('mailstr.app', 'resolved', ALICE), probe('acme.com', 'resolved', BOB)]
    expect(outboundBridge(probes, 'josephus@mailstr.app')).toBe(ALICE)
    expect(outboundBridge(probes, 'bob@acme.com')).toBe(BOB)
  })

  // The bug this guards: a failing bridge on some other owned domain must not
  // block a mailstr From whose own bridge resolved.
  it('ignores bridges for domains the From is not on', () => {
    const probes = [probe('mailstr.app', 'resolved'), probe('acme.com', 'failed')]
    expect(senderBridge(probes, 'josephus@mailstr.app')).toEqual({
      bridgePubkey: ALICE,
      resolving: false,
      failed: [],
    })
  })

  it('falls back to the platform bridge when the From domain has none', () => {
    const probes = [probe('mailstr.app', 'resolved'), probe('acme.com', 'failed')]
    expect(outboundBridge(probes, 'bob@acme.com')).toBe(ALICE)
  })

  it('waits for the From domain rather than routing early through the platform', () => {
    const probes = [probe('mailstr.app', 'resolved'), probe('acme.com', 'resolving', BOB)]
    expect(senderBridge(probes, 'bob@acme.com')).toMatchObject({ bridgePubkey: null, resolving: true })
  })

  it('reports which bridge failed once nothing is usable', () => {
    const probes = [probe('mailstr.app', 'failed')]
    const state = senderBridge(probes, 'josephus@mailstr.app')
    expect(state.bridgePubkey).toBeNull()
    expect(state.resolving).toBe(false)
    expect(state.failed.map((p) => p.label)).toEqual(['mailstr.app'])
  })

  it('treats no probes yet as still resolving, not failed', () => {
    expect(senderBridge([], 'josephus@mailstr.app')).toMatchObject({ resolving: true, failed: [] })
  })
})
