import { describe, it, expect } from 'vitest'
import { bridgeTargets, outboundBridge, resolveBridgeProbes, type BridgeProbe } from './bridge'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

describe('bridgeTargets', () => {
  it('always probes the sender domain default, then every override', () => {
    const targets = bridgeTargets('alice@mailstr.app', ['_smtp@other.example', 'self.example'])
    expect(targets.map((t) => t.target)).toEqual([
      '_smtp@mailstr.app',
      '_smtp@other.example',
      '_smtp@self.example',
    ])
    expect(targets.map((t) => t.isDefault)).toEqual([true, false, false])
  })

  it('dedupes case-insensitively and drops blank overrides', () => {
    const targets = bridgeTargets('alice@mailstr.app', ['_SMTP@mailstr.app', '  ', '_smtp@other.example'])
    expect(targets.map((t) => t.target)).toEqual(['_smtp@mailstr.app', '_smtp@other.example'])
  })

  it('keeps an npub/hex override as-is (no _smtp wrapping)', () => {
    const npub = 'npub1' + 'q'.repeat(58)
    const targets = bridgeTargets('alice@mailstr.app', [ALICE, npub])
    expect(targets[1].target).toBe(ALICE)
    expect(targets[2].target).toBe(npub)
  })
})

describe('resolveBridgeProbes', () => {
  it('reports resolving, then resolved/failed per target, without waiting for all', async () => {
    const seen: BridgeProbe[] = []
    const targets = bridgeTargets('alice@mailstr.app', ['slow.example'])
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
