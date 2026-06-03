// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'

// Capture the SSE listener so we can fire 'ui-state:changed' manually
let sseListener: (() => void) | null = null
vi.mock('../useSSE', () => ({
  addSSEListener: (_event: string, cb: () => void) => {
    sseListener = cb
    return () => { sseListener = null }
  },
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

const { usePinnedSessions } = await import('../usePinnedSessions')

type Resolver = (data: unknown) => void
interface Call { kind: 'GET' | 'PUT'; body?: unknown; resolve: Resolver }

function installFetchStub(): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
    const kind: Call['kind'] = init?.method === 'PUT' ? 'PUT' : 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    return new Promise<unknown>(resolve => {
      calls.push({
        kind, body,
        resolve: (data: unknown) => resolve({
          ok: true,
          status: kind === 'PUT' ? 204 : 200,
          json: () => Promise.resolve(data),
        }),
      })
    })
  }))
  return calls
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sseListener = null
})

describe('usePinnedSessions optimistic-edit protection', () => {
  it('keeps an optimistic pin when a concurrent SSE refetch returns stale server state', async () => {
    const calls = installFetchStub()

    const { result } = renderHook(() => usePinnedSessions('proj'))

    // Initial GET on mount
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1))
    const initial = calls.shift()!
    expect(initial.kind).toBe('GET')
    await act(async () => { initial.resolve([]) })
    await waitFor(() => expect(result.current.pinnedSessions).toEqual([]))

    // User pins 'A' optimistically; debounced PUT not yet fired
    act(() => { result.current.setPinnedSessions(['A']) })
    expect(result.current.pinnedSessions).toEqual(['A'])

    // SSE 'ui-state:changed' arrives while the PUT for 'A' is still in the debounce window
    act(() => { sseListener?.() })

    // A new GET request should have been issued
    await waitFor(() => expect(calls.some(c => c.kind === 'GET')).toBe(true))
    const staleGet = calls.find(c => c.kind === 'GET')!
    // Server returns the OLD list (no 'A' yet — our PUT hasn't landed)
    await act(async () => { staleGet.resolve([]) })

    // The optimistic pin must remain visible
    expect(result.current.pinnedSessions).toEqual(['A'])
  })

  it('drops a refetch response that lands while a PUT is in flight', async () => {
    const calls = installFetchStub()

    const { result } = renderHook(() => usePinnedSessions('proj'))

    // Initial GET
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1))
    await act(async () => { calls.shift()!.resolve([]) })
    await waitFor(() => expect(result.current.pinnedSessions).toEqual([]))

    // Optimistic pin + let debounce fire to issue PUT
    act(() => { result.current.setPinnedSessions(['A']) })

    // Wait for the PUT to be issued (debounce window 400ms)
    await waitFor(() => expect(calls.some(c => c.kind === 'PUT')).toBe(true), { timeout: 1000 })
    const putCall = calls.find(c => c.kind === 'PUT')!
    expect(putCall.body).toEqual({ sessions: ['A'] })

    // SSE fires while PUT is still in flight; refetch returns the OLD list
    act(() => { sseListener?.() })
    await waitFor(() => expect(calls.filter(c => c.kind === 'GET').length).toBeGreaterThan(0))
    const staleGet = calls.filter(c => c.kind === 'GET').pop()!
    await act(async () => { staleGet.resolve([]) })

    expect(result.current.pinnedSessions).toEqual(['A'])

    // PUT completes — local state should still be ['A']
    await act(async () => { putCall.resolve(null) })
    expect(result.current.pinnedSessions).toEqual(['A'])
  })

  it('does apply server snapshot when there are no pending local edits', async () => {
    const calls = installFetchStub()

    const { result } = renderHook(() => usePinnedSessions('proj'))

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1))
    await act(async () => { calls.shift()!.resolve(['X']) })
    await waitFor(() => expect(result.current.pinnedSessions).toEqual(['X']))

    // Pure remote update (no local mutation) — SSE arrives
    act(() => { sseListener?.() })
    await waitFor(() => expect(calls.some(c => c.kind === 'GET')).toBe(true))
    const get = calls.find(c => c.kind === 'GET')!
    await act(async () => { get.resolve(['X', 'Y']) })

    await waitFor(() => expect(result.current.pinnedSessions).toEqual(['X', 'Y']))
  })
})
