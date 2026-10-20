import { beforeEach, describe, expect, it } from 'vitest'
import { useComposeOverlay } from './composeOverlay'

const DRAFT = { to: 'bob@x.com', subject: 'Hi', body: 'Hello' }

beforeEach(() => {
  useComposeOverlay.setState({ draft: null, minimized: false, revision: 0 })
})

describe('composeOverlay', () => {
  it('bumps revision when a new draft replaces the open one', () => {
    useComposeOverlay.getState().open(DRAFT)
    const first = useComposeOverlay.getState().revision
    useComposeOverlay.getState().open({ ...DRAFT, subject: 'Reply' })
    expect(useComposeOverlay.getState().revision).toBe(first + 1)
  })

  // "Write" restores the same composer — its draft and field state must
  // survive, so it is not a new revision.
  it('does not bump revision when restoring a minimized draft', () => {
    useComposeOverlay.getState().open(DRAFT)
    useComposeOverlay.getState().setMinimized(true)
    const before = useComposeOverlay.getState().revision

    useComposeOverlay.getState().startBlank()

    expect(useComposeOverlay.getState().draft).toBe(DRAFT)
    expect(useComposeOverlay.getState().minimized).toBe(false)
    expect(useComposeOverlay.getState().revision).toBe(before)
  })

  it('bumps revision when starting a blank draft from nothing', () => {
    expect(useComposeOverlay.getState().revision).toBe(0)
    useComposeOverlay.getState().startBlank()
    expect(useComposeOverlay.getState().draft).toEqual({ to: '', subject: '', body: '' })
    expect(useComposeOverlay.getState().revision).toBe(1)
  })
})
