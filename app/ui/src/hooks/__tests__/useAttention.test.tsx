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

function pushUiStateChanged() {
  const cb = sseListeners.get('ui-state:changed')!
  act(() => { cb({ data: '' } as MessageEvent) })
}

function idleReadyItem(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    generation: 'session_idle:proj::sess:50',
    type: 'session_idle', tier: 'handoff', group: 'ready',
    subject: { kind: 'session', project: 'proj', sessionName: 'sess' },
    title: 'Your turn', message: 'proj · sess', tsMs: 50, count: 1, interrupt: false,
    ...over,
  }
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

  it('still speaks the read-back while HIDDEN (audio is not foreground-gated)', async () => {
    installNotification('granted')
    setHidden(true)
    const onSpeak = vi.fn()
    const calls = installFetchStub()
    renderHook(() => useAttention(null, undefined, onSpeak))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({ needsYou: [crashItem({ interrupt: true })] }))

    // Hidden → OS Notification for the eye, but the read-back still fires for the ear.
    expect(onSpeak).toHaveBeenCalledTimes(1)
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

  it('active-viewing a crash (ACT) still SURFACES a foreground toast but does NOT auto-dismiss it — the Needs-you row stays (§"Active-viewing must not auto-dismiss ACT")', async () => {
    installNotification('granted')
    setHidden(false)
    setFocus(true)
    const calls = installFetchStub()
    // The user is attached to + focused on proj/sess — the interrupt target.
    const { result } = renderHook(() => useAttention({ project: 'proj', sessionName: 'sess' }))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({ needsYou: [crashItem({ interrupt: true })], global: { count: 1, color: 'red' } }))

    // Active-viewing surfaces a foreground toast (not OS); it does not suppress.
    expect(toastCustom).toHaveBeenCalledTimes(1)
    expect(notificationCtor).not.toHaveBeenCalled()

    // Active-view auto-ack is READY-ONLY: an actively-viewed ACT (crash/blocked)
    // row is never auto-acked or auto-dismissed — dismiss is an explicit user-owned
    // tombstone. So no ack/dismiss POST is issued and the Needs-you row stays.
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/attention/ack'))).toBe(false)
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/attention/dismiss'))).toBe(false)
    expect(result.current.snapshot.needsYou).toHaveLength(1)
    expect(result.current.snapshot.needsYou[0].type).toBe('session_crashed')
  })

  it('active-viewing a bound task_done still SURFACES a foreground toast AND auto-acks the TASK (M-medium-1)', async () => {
    installNotification('granted')
    setHidden(false)
    setFocus(true)
    const calls = installFetchStub()
    // The user is attached to + focused on proj/sess, which is one of the task's
    // bound agents — so the task_done interrupt targets the actively-viewed session.
    renderHook(() => useAttention({ project: 'proj', sessionName: 'sess' }))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({
      ready: [crashItem({
        generation: 'task_done:proj::t1:200',
        type: 'task_done', tier: 'handoff', group: 'ready', interrupt: true,
        subject: { kind: 'task', project: 'proj', taskId: 't1', sessionNames: ['sess'] },
      })],
    }))

    // Active-viewing surfaces a foreground toast (not OS); it does not suppress.
    expect(toastCustom).toHaveBeenCalledTimes(1)
    expect(notificationCtor).not.toHaveBeenCalled()

    // Auto-ack POSTed for the TASK (scope=task, key=taskId) — not a session ack,
    // so the bound task_done clears from Ready/badges instead of staying unacked.
    await waitFor(() => expect(
      calls.some(c => c.method === 'POST' && c.url.includes('/attention/ack')
        && c.body && (c.body as { scope: string }).scope === 'task'
        && (c.body as { key: string }).key === 't1'
        && (c.body as { project: string }).project === 'proj'),
    ).toBe(true))
    // And no session-scope ack was issued for this task interrupt.
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/attention/ack')
      && c.body && (c.body as { scope: string }).scope === 'session')).toBe(false)
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

  it('dismissNeedsYou POSTs a generation-exact /attention/dismiss for a SESSION and a TASK row', async () => {
    const calls = installFetchStub()
    const { result } = renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())

    const sessionRow = crashItem({ generation: 'session_blocked:proj::sess:100', type: 'session_blocked' })
    const taskRow: AttentionItem = {
      generation: 'task_blocked:proj::t1:200',
      type: 'task_blocked', tier: 'action', group: 'needs-you',
      subject: { kind: 'task', project: 'proj', taskId: 't1', sessionNames: ['sess'] },
      title: 'Task blocked: t1', message: '', tsMs: 200, count: 1, interrupt: false,
    }

    act(() => { result.current.dismissNeedsYou(sessionRow) })
    act(() => { result.current.dismissNeedsYou(taskRow) })

    const posts = calls.filter(c => c.method === 'POST' && c.url.endsWith('/attention/dismiss'))
    // SESSION row → kind:'session', key=sessionName, carrying the EXACT generation.
    expect(posts.find(c => (c.body as { kind: string }).kind === 'session')?.body)
      .toEqual({ project: 'proj', kind: 'session', key: 'sess', generation: 'session_blocked:proj::sess:100' })
    // TASK row → kind:'task', key=taskId, carrying the EXACT generation.
    expect(posts.find(c => (c.body as { kind: string }).kind === 'task')?.body)
      .toEqual({ project: 'proj', kind: 'task', key: 't1', generation: 'task_blocked:proj::t1:200' })
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

  it('replaces the snapshot from a pushed attention event', async () => {    installNotification('granted')
    const calls = installFetchStub()
    const { result } = renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())

    pushAttention(makeSnapshot({ ready: [crashItem({ type: 'session_idle', tier: 'handoff', group: 'ready', interrupt: false })], global: { count: 1, color: 'yellow' } }))
    await waitFor(() => expect(result.current.snapshot.ready).toHaveLength(1))
    expect(result.current.snapshot.global.color).toBe('yellow')
  })

  it('normalizes a partial/malformed cold feed instead of crashing (missing arrays)', async () => {
    installNotification('granted')
    const calls = installFetchStub()
    const { result } = renderHook(() => useAttention(null))
    // A stale/empty server (or a route mock that doesn't know the endpoint) can
    // return `{}` — ingest must not blow up spreading undefined needsYou/ready.
    await waitFor(() => expect(calls.some(c => c.url.includes('/attention/feed'))).toBe(true))
    const feed = calls.find(c => c.url.includes('/attention/feed'))!
    await act(async () => { feed.resolve({}) })

    expect(result.current.snapshot.needsYou).toEqual([])
    expect(result.current.snapshot.ready).toEqual([])
    expect(result.current.snapshot.recent).toEqual([])
    expect(result.current.snapshot.global).toEqual({ count: 0, color: null })
  })

  it('normalizes a malformed SSE push (partial snapshot) without crashing', async () => {
    installNotification('granted')
    const calls = installFetchStub()
    const { result } = renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot({ needsYou: [crashItem({ interrupt: false })] }))
    await waitFor(() => expect(result.current.snapshot.needsYou).toHaveLength(1))

    // Push a snapshot missing `ready`/`recent`/badges — must coerce to empties.
    const cb = sseListeners.get('attention')!
    act(() => { cb({ data: JSON.stringify({ needsYou: [] }) } as MessageEvent) })

    expect(result.current.snapshot.needsYou).toEqual([])
    expect(result.current.snapshot.ready).toEqual([])
    expect(result.current.snapshot.global).toEqual({ count: 0, color: null })
  })

  // ── F3: engaging a session acks its pending "your turn" ───────────────────────

  it('F3: actively viewing a target acks a matching pending Ready session_idle (no interrupt)', async () => {
    installNotification('granted')
    setHidden(false)
    setFocus(true)
    const calls = installFetchStub()
    // Attached + visible + focused on proj/sess, with a session_idle already
    // sitting in Ready (interrupt:false — it was not a fresh edge, so the ingest
    // auto-ack path never fired). Engaging it must ack it.
    await act(async () => {
      renderHook(() => useAttention({ project: 'proj', sessionName: 'sess' }))
    })
    await settleInitialFeed(calls, makeSnapshot({ ready: [idleReadyItem()] }))

    await waitFor(() => expect(
      calls.some(c => c.method === 'POST' && c.url.includes('/attention/ack')
        && c.body && (c.body as { scope: string }).scope === 'session'
        && (c.body as { key: string }).key === 'sess'
        && (c.body as { project: string }).project === 'proj'),
    ).toBe(true))
  })

  it('F3: a bound task_done in Ready is acked by TASK scope when engaging the bound session', async () => {
    installNotification('granted')
    setHidden(false)
    setFocus(true)
    const calls = installFetchStub()
    renderHook(() => useAttention({ project: 'proj', sessionName: 'sess' }))
    await settleInitialFeed(calls, makeSnapshot({
      ready: [idleReadyItem({
        generation: 'task_done:proj::t1:60', type: 'task_done',
        subject: { kind: 'task', project: 'proj', taskId: 't1', sessionNames: ['sess'] },
      })],
    }))
    await waitFor(() => expect(
      calls.some(c => c.method === 'POST' && c.url.includes('/attention/ack')
        && (c.body as { scope: string }).scope === 'task'
        && (c.body as { key: string }).key === 't1'),
    ).toBe(true))
  })

  it('F3: does NOT ack a Ready item for a session the user is not engaged with', async () => {
    installNotification('granted')
    setHidden(false)
    setFocus(true)
    const calls = installFetchStub()
    renderHook(() => useAttention({ project: 'proj', sessionName: 'other' }))
    await settleInitialFeed(calls, makeSnapshot({ ready: [idleReadyItem()] }))
    // Give effects a chance to run.
    await act(async () => { await Promise.resolve() })
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/attention/ack'))).toBe(false)
  })

  // ── F4: client refreshes on ui-state:changed ──────────────────────────────────

  it('F4: a ui-state:changed SSE event refetches the feed', async () => {
    installNotification('granted')
    const calls = installFetchStub()
    renderHook(() => useAttention(null))
    await settleInitialFeed(calls, makeSnapshot())
    const feedCountBefore = calls.filter(c => c.url.includes('/attention/feed')).length

    pushUiStateChanged()

    await waitFor(() => expect(
      calls.filter(c => c.url.includes('/attention/feed')).length,
    ).toBeGreaterThan(feedCountBefore))
  })

  // ── Headline regression: an ack updates the snapshot WITHOUT a page reload ────

  it('an ack → ui-state:changed → refetch removes the item from the snapshot (no reload)', async () => {
    installNotification('granted')
    const calls = installFetchStub()
    const item = idleReadyItem()
    const { result } = renderHook(() => useAttention(null))
    // Cold feed shows one Ready item.
    await settleInitialFeed(calls, makeSnapshot({ ready: [item], global: { count: 1, color: 'yellow' } }))
    await waitFor(() => expect(result.current.snapshot.ready).toHaveLength(1))

    // User acks it; the server merges the watermark and broadcasts ui-state:changed.
    act(() => { result.current.ackSession('proj', 'sess') })
    pushUiStateChanged()

    // The F4 refetch hits /feed again — resolve it with the post-ack snapshot
    // (item gone). The client reflects it WITHOUT a page reload.
    await waitFor(() => expect(calls.filter(c => c.url.includes('/attention/feed')).length).toBeGreaterThan(1))
    const refetch = calls.filter(c => c.url.includes('/attention/feed')).at(-1)!
    await act(async () => { refetch.resolve({ ...makeSnapshot(), nextBefore: null }) })

    await waitFor(() => expect(result.current.snapshot.ready).toHaveLength(0))
    expect(result.current.snapshot.global).toEqual({ count: 0, color: null })
  })

  // ── F3: ack-on-attach re-runs on window focus regain ──────────────────────────

  it('F3: regaining window focus on an attached target acks its pending Ready session_idle', async () => {
    installNotification('granted')
    setHidden(false)
    setFocus(false) // window starts BLURRED → ack-on-attach must NOT fire yet
    const calls = installFetchStub()
    // Attached + visible but blurred, with a matching session_idle already in Ready.
    renderHook(() => useAttention({ project: 'proj', sessionName: 'sess' }))
    await settleInitialFeed(calls, makeSnapshot({ ready: [idleReadyItem()] }))

    // Blurred → no ack yet (the engage effect bails on document.hasFocus() === false).
    await act(async () => { await Promise.resolve() })
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/attention/ack'))).toBe(false)

    // The window regains focus (document.hasFocus() now true) → the ack-on-attach
    // effect re-runs via the focus listener and acks the pending "your turn".
    setFocus(true)
    act(() => { window.dispatchEvent(new Event('focus')) })

    await waitFor(() => expect(
      calls.some(c => c.method === 'POST' && c.url.includes('/attention/ack')
        && c.body && (c.body as { scope: string }).scope === 'session'
        && (c.body as { key: string }).key === 'sess'
        && (c.body as { project: string }).project === 'proj'),
    ).toBe(true))
  })

  // ── F4: out-of-order full-snapshot refreshes ignore the stale (earlier) request ─

  it('F4: an earlier full-feed refetch resolving LAST is ignored; the latest request wins', async () => {
    installNotification('granted')
    const calls = installFetchStub()
    const { result } = renderHook(() => useAttention(null))
    // Settle the cold mount so the snapshot has a known empty baseline.
    await settleInitialFeed(calls, makeSnapshot())
    const baseFeedCount = calls.filter(c => c.url.includes('/attention/feed')).length

    // Two overlapping full-snapshot refreshes (each ui-state:changed triggers a
    // loadFeed() with before==null, so both are versioned).
    pushUiStateChanged() // request A (issued first, older version)
    await waitFor(() => expect(
      calls.filter(c => c.url.includes('/attention/feed')).length,
    ).toBe(baseFeedCount + 1))
    pushUiStateChanged() // request B (issued second, newer version)
    await waitFor(() => expect(
      calls.filter(c => c.url.includes('/attention/feed')).length,
    ).toBe(baseFeedCount + 2))

    const feeds = calls.filter(c => c.url.includes('/attention/feed'))
    const reqA = feeds.at(-2)!
    const reqB = feeds.at(-1)!

    // Resolve out of order: the LATER-issued request B resolves FIRST, then the
    // stale request A resolves LAST. The newer data must win, and the stale
    // response must be dropped (version mismatch).
    await act(async () => {
      reqB.resolve({ ...makeSnapshot({ ready: [idleReadyItem()], global: { count: 1, color: 'yellow' } }), nextBefore: null })
    })
    await waitFor(() => expect(result.current.snapshot.ready).toHaveLength(1))

    await act(async () => {
      reqA.resolve({ ...makeSnapshot({ needsYou: [crashItem({ interrupt: false })], global: { count: 9, color: 'red' } }), nextBefore: null })
    })
    // Stale A is ignored — the snapshot still reflects B's data.
    await act(async () => { await Promise.resolve() })
    expect(result.current.snapshot.ready).toHaveLength(1)
    expect(result.current.snapshot.needsYou).toHaveLength(0)
    expect(result.current.snapshot.global).toEqual({ count: 1, color: 'yellow' })
  })
})
