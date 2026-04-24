// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'

// Capture the SSE refresh callback so we can fire it manually
let sseCallback: (() => void) | null = null
vi.mock('../useSSE', () => ({
  useSSERefresh: (_channel: string, cb: () => void) => { sseCallback = cb },
}))

vi.mock('../../lib/apiError', () => ({
  ApiError: class extends Error {
    status: number
    body: unknown
    constructor(status: number, body: unknown) {
      super(`ApiError ${status}`)
      this.status = status
      this.body = body
    }
  },
}))

const { useProjects } = await import('../useApi')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sseCallback = null
})

describe('usePolling sequence counter (fetch starvation fix)', () => {
  it('only applies the last fetch result when multiple rapid fetches fire', async () => {
    // Track resolve functions for each fetch call
    const resolvers: Array<(v: unknown) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => {
      return new Promise(resolve => {
        resolvers.push((data: unknown) => {
          resolve({ ok: true, json: () => Promise.resolve(data) })
        })
      })
    }))

    const { result } = renderHook(() => useProjects())

    // Wait for initial fetch to be issued
    await waitFor(() => expect(resolvers.length).toBe(1))

    // Fire two rapid SSE refreshes before initial fetch resolves
    act(() => { sseCallback?.() })
    act(() => { sseCallback?.() })
    await waitFor(() => expect(resolvers.length).toBe(3))

    // Resolve all three in order — only the last should win
    await act(async () => { resolvers[0]([{ name: 'stale-1' }]) })
    await act(async () => { resolvers[1]([{ name: 'stale-2' }]) })
    await act(async () => { resolvers[2]([{ name: 'latest' }]) })

    await waitFor(() => {
      expect(result.current.data).toEqual([{ name: 'latest' }])
    })
  })

  it('stale fetch resolving after latest does not overwrite', async () => {
    const resolvers: Array<(v: unknown) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => {
      return new Promise(resolve => {
        resolvers.push((data: unknown) => {
          resolve({ ok: true, json: () => Promise.resolve(data) })
        })
      })
    }))

    const { result } = renderHook(() => useProjects())

    await waitFor(() => expect(resolvers.length).toBe(1))

    // Trigger a second fetch via SSE
    act(() => { sseCallback?.() })
    await waitFor(() => expect(resolvers.length).toBe(2))

    // Resolve the SECOND (latest) fetch first
    await act(async () => { resolvers[1]([{ name: 'latest' }]) })
    await waitFor(() => expect(result.current.data).toEqual([{ name: 'latest' }]))

    // Now resolve the FIRST (stale) fetch — should NOT overwrite
    await act(async () => { resolvers[0]([{ name: 'stale' }]) })

    // Data should still be 'latest'
    expect(result.current.data).toEqual([{ name: 'latest' }])
  })

  it('SSE refresh triggers a new fetch call', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      callCount++
      const n = callCount
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ name: `result-${n}` }]),
      })
    }))

    const { result } = renderHook(() => useProjects())

    // Wait for initial fetch
    await waitFor(() => expect(result.current.data).toEqual([{ name: 'result-1' }]))
    expect(callCount).toBe(1)

    // Fire SSE
    await act(async () => { sseCallback?.() })

    await waitFor(() => expect(result.current.data).toEqual([{ name: 'result-2' }]))
    expect(callCount).toBe(2)
  })

  it('skips fetch when document is hidden (tab-hidden suppression)', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      callCount++
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ name: `result-${callCount}` }]),
      })
    }))

    const { result } = renderHook(() => useProjects())

    // Initial fetch fires (document.hidden is false by default in jsdom)
    await waitFor(() => expect(result.current.data).toEqual([{ name: 'result-1' }]))
    const countAfterInit = callCount

    // Simulate tab going hidden
    Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true })

    // SSE refresh while hidden — should skip
    await act(async () => { sseCallback?.() })

    // No new fetch should have fired
    expect(callCount).toBe(countAfterInit)

    // Restore
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true })
  })
})
