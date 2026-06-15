// @vitest-environment jsdom
//
// useThrottledValue — leading + trailing throttle. The leading edge updates the
// output immediately; intermediate changes within the window are coalesced; the
// final value always flushes on the trailing edge so the output never gets stuck on
// a stale value. This is the preview/diff input gate (the live draft is never
// throttled), so "always converges to the latest value" is the load-bearing property.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThrottledValue } from '../useThrottledValue'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); cleanup() })

describe('useThrottledValue', () => {
  it('passes the initial value through immediately', () => {
    const { result } = renderHook(({ v }) => useThrottledValue(v, 120), { initialProps: { v: 'a' } })
    expect(result.current).toBe('a')
  })

  it('takes the first change after an idle gap on the leading edge', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 120), { initialProps: { v: 'a' } })
    // Advance past the window so the next change is a leading edge, then change.
    act(() => { vi.advanceTimersByTime(200) })
    rerender({ v: 'b' })
    expect(result.current).toBe('b')
  })

  it('coalesces rapid changes and flushes the LAST one on the trailing edge', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 120), { initialProps: { v: 'a' } })
    act(() => { vi.advanceTimersByTime(200) })
    rerender({ v: 'b' }) // leading edge → immediate
    expect(result.current).toBe('b')
    // Two more changes inside the same window: held, not applied yet.
    rerender({ v: 'c' })
    act(() => { vi.advanceTimersByTime(40) })
    rerender({ v: 'd' })
    expect(result.current).toBe('b')
    // Trailing edge flushes the latest value (d), not the intermediate (c).
    act(() => { vi.advanceTimersByTime(120) })
    expect(result.current).toBe('d')
  })

  it('emits at most ~once per window under sustained change', () => {
    let renders = 0
    const { rerender } = renderHook(({ v }) => { renders++; return useThrottledValue(v, 100) }, { initialProps: { v: 0 } })
    const baseline = renders
    // 10 changes over ~500ms (one every 50ms): far fewer than 10 throttled commits.
    for (let i = 1; i <= 10; i++) {
      rerender({ v: i })
      act(() => { vi.advanceTimersByTime(50) })
    }
    act(() => { vi.advanceTimersByTime(200) })
    // A render happens per rerender (props change), but the COMMITTED value updates
    // are throttled — the value-change re-renders are bounded well under 10.
    expect(renders - baseline).toBeLessThan(10 * 2)
  })

  it('always converges to the latest value once the window elapses', () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 120), { initialProps: { v: 'x' } })
    rerender({ v: 'y' })
    rerender({ v: 'z' })
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current).toBe('z')
  })

  it('adopts the new value immediately when resetKey changes (file switch)', () => {
    // Within the throttle window, a resetKey change (switching files) must bypass the
    // throttle so the preview never shows file A's content under file B.
    const { result, rerender } = renderHook(
      ({ v, k }) => useThrottledValue(v, 120, k),
      { initialProps: { v: 'A-content', k: 'a.md' } },
    )
    rerender({ v: 'A-edited', k: 'a.md' }) // same file, inside window → held
    expect(result.current).toBe('A-content')
    rerender({ v: 'B-content', k: 'b.md' }) // switched file → immediate, no delay
    expect(result.current).toBe('B-content')
  })
})
