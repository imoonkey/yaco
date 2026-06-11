// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import type { AttentionItem, AttentionSnapshot } from '../useAttention'

// ── SSE mock ─────────────────────────────────────────────────────────────────
// Capture the 'attention' SSE listener so a test can push a snapshot, exactly as
// the engine would over EventSource (hidden-safe — delivered even when hidden).
const sseListeners = new Map<string, (e: MessageEvent) => void>()
vi.mock('../useSSE', () => ({
  addSSEListener: (event: string, cb: (e: MessageEvent) => void) => {
    sseListeners.set(event, cb)
    return () => { sseListeners.delete(event) }
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

// Toast spy — assert toast fired / suppressed without rendering sonner.
const toastCustom = vi.fn()
vi.mock('sonner', () => ({ toast: { custom: (...a: unknown[]) => toastCustom(...a), dismiss: vi.fn() } }))

const { useAttention } = await import('../useAttention')

// ── fetch stub ───────────────────────────────────────────────────────────────
interface Call { url: string; method: string; body?: unknown; resolve: (data: unknown) => void }

function installFetchStub(): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    return new Promise<unknown>((resolve) => {
      calls.push({
        url, method, body,
        resolve: (data: unknown) => resolve({
          ok: true,
          status: method === 'GET' ? 200 : 204,
          json: () => Promise.resolve(data),
        }),
      })
    })
  }))
  return calls
}

// ── Notification mock ─────────────────────────────────────────────────────────
let notificationCtor: ReturnType<typeof vi.fn>
let requestPermission: ReturnType<typeof vi.fn>

function installNotification(permission: NotificationPermission) {
  notificationCtor = vi.fn(function (this: Record<string, unknown>) { this.close = vi.fn() })
  requestPermission = vi.fn(() => Promise.resolve('granted' as NotificationPermission))
  ;(notificationCtor as unknown as { permission: NotificationPermission }).permission = permission
  ;(notificationCtor as unknown as { requestPermission: typeof requestPermission }).requestPermission = requestPermission
  vi.stubGlobal('Notification', notificationCtor)
}

// ── document.hidden / hasFocus control ─────────────────────────────────────────
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible', configurable: true,
  })
}
function setFocus(focused: boolean) {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
}

// ── snapshot fixtures ──────────────────────────────────────────────────────────
const emptyBadge = { count: 0, color: null as null }
function makeSnapshot(over: Partial<AttentionSnapshot> = {}): AttentionSnapshot {
  return {
    needsYou: [], ready: [], recent: [],
    badgesByProject: {}, badgesBySession: {}, global: emptyBadge,
    ...over,
  }
}
function crashItem(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    generation: 'session_crashed:proj::sess:100',
    type: 'session_crashed', tier: 'critical', group: 'needs-you',
    subject: { kind: 'session', project: 'proj', sessionName: 'sess' },
    title: 'Crashed', message: 'exit 1', tsMs: 100, count: 1, interrupt: true,
    ...over,
  }
}

async function settleInitialFeed(calls: Call[], snapshot: AttentionSnapshot) {
  await waitFor(() => expect(calls.some(c => c.url.includes('/attention/feed'))).toBe(true))
  const feed = calls.find(c => c.url.includes('/attention/feed'))!
  await act(async () => { feed.resolve({ ...snapshot, nextBefore: null }) })
}

function pushAttention(snapshot: AttentionSnapshot) {
  const cb = sseListeners.get('attention')!
  act(() => { cb({ data: JSON.stringify(snapshot) } as MessageEvent) })
}

