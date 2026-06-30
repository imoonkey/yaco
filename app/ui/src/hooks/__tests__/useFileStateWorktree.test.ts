// @vitest-environment jsdom
//
// Per-worktree file-state projection (design §P3 file-content keying). These pin
// the load-bearing contract directly on useFileState:
//   1. `files` / `filesRef.current` project the ACTIVE worktree's bucket, so every
//      relpath consumer sees the selected worktree transparently; a draft is kept
//      per worktree and restored on return.
//   2. a content fetch that resolves AFTER a worktree switch is dropped — worktree
//      A's bytes never leak into worktree B's view (the captured-worktree + abort
//      race guard is the whole point).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'

// useFileState wires useSSERefresh (opens an EventSource jsdom lacks). Stub it and
// capture the 'filetree' callback so a test can drive an SSE refetch manually.
let sseCallback: (() => void) | null = null
vi.mock('../useSSE', () => ({
  useSSERefresh: (_channel: string, cb: () => void) => { sseCallback = cb },
  addSSEListener: () => () => {},
}))

import { useFileState } from '../useFileState'
import type { PersistedDraftsByWorktree } from '../workspaceTypes'

const PROJECT_PATH = '/repo/proj'
const NO_DRAFTS: PersistedDraftsByWorktree = {}

beforeEach(() => {
  // Default: nothing in flight. Individual tests that need deferred control re-stub.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sseCallback = null })

function mount(openTabs: string[]) {
  const openTabsRef = { current: openTabs }
  return renderHook(
    ({ wt }: { wt: string | null }) => useFileState('proj', PROJECT_PATH, wt, NO_DRAFTS, openTabs, openTabsRef),
    { initialProps: { wt: null as string | null } },
  )
}

describe('useFileState active-worktree projection', () => {
  it('projects the active bucket via files + filesRef; drafts are per-worktree and restored on return', () => {
    const { result, rerender } = mount([])

    // Edit on the primary view (worktree = null).
    act(() => { result.current.updateDraft('a.ts', 'primary-edit') })
    expect(result.current.files['a.ts'].draft).toBe('primary-edit')
    // filesRef.current is the SAME projection object every relpath consumer reads.
    expect(result.current.filesRef.current).toBe(result.current.files)
    expect(result.current.filesRef.current['a.ts'].draft).toBe('primary-edit')
    expect(result.current.dirtyTabs.has('a.ts')).toBe(true)

    // Switch to worktree B: its bucket is empty — A's draft is NOT visible here.
    rerender({ wt: '/wt/B' })
    expect(result.current.files['a.ts']).toBeUndefined()
    expect(result.current.filesRef.current).toBe(result.current.files)
    expect(result.current.dirtyTabs.has('a.ts')).toBe(false)

    // Edit a different path on B — it lands in B's bucket only.
    act(() => { result.current.updateDraft('b.ts', 'b-edit') })
    expect(result.current.files['b.ts'].draft).toBe('b-edit')
    expect(result.current.files['a.ts']).toBeUndefined()

    // Return to primary: A's draft is restored; B's draft is not visible.
    rerender({ wt: null })
    expect(result.current.files['a.ts'].draft).toBe('primary-edit')
    expect(result.current.files['b.ts']).toBeUndefined()
    expect(result.current.dirtyTabs.has('a.ts')).toBe(true)
  })

  it('drops a content fetch that resolves after a worktree switch (no cross-worktree leak)', async () => {
    type Pending = { url: string; resolve: (data: unknown) => void }
    const pending: Pending[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise(res => {
      pending.push({ url: String(url), resolve: (data) => res({ ok: true, status: 200, json: () => Promise.resolve(data) }) })
    })))

    const openTabs = ['a.ts']
    const openTabsRef = { current: openTabs }
    const { result, rerender } = renderHook(
      ({ wt }: { wt: string | null }) => useFileState('proj', PROJECT_PATH, wt, NO_DRAFTS, openTabs, openTabsRef),
      { initialProps: { wt: null as string | null } },
    )

    // Mount hydration issued a content fetch for the primary view (no ?worktree=).
    await waitFor(() => expect(pending.some(p => p.url.includes('/content') && !p.url.includes('worktree='))).toBe(true))
    const primaryFetch = pending.find(p => p.url.includes('/content') && !p.url.includes('worktree='))!

    // Switch to worktree B before the primary fetch resolves — re-fetches for B.
    rerender({ wt: '/wt/B' })
    await waitFor(() => expect(pending.some(p => p.url.includes('/content') && p.url.includes('worktree='))).toBe(true))
    const bFetch = pending.find(p => p.url.includes('/content') && p.url.includes('worktree='))!

    // B resolves first → its bytes are shown.
    await act(async () => { bFetch.resolve({ content: 'B-bytes', revision: 2 }) })
    expect(result.current.files['a.ts'].serverContent).toBe('B-bytes')

    // The stale primary fetch resolves LAST — it must be dropped, not leaked into B.
    await act(async () => { primaryFetch.resolve({ content: 'PRIMARY-bytes', revision: 1 }) })
    expect(result.current.files['a.ts'].serverContent).toBe('B-bytes')

    // Returning to primary re-fetches (re-entry), proving the drop didn't strand it.
    rerender({ wt: null })
    await waitFor(() =>
      expect(pending.filter(p => p.url.includes('/content') && !p.url.includes('worktree=')).length).toBe(2),
    )
  })

  it('drops a stale SSE refetch via the captured-key check alone (its controller is not aborted by the switch)', async () => {
    type Pending = { url: string; resolve: (data: unknown) => void }
    const pending: Pending[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise(res => {
      pending.push({ url: String(url), resolve: (data) => res({ ok: true, status: 200, json: () => Promise.resolve(data) }) })
    })))
    const grab = (pred: (u: string) => boolean): Pending => {
      const i = pending.findIndex(p => pred(p.url))
      if (i < 0) throw new Error('no pending fetch matched')
      return pending.splice(i, 1)[0]
    }

    const openTabs = ['a.ts']
    const openTabsRef = { current: openTabs }
    const { result, rerender } = renderHook(
      ({ wt }: { wt: string | null }) => useFileState('proj', PROJECT_PATH, wt, NO_DRAFTS, openTabs, openTabsRef),
      { initialProps: { wt: null as string | null } },
    )

    // Settle the primary mount hydration so it isn't confused with the SSE refetch.
    await waitFor(() => expect(pending.some(p => !p.url.includes('worktree='))).toBe(true))
    await act(async () => { grab(u => !u.includes('worktree=')).resolve({ content: 'P0', revision: 1 }) })

    // Fire an SSE refetch on the PRIMARY view — this uses the SSE controller, which a
    // worktree switch does NOT abort (only the next SSE cycle would). Hold it open.
    act(() => { sseCallback?.() })
    await waitFor(() => expect(pending.some(p => !p.url.includes('worktree='))).toBe(true))
    const staleSseRefetch = grab(u => !u.includes('worktree='))

    // Switch to B and resolve B's hydration → B's bytes are shown.
    rerender({ wt: '/wt/B' })
    await waitFor(() => expect(pending.some(p => p.url.includes('worktree='))).toBe(true))
    await act(async () => { grab(u => u.includes('worktree=')).resolve({ content: 'B-bytes', revision: 9 }) })
    expect(result.current.files['a.ts'].serverContent).toBe('B-bytes')

    // The stale primary SSE refetch resolves LAST. Its AbortController was never
    // aborted by the switch, so ONLY the captured worktree-key check can drop it.
    await act(async () => { staleSseRefetch.resolve({ content: 'STALE-primary', revision: 2 }) })
    expect(result.current.files['a.ts'].serverContent).toBe('B-bytes')
  })

  // #3a (design code-review_p3-persistence-schema #3a): accept-disk is an explicit
  // action on a captured (worktree, path). Under the no-remount flip there is no reload
  // to recover a dropped accept, so it must complete into the CAPTURED bucket even when
  // the user switches worktrees before the disk read resolves. It rides a mount-lifetime
  // controller, not the per-worktree epoch — the switch neither aborts it nor fails a
  // captured-key guard.
  it('lands acceptDisk in the captured worktree bucket even after a switch (#3a)', async () => {
    type Pending = { url: string; resolve: (data: unknown) => void }
    const pending: Pending[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise(res => {
      pending.push({ url: String(url), resolve: (data) => res({ ok: true, status: 200, json: () => Promise.resolve(data) }) })
    })))

    const openTabsRef = { current: [] as string[] }
    const { result, rerender } = renderHook(
      ({ wt }: { wt: string | null }) => useFileState('proj', PROJECT_PATH, wt, NO_DRAFTS, [], openTabsRef),
      { initialProps: { wt: null as string | null } },
    )

    // A local edit on the primary view, then accept-disk it (captures the primary key).
    act(() => { result.current.updateDraft('a.ts', 'local-edit') })
    expect(result.current.files['a.ts'].draft).toBe('local-edit')
    act(() => { result.current.acceptDisk('a.ts') })
    await waitFor(() => expect(pending.some(p => p.url.includes('/content') && !p.url.includes('worktree='))).toBe(true))
    const acceptFetch = pending.find(p => p.url.includes('/content') && !p.url.includes('worktree='))!

    // Switch to worktree B BEFORE the disk read resolves — the old code aborted it on
    // the epoch controller and/or failed its captured-key guard, dropping the accept.
    rerender({ wt: '/wt/B' })
    await act(async () => { acceptFetch.resolve({ content: 'disk-bytes', revision: 7 }) })

    // Back on primary: the accept landed — draft cleared, disk bytes applied, clean.
    rerender({ wt: null })
    expect(result.current.files['a.ts'].draft).toBeNull()
    expect(result.current.files['a.ts'].serverContent).toBe('disk-bytes')
    expect(result.current.dirtyTabs.has('a.ts')).toBe(false)
  })

  it('clears a conflict immediately from the cached disk version while refresh is pending', async () => {
    type Pending = { url: string; resolve: (data: unknown) => void }
    const pending: Pending[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise(res => {
      pending.push({ url: String(url), resolve: (data) => res({ ok: true, status: 200, json: () => Promise.resolve(data) }) })
    })))
    const grab = (pred: (u: string) => boolean): Pending => {
      const i = pending.findIndex(p => pred(p.url))
      if (i < 0) throw new Error('no pending fetch matched')
      return pending.splice(i, 1)[0]
    }

    const openTabs = ['a.ts']
    const openTabsRef = { current: openTabs }
    const { result } = renderHook(
      () => useFileState('proj', PROJECT_PATH, null, NO_DRAFTS, openTabs, openTabsRef),
    )

    await waitFor(() => expect(pending.some(p => p.url.includes('/content'))).toBe(true))
    await act(async () => { grab(u => u.includes('/content')).resolve({ content: 'base', revision: 1 }) })
    act(() => { result.current.updateDraft('a.ts', 'mine') })

    act(() => { sseCallback?.() })
    await waitFor(() => expect(pending.some(p => p.url.includes('/content'))).toBe(true))
    await act(async () => { grab(u => u.includes('/content')).resolve({ content: 'disk', revision: 2 }) })
    expect(result.current.conflictTabs.has('a.ts')).toBe(true)

    act(() => { result.current.acceptDisk('a.ts') })
    expect(result.current.files['a.ts'].draft).toBeNull()
    expect(result.current.files['a.ts'].serverContent).toBe('disk')
    expect(result.current.files['a.ts'].baseRevision).toBe(2)
    expect(result.current.conflictTabs.has('a.ts')).toBe(false)
    expect(result.current.dirtyTabs.has('a.ts')).toBe(false)
    expect(pending.some(p => p.url.includes('/content'))).toBe(true)
  })

  it('does not let acceptDisk refresh discard edits typed after the cached accept', async () => {
    type Pending = { url: string; resolve: (data: unknown) => void }
    const pending: Pending[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise(res => {
      pending.push({ url: String(url), resolve: (data) => res({ ok: true, status: 200, json: () => Promise.resolve(data) }) })
    })))
    const grab = (pred: (u: string) => boolean): Pending => {
      const i = pending.findIndex(p => pred(p.url))
      if (i < 0) throw new Error('no pending fetch matched')
      return pending.splice(i, 1)[0]
    }

    const openTabs = ['a.ts']
    const openTabsRef = { current: openTabs }
    const { result } = renderHook(
      () => useFileState('proj', PROJECT_PATH, null, NO_DRAFTS, openTabs, openTabsRef),
    )

    await waitFor(() => expect(pending.some(p => p.url.includes('/content'))).toBe(true))
    await act(async () => { grab(u => u.includes('/content')).resolve({ content: 'base', revision: 1 }) })
    act(() => { result.current.updateDraft('a.ts', 'mine') })
    act(() => { sseCallback?.() })
    await waitFor(() => expect(pending.some(p => p.url.includes('/content'))).toBe(true))
    await act(async () => { grab(u => u.includes('/content')).resolve({ content: 'disk', revision: 2 }) })
    act(() => { result.current.acceptDisk('a.ts') })
    act(() => { result.current.updateDraft('a.ts', 'new edit') })

    await act(async () => { grab(u => u.includes('/content')).resolve({ content: 'disk', revision: 2 }) })

    expect(result.current.files['a.ts'].draft).toBe('new edit')
    expect(result.current.files['a.ts'].serverContent).toBe('disk')
    expect(result.current.files['a.ts'].baseRevision).toBe(2)
    expect(result.current.dirtyTabs.has('a.ts')).toBe(true)
  })

  it('does not let acceptDisk refresh roll back a save completed after cached accept', async () => {
    type Pending = { url: string; init?: RequestInit; resolve: (data: unknown) => void }
    const pending: Pending[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise(res => {
      pending.push({ url: String(url), init, resolve: (data) => res({ ok: true, status: 200, json: () => Promise.resolve(data) }) })
    })))
    const grab = (pred: (p: Pending) => boolean): Pending => {
      const i = pending.findIndex(pred)
      if (i < 0) throw new Error('no pending fetch matched')
      return pending.splice(i, 1)[0]
    }

    const openTabs = ['a.ts']
    const openTabsRef = { current: openTabs }
    const { result } = renderHook(
      () => useFileState('proj', PROJECT_PATH, null, NO_DRAFTS, openTabs, openTabsRef),
    )

    await waitFor(() => expect(pending.some(p => p.url.includes('/content'))).toBe(true))
    await act(async () => { grab(p => p.url.includes('/content')).resolve({ content: 'base', revision: 1 }) })
    act(() => { result.current.updateDraft('a.ts', 'mine') })
    act(() => { sseCallback?.() })
    await waitFor(() => expect(pending.some(p => p.url.includes('/content'))).toBe(true))
    await act(async () => { grab(p => p.url.includes('/content')).resolve({ content: 'disk', revision: 2 }) })
    act(() => { result.current.acceptDisk('a.ts') })
    act(() => { result.current.updateDraft('a.ts', 'saved-after-accept') })

    await act(async () => {
      const savePromise = result.current.save('a.ts', 'saved-after-accept')
      await waitFor(() => expect(pending.some(p => p.init?.method === 'PUT')).toBe(true))
      grab(p => p.init?.method === 'PUT').resolve({ revision: 3 })
      await savePromise
    })
    expect(result.current.files['a.ts'].serverContent).toBe('saved-after-accept')
    expect(result.current.files['a.ts'].baseRevision).toBe(3)

    await act(async () => { grab(p => p.url.includes('/content') && !p.init?.method).resolve({ content: 'disk', revision: 2 }) })

    expect(result.current.files['a.ts'].serverContent).toBe('saved-after-accept')
    expect(result.current.files['a.ts'].baseRevision).toBe(3)
    expect(result.current.files['a.ts'].draft).toBeNull()
    expect(result.current.dirtyTabs.has('a.ts')).toBe(false)
  })

  it('waits for disk content after a save-time 409 before accepting disk', async () => {
    type Pending = { url: string; init?: RequestInit; resolve: (res: Response) => void }
    const pending: Pending[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>(res => {
      pending.push({ url: String(url), init, resolve: res })
    })))
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const grab = (pred: (p: Pending) => boolean): Pending => {
      const i = pending.findIndex(pred)
      if (i < 0) throw new Error('no pending fetch matched')
      return pending.splice(i, 1)[0]
    }

    const openTabs = ['a.ts']
    const openTabsRef = { current: openTabs }
    const { result } = renderHook(
      () => useFileState('proj', PROJECT_PATH, null, NO_DRAFTS, openTabs, openTabsRef),
    )

    await waitFor(() => expect(pending.some(p => p.url.includes('/content'))).toBe(true))
    await act(async () => { grab(p => p.url.includes('/content')).resolve(ok({ content: 'base', revision: 1 })) })
    act(() => { result.current.updateDraft('a.ts', 'mine') })

    await act(async () => {
      const savePromise = result.current.save('a.ts', 'mine')
      await waitFor(() => expect(pending.some(p => p.init?.method === 'PUT')).toBe(true))
      grab(p => p.init?.method === 'PUT').resolve(new Response(JSON.stringify({ error: 'revision conflict', currentRevision: 2 }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
      await savePromise
    })
    expect(result.current.files['a.ts'].status).toBe('conflict')
    expect(result.current.files['a.ts'].serverContent).toBe('base')
    expect(result.current.files['a.ts'].serverRevision).toBe(1)

    act(() => { result.current.acceptDisk('a.ts') })
    expect(result.current.files['a.ts'].status).toBe('conflict')
    expect(result.current.files['a.ts'].draft).toBe('mine')

    await act(async () => { grab(p => p.url.includes('/content') && !p.init?.method).resolve(ok({ content: 'disk-after-409', revision: 2 })) })

    expect(result.current.files['a.ts'].status).toBe('clean')
    expect(result.current.files['a.ts'].draft).toBeNull()
    expect(result.current.files['a.ts'].serverContent).toBe('disk-after-409')
    expect(result.current.files['a.ts'].baseRevision).toBe(2)
  })

  it('marks a cached accept missing when the follow-up disk read returns 404', async () => {
    type Pending = { url: string; resolve: (res: Response) => void }
    const pending: Pending[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>(res => {
      pending.push({ url: String(url), resolve: res })
    })))
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const grab = (pred: (u: string) => boolean): Pending => {
      const i = pending.findIndex(p => pred(p.url))
      if (i < 0) throw new Error('no pending fetch matched')
      return pending.splice(i, 1)[0]
    }

    const openTabs = ['a.ts']
    const openTabsRef = { current: openTabs }
    const { result } = renderHook(
      () => useFileState('proj', PROJECT_PATH, null, NO_DRAFTS, openTabs, openTabsRef),
    )

    await waitFor(() => expect(pending.some(p => p.url.includes('/content'))).toBe(true))
    await act(async () => { grab(u => u.includes('/content')).resolve(ok({ content: 'base', revision: 1 })) })
    act(() => { result.current.updateDraft('a.ts', 'mine') })
    act(() => { sseCallback?.() })
    await waitFor(() => expect(pending.some(p => p.url.includes('/content'))).toBe(true))
    await act(async () => { grab(u => u.includes('/content')).resolve(ok({ content: 'disk', revision: 2 })) })

    act(() => { result.current.acceptDisk('a.ts') })
    await act(async () => { grab(u => u.includes('/content')).resolve(new Response(null, { status: 404 })) })

    expect(result.current.files['a.ts'].status).toBe('missing')
    expect(result.current.files['a.ts'].draft).toBeNull()
  })
})
