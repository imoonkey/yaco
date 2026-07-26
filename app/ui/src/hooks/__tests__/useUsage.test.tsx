// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

interface FetchCall {
  url: string
  method: string
  resolve: (payload: unknown, ok?: boolean) => void
}

const calls: FetchCall[] = []

function okResponse(payload: unknown, ok = true): { ok: boolean; json: () => Promise<unknown> } {
  return { ok, json: () => Promise.resolve(payload) }
}

beforeEach(() => {
  calls.length = 0
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn((input, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const method = init?.method ?? 'GET'
    return new Promise((resolve) => {
      calls.push({
        url,
        method,
        resolve: (payload, ok = true) => resolve(okResponse(payload, ok)),
      })
    })
  }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const cachedUsage = [{
  provider: 'claude',
  checkedAt: '2026-07-25T11:00:00.000Z',
  windows: [{ window: 'session', percent: 10 }],
}]

const refreshedUsage = [{
  provider: 'claude',
  checkedAt: '2026-07-25T11:05:00.000Z',
  windows: [{ window: 'session', percent: 80 }],
}]

describe('useUsage polling/refresh race handling', () => {
  it('keeps cached usage visible while manual refresh is in-flight and drops overlapping poll responses', async () => {
    const { useUsage } = await import('../useApi')

    const { result } = renderHook(() => useUsage())

    expect(calls.length).toBe(1)
    await act(async () => {
      calls[0].resolve(cachedUsage)
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.data).toEqual(cachedUsage)
    expect(result.current.refreshing).toBe(false)

    let refreshPromise = Promise.resolve()
    await act(async () => {
      refreshPromise = result.current.refresh()
    })
    expect(result.current.refreshing).toBe(true)

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(calls.length).toBe(2)

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.data).toEqual(cachedUsage)

    await act(async () => {
      calls[1].resolve(refreshedUsage)
      await refreshPromise
    })

    expect(result.current.data).toEqual(refreshedUsage)
    expect(result.current.refreshing).toBe(false)
    expect(calls[1].url).toContain('/api/usage/refresh')
    expect(calls).toHaveLength(2)
  })
})