beforeEach(() => {
  toastCustom.mockReset()
  setHidden(false)
  setFocus(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sseListeners.clear()
})

describe('useAttention', () => {
  it('does NOT call Notification.requestPermission on mount (M13)', async () => {
    installNotification('default')
    const calls = installFetchStub()
    renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('requestPermission action calls Notification.requestPermission (user gesture only)', async () => {
    installNotification('default')
    const calls = installFetchStub()
    const { result } = renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())
    expect(requestPermission).not.toHaveBeenCalled()
    act(() => { result.current.requestPermission() })
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('initial feed fetch populates the snapshot', async () => {
    installNotification('granted')
    const calls = installFetchStub()
    const snapshot = makeSnapshot({
      needsYou: [crashItem({ interrupt: false })],
      global: { count: 1, color: 'red' },
    })
    const { result } = renderHook(() => useAttention(null))
    await settleInitialFeed(calls, snapshot)
    await waitFor(() => expect(result.current.snapshot.needsYou).toHaveLength(1))
    expect(result.current.snapshot.global).toEqual({ count: 1, color: 'red' })
  })

  it('fires OS Notification for an interrupt item while the tab is HIDDEN (C1, hidden-safe)', async () => {
    installNotification('granted')
    setHidden(true)
    const calls = installFetchStub()
    renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({ needsYou: [crashItem({ interrupt: true })] }))

    expect(notificationCtor).toHaveBeenCalledTimes(1)
    expect(toastCustom).not.toHaveBeenCalled()
  })

  it('does NOT fire an OS Notification when permission is not granted', async () => {
    installNotification('default')
    setHidden(true)
    const calls = installFetchStub()
    renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({ needsYou: [crashItem({ interrupt: true })] }))
    expect(notificationCtor).not.toHaveBeenCalled()
  })

  it('fires a toast (not OS) for an interrupt item while visible', async () => {
    installNotification('granted')
    setHidden(false)
    const calls = installFetchStub()
    renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({ needsYou: [crashItem({ interrupt: true })] }))
    expect(toastCustom).toHaveBeenCalledTimes(1)
    expect(notificationCtor).not.toHaveBeenCalled()
  })

  it('does not interrupt for non-interrupt items', async () => {
    installNotification('granted')
    setHidden(true)
    const calls = installFetchStub()
    renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({ needsYou: [crashItem({ interrupt: false })] }))
    expect(notificationCtor).not.toHaveBeenCalled()
    expect(toastCustom).not.toHaveBeenCalled()
  })

  it('coalesces a burst: dedupes by generation across pushes (§10.5)', async () => {
    installNotification('granted')
    setHidden(true)
    const calls = installFetchStub()
    renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())

    const item = crashItem({ interrupt: true })
    pushAttention(makeSnapshot({ needsYou: [item] }))
    // Same generation re-pushed (reconnect / re-projection) must not re-toast.
    pushAttention(makeSnapshot({ needsYou: [item] }))
    expect(notificationCtor).toHaveBeenCalledTimes(1)
  })

  it('collapses a multi-item burst into a single summary OS notification (§10.5)', async () => {
    installNotification('granted')
    setHidden(true)
    const calls = installFetchStub()
    renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({
      needsYou: [
        crashItem({ generation: 'g1', interrupt: true, subject: { kind: 'session', project: 'proj', sessionName: 's1' } }),
        crashItem({ generation: 'g2', interrupt: true, subject: { kind: 'session', project: 'proj', sessionName: 's2' } }),
        crashItem({ generation: 'g3', interrupt: true, subject: { kind: 'session', project: 'proj', sessionName: 's3' } }),
      ],
    }))
    // A burst collapses to one summary notification rather than three.
    expect(notificationCtor).toHaveBeenCalledTimes(1)
  })

  it('active-viewing suppresses the toast/OS AND auto-acks the session (M10, §5.5)', async () => {
    installNotification('granted')
    setHidden(false)
    setFocus(true)
    const calls = installFetchStub()
    // The user is attached to + focused on proj/sess — the interrupt target.
    renderHook(() => useAttention({ project: 'proj', sessionName: 'sess' }))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({ needsYou: [crashItem({ interrupt: true })] }))

    // No toast / OS for the actively-viewed target.
    expect(toastCustom).not.toHaveBeenCalled()
    expect(notificationCtor).not.toHaveBeenCalled()

    // Auto-ack POSTed for that session's generation.
    await waitFor(() => expect(
      calls.some(c => c.method === 'POST' && c.url.includes('/attention/ack')
        && c.body && (c.body as { scope: string }).scope === 'session'
        && (c.body as { key: string }).key === 'sess'),
    ).toBe(true))
  })

  it('does NOT suppress when window is blurred even if visible+attached (window focus, M10)', async () => {
    installNotification('granted')
    setHidden(false)
    setFocus(false) // blurred — not actively viewing
    const calls = installFetchStub()
    renderHook(() => useAttention({ project: 'proj', sessionName: 'sess' }))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({ needsYou: [crashItem({ interrupt: true })] }))
    // Blurred → still surfaces (toast, since visible).
    expect(toastCustom).toHaveBeenCalledTimes(1)
  })

  it('ackProject / ackSession / ackTask / clear POST the right endpoints', async () => {
    installNotification('granted')
    const calls = installFetchStub()
    const { result } = renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())

    act(() => { result.current.ackProject('proj') })
    act(() => { result.current.ackSession('proj', 'sess') })
    act(() => { result.current.ackTask('proj', 't1') })
    act(() => { result.current.clear('proj') })

    const posts = calls.filter(c => c.method === 'POST')
    expect(posts.find(c => c.url.endsWith('/attention/ack') && (c.body as { scope: string }).scope === 'project')?.body)
      .toEqual({ scope: 'project', project: 'proj' })
    expect(posts.find(c => c.url.endsWith('/attention/ack') && (c.body as { scope: string }).scope === 'session')?.body)
      .toEqual({ scope: 'session', project: 'proj', key: 'sess' })
    expect(posts.find(c => c.url.endsWith('/attention/ack') && (c.body as { scope: string }).scope === 'task')?.body)
      .toEqual({ scope: 'task', project: 'proj', key: 't1' })
    expect(posts.find(c => c.url.endsWith('/attention/clear'))?.body).toEqual({ project: 'proj' })
  })

  it('refetches the feed on visibilitychange → visible', async () => {
    installNotification('granted')
    const calls = installFetchStub()
    renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())
    const feedCountBefore = calls.filter(c => c.url.includes('/attention/feed')).length

    setHidden(false)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })

    await waitFor(() => expect(
      calls.filter(c => c.url.includes('/attention/feed')).length,
    ).toBeGreaterThan(feedCountBefore))
  })

  it('replaces the snapshot from a pushed attention event', async () => {
    installNotification('granted')
    const calls = installFetchStub()
    const { result } = renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({ ready: [crashItem({ type: 'session_idle', tier: 'handoff', group: 'ready', interrupt: false })], global: { count: 1, color: 'yellow' } }))
    await waitFor(() => expect(result.current.snapshot.ready).toHaveLength(1))
    expect(result.current.snapshot.global.color).toBe('yellow')
  })
})
