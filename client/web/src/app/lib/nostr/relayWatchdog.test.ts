import { describe, expect, it, vi } from 'vitest'
import { RelayBootWatchdog } from './relayWatchdog'

describe('RelayBootWatchdog', () => {
  it('reports once when a boot error appears and then stops polling', () => {
    vi.useFakeTimers()
    try {
      let error: string | null = null
      const onError = vi.fn()
      const watchdog = new RelayBootWatchdog(() => error, onError, 1000)
      watchdog.start()

      vi.advanceTimersByTime(3000)
      expect(onError).not.toHaveBeenCalled()

      error = 'worker refused'
      vi.advanceTimersByTime(2000)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0][0]).toContain('worker refused')

      // Stopped: a second tick with the error still set must not re-report.
      vi.advanceTimersByTime(5000)
      expect(onError).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() cancels a pending poll', () => {
    vi.useFakeTimers()
    try {
      const onError = vi.fn()
      let error: string | null = null
      const watchdog = new RelayBootWatchdog(() => error, onError, 1000)
      watchdog.start()
      watchdog.stop()
      error = 'late failure'
      vi.advanceTimersByTime(5000)
      expect(onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('start() is idempotent', () => {
    vi.useFakeTimers()
    try {
      const onError = vi.fn()
      const watchdog = new RelayBootWatchdog(() => 'boom', onError, 1000)
      watchdog.start()
      watchdog.start()
      vi.advanceTimersByTime(1000)
      expect(onError).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
