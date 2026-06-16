// @vitest-environment jsdom
//
// useDebouncedValue — emits only after `ms` of quiet. Feeding the markdown preview
// from it means the whole-document re-render never fires mid-burst (only on pause),
// which is what keeps typing in a large file smooth.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedValue } from '../useDebouncedValue'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); cleanup() })

describe('useDebouncedValue', () => {
  it('passes the initial value through immediately', () => {
    const { result } = renderHook(({ v }) => useDebouncedValue(v, 180), { initialProps: { v: 'a' } })
    expect(result.current).toBe('a')
  })

  it('does NOT emit during a continuous burst, then flushes on pause', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 180), { initialProps: { v: 'a' } })
    // Five rapid changes, each within the window — the timer keeps resetting.
    for (const v of ['b', 'c', 'd', 'e', 'f']) {
      rerender({ v })
      act(() => { vi.advanceTimersByTime(50) })
    }
    expect(result.current).toBe('a') // never emitted mid-burst
    // Pause → the final value lands.
    act(() => { vi.advanceTimersByTime(180) })
    expect(result.current).toBe('f')
  })

  it('adopts the new value immediately when resetKey changes (file switch)', () => {
    const { result, rerender } = renderHook(
      ({ v, k }) => useDebouncedValue(v, 180, k),
      { initialProps: { v: 'A', k: 'a.md' } },
    )
    rerender({ v: 'A-edit', k: 'a.md' }) // same file → debounced (held)
    expect(result.current).toBe('A')
    rerender({ v: 'B', k: 'b.md' })      // switched file → immediate
    expect(result.current).toBe('B')
  })
})
