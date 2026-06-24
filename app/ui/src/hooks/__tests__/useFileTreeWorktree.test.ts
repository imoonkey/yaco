// @vitest-environment jsdom
//
// useFileTree per-worktree race guard (design §P3 race guards, r2 §C). A directory
// expand issued for worktree A that resolves AFTER a switch to worktree B must be
// dropped — worktree A's children never merge into worktree B's tree. The captured-
// worktree check is what catches a child fetch that resolved just before the epoch
// abort fired (the resolved-then-switched race the AbortController alone can't).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import type { FileNode } from '../../types'

// useFileTree wires useSSERefresh (opens an EventSource jsdom lacks). Stub it.
vi.mock('../useSSE', () => ({
  useSSERefresh: () => {},
  addSSEListener: () => () => {},
}))

import { useFileTree } from '../useApi'

type Pending = { url: string; resolve: (data: unknown) => void; fail: () => void }
let pending: Pending[]

beforeEach(() => {
  pending = []
  vi.stubGlobal('fetch', vi.fn((url: string) => new Promise(res => {
    pending.push({
      url: String(url),
      resolve: (data) => res({ ok: true, status: 200, json: () => Promise.resolve(data) }),
      // A non-ok response makes fetchJson throw a (non-Abort) ApiError → catch path.
      fail: () => res({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    })
  })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const dir = (path: string, children: FileNode[] = []): FileNode => ({ name: path.split('/').pop()!, path, type: 'dir', children })
const file = (path: string): FileNode => ({ name: path.split('/').pop()!, path, type: 'file' })

const isRoot = (p: Pending) => !p.url.includes('/children') && !p.url.includes('/content')
const isChild = (p: Pending) => p.url.includes('/children')
const hasWt = (p: Pending) => p.url.includes('worktree=')
const take = (pred: (p: Pending) => boolean): Pending => {
  const i = pending.findIndex(pred)
  if (i < 0) throw new Error('no pending fetch matched')
  return pending.splice(i, 1)[0]
}

describe('useFileTree worktree race guard', () => {
  it('drops a stale loadRoot result after a worktree switch (captured-key check)', async () => {
    const { result, rerender } = renderHook(
      ({ wt }: { wt: string | null }) => useFileTree('proj', wt),
      { initialProps: { wt: null as string | null } },
    )

    // Primary root load is issued but held open.
    await waitFor(() => expect(pending.some(p => isRoot(p) && !hasWt(p))).toBe(true))
    const staleRoot = take(p => isRoot(p) && !hasWt(p))

    // Switch to worktree B; B's root resolves and is shown.
    rerender({ wt: '/wt/B' })
    await waitFor(() => expect(pending.some(p => isRoot(p) && hasWt(p))).toBe(true))
    await act(async () => { take(p => isRoot(p) && hasWt(p)).resolve([dir('b-only')]) })
    expect(result.current.data).toEqual([dir('b-only')])

    // The stale primary root resolves LAST. The mock ignores the abort signal, so the
    // only thing that can drop it is loadRoot's captured-worktree check — without it,
    // worktree A's root would clobber B's tree.
    await act(async () => { staleRoot.resolve([dir('primary-only')]) })
    expect(result.current.data).toEqual([dir('b-only')])
  })

  it('drops a stale expandDir child-fetch after a worktree switch', async () => {
    const { result, rerender } = renderHook(
      ({ wt }: { wt: string | null }) => useFileTree('proj', wt),
      { initialProps: { wt: null as string | null } },
    )

    // Primary root load resolves with a single 'src' dir (no children yet).
    await waitFor(() => expect(pending.some(p => isRoot(p) && !hasWt(p))).toBe(true))
    await act(async () => { take(p => isRoot(p) && !hasWt(p)).resolve([dir('src')]) })
    expect(result.current.data).toEqual([dir('src')])

    // Expand 'src' on the primary view → a child fetch we hold open.
    act(() => { void result.current.expandDir('src') })
    await waitFor(() => expect(pending.some(p => isChild(p) && !hasWt(p))).toBe(true))
    const staleChild = take(p => isChild(p) && !hasWt(p))

    // Switch to worktree B; its root resolves (src present, still no children).
    rerender({ wt: '/wt/B' })
    await waitFor(() => expect(pending.some(p => isRoot(p) && hasWt(p))).toBe(true))
    await act(async () => { take(p => isRoot(p) && hasWt(p)).resolve([dir('src')]) })

    // The stale primary child fetch resolves LAST — must be dropped (not merged).
    await act(async () => { staleChild.resolve([file('src/leaked.ts')]) })
    const srcAfterStale = result.current.data!.find(n => n.path === 'src')!
    expect(srcAfterStale.children).toEqual([])

    // A fresh expand on B merges correctly — the guard drops only stale results.
    act(() => { void result.current.expandDir('src') })
    await waitFor(() => expect(pending.some(p => isChild(p) && hasWt(p))).toBe(true))
    await act(async () => { take(p => isChild(p) && hasWt(p)).resolve([file('src/real.ts')]) })
    const srcOnB = result.current.data!.find(n => n.path === 'src')!
    expect(srcOnB.children).toEqual([file('src/real.ts')])
  })

  it('does not surface a stale loadRoot FAILURE on the new worktree', async () => {
    const { result, rerender } = renderHook(
      ({ wt }: { wt: string | null }) => useFileTree('proj', wt),
      { initialProps: { wt: null as string | null } },
    )

    // Primary root load is issued but held open.
    await waitFor(() => expect(pending.some(p => isRoot(p) && !hasWt(p))).toBe(true))
    const staleRoot = take(p => isRoot(p) && !hasWt(p))

    // Switch to B; B's root resolves cleanly (error stays null).
    rerender({ wt: '/wt/B' })
    await waitFor(() => expect(pending.some(p => isRoot(p) && hasWt(p))).toBe(true))
    await act(async () => { take(p => isRoot(p) && hasWt(p)).resolve([dir('b-only')]) })
    expect(result.current.error).toBeNull()

    // The stale primary root FAILS last — its error must not surface on B's view.
    await act(async () => { staleRoot.fail() })
    expect(result.current.error).toBeNull()
    expect(result.current.data).toEqual([dir('b-only')])
  })
})
