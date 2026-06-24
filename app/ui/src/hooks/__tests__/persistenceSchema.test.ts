// @vitest-environment jsdom
//
// Persistence schema P3 (design §P3 "Persistence schema + migration", review §2 / r2 §B).
// Pins the load-bearing contract:
//   - drafts persist as a multi-bucket record { [worktreeKey]: { [relpath]: entry } },
//     worktreeKey = abspath (primary = projectPath);
//   - legacy `yaco-drafts:${project}:wt:<slug>` AND legacy primary `yaco-drafts:${project}`
//     fold into the record keyed by abspath — before the first save, with no data loss;
//   - a newer multi-bucket bucket wins over a stale legacy `:wt:<slug>` (no re-fold);
//   - flush serializes EVERY visited bucket (a dirty draft in a background worktree
//     survives), overlaid onto the migrated base so an unvisited bucket is never clobbered.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

// useWorkspaceState → useFileState → useSSERefresh opens an EventSource jsdom lacks.
vi.mock('../useSSE', () => ({ useSSERefresh: () => {}, addSSEListener: () => () => {} }))

import { loadDraftsByWorktree, usePersistence } from '../usePersistence'
import { useWorkspaceState } from '../useWorkspaceState'
import { draftsKey, type PersistedDraftsByWorktree, type PersistedDraftEntry } from '../workspaceTypes'

const PROJECT = 'proj'
const PROJECT_PATH = '/repo/proj'

function entry(draft: string | null, updatedAt = 1): PersistedDraftEntry {
  return { draft, baseRevision: 1, viewportLine: 1, updatedAt }
}

function readSaved(): PersistedDraftsByWorktree {
  return JSON.parse(localStorage.getItem(draftsKey(PROJECT)) ?? '{}') as PersistedDraftsByWorktree
}

beforeEach(() => {
  localStorage.clear()
  // Hydration issues content GETs; a fresh project has no open tabs so this rarely
  // fires, but stub it so any stray fetch resolves cleanly.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content: '', revision: 1 }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

describe('loadDraftsByWorktree — legacy migration', () => {
  it('folds legacy primary + :wt:<slug> drafts into abspath-keyed buckets (no loss)', () => {
    localStorage.setItem(draftsKey(PROJECT), JSON.stringify({ files: { 'a.ts': entry('primary') } }))
    localStorage.setItem(`${draftsKey(PROJECT)}:wt:feature`, JSON.stringify({ files: { 'b.ts': entry('wt-feature') } }))
    localStorage.setItem(`${draftsKey(PROJECT)}:wt:hotfix`, JSON.stringify({ files: { 'c.ts': entry('wt-hotfix') } }))

    const record = loadDraftsByWorktree(PROJECT, PROJECT_PATH)

    expect(record[PROJECT_PATH]['a.ts'].draft).toBe('primary')
    expect(record[`${PROJECT_PATH}/.worktrees/feature`]['b.ts'].draft).toBe('wt-feature')
    expect(record[`${PROJECT_PATH}/.worktrees/hotfix`]['c.ts'].draft).toBe('wt-hotfix')
  })

  it('folds an abspath-suffixed legacy :wt: key (post-P1 worktree id) into its abspath bucket verbatim', () => {
    // Post-P1, draftsKey(project, worktree) wrote the worktree ABSPATH as the suffix,
    // so the bucket key is that abspath as-is — NOT re-nested under .worktrees/.
    const abspath = `${PROJECT_PATH}/.worktrees/B`
    localStorage.setItem(`${draftsKey(PROJECT)}:wt:${abspath}`, JSON.stringify({ files: { 'b.ts': entry('abspath-legacy') } }))

    const record = loadDraftsByWorktree(PROJECT, PROJECT_PATH)
    expect(record[abspath]['b.ts'].draft).toBe('abspath-legacy')
    expect(record[`${PROJECT_PATH}/.worktrees${abspath}`]).toBeUndefined() // not double-nested
  })

  it('merges a duplicate slug + abspath legacy key for the same worktree, newer per-path wins (lossless)', () => {
    const abspath = `${PROJECT_PATH}/.worktrees/feature`
    // Pre-P1 slug key (older) AND post-P1 abspath key (newer) for the SAME worktree —
    // both canonicalize to the same bucket. The merge must be order-independent and
    // lose nothing.
    localStorage.setItem(`${draftsKey(PROJECT)}:wt:feature`, JSON.stringify({ files: {
      'shared.ts': entry('OLD', 1), 'slug-only.ts': entry('slug', 1),
    } }))
    localStorage.setItem(`${draftsKey(PROJECT)}:wt:${abspath}`, JSON.stringify({ files: {
      'shared.ts': entry('NEW', 9), 'abspath-only.ts': entry('abspath', 9),
    } }))

    const b = loadDraftsByWorktree(PROJECT, PROJECT_PATH)[abspath]
    expect(b['shared.ts'].draft).toBe('NEW')          // newer updatedAt wins
    expect(b['slug-only.ts'].draft).toBe('slug')      // slug-only path preserved
    expect(b['abspath-only.ts'].draft).toBe('abspath') // abspath-only path preserved
  })

  it('a newer multi-bucket bucket wins over a stale legacy :wt:<slug> for the same abspath', () => {
    const abspath = `${PROJECT_PATH}/.worktrees/feature`
    localStorage.setItem(draftsKey(PROJECT), JSON.stringify({ [abspath]: { 'b.ts': entry('NEW', 5) } }))
    localStorage.setItem(`${draftsKey(PROJECT)}:wt:feature`, JSON.stringify({ files: { 'b.ts': entry('STALE', 1) } }))

    const record = loadDraftsByWorktree(PROJECT, PROJECT_PATH)
    expect(record[abspath]['b.ts'].draft).toBe('NEW')
  })

  it('reads a multi-bucket record back verbatim and drops non-file (diff) paths', () => {
    const abspath = `${PROJECT_PATH}/.worktrees/x`
    localStorage.setItem(draftsKey(PROJECT), JSON.stringify({
      [PROJECT_PATH]: { 'a.ts': entry('p'), 'diff:z.ts?base=main': entry('nope') },
      [abspath]: { 'b.ts': entry('w') },
    }))

    const record = loadDraftsByWorktree(PROJECT, PROJECT_PATH)
    expect(record[PROJECT_PATH]['a.ts'].draft).toBe('p')
    expect(record[PROJECT_PATH]['diff:z.ts?base=main']).toBeUndefined() // not a file tab
    expect(record[abspath]['b.ts'].draft).toBe('w')
  })

  it('survives a corrupt primary blob and still folds legacy :wt:<slug> keys', () => {
    localStorage.setItem(draftsKey(PROJECT), 'not json{{{')
    localStorage.setItem(`${draftsKey(PROJECT)}:wt:feature`, JSON.stringify({ files: { 'b.ts': entry('survives') } }))

    const record = loadDraftsByWorktree(PROJECT, PROJECT_PATH)
    expect(record[`${PROJECT_PATH}/.worktrees/feature`]['b.ts'].draft).toBe('survives')
  })
})

describe('usePersistence — full multi-bucket seed', () => {
  it('returns the whole migrated record as initialDraftsByWorktree (the seed useFileState restores every bucket from)', () => {
    const wtB = `${PROJECT_PATH}/.worktrees/B`
    localStorage.setItem(draftsKey(PROJECT), JSON.stringify({
      [PROJECT_PATH]: { 'a.ts': entry('primary') },
      [wtB]: { 'b.ts': entry('bbb') },
    }))

    // No worktree arg: the record is project-global; useFileState selects the active
    // bucket from it. Every bucket is present so a worktree switch restores live.
    const { result } = renderHook(() => usePersistence(PROJECT, PROJECT_PATH))
    expect(result.current.initialDraftsByWorktree[PROJECT_PATH]['a.ts'].draft).toBe('primary')
    expect(result.current.initialDraftsByWorktree[wtB]['b.ts'].draft).toBe('bbb')
  })
})

describe('all-bucket flush via useWorkspaceState', () => {
  function mount(initialWt: string | null) {
    return renderHook(
      ({ wt }: { wt: string | null }) => useWorkspaceState(PROJECT, PROJECT_PATH, wt),
      { initialProps: { wt: initialWt } },
    )
  }

  it('serializes EVERY visited worktree bucket on flush (background draft survives)', () => {
    const wtB = `${PROJECT_PATH}/.worktrees/B`
    const { result, rerender, unmount } = mount(null)

    // Edit on the primary view, switch to worktree B, edit a different path there.
    act(() => { result.current.updateFileDraft('a.ts', 'edit-A') })
    rerender({ wt: wtB })
    act(() => { result.current.updateFileDraft('b.ts', 'edit-B') })

    unmount() // unmount fires the synchronous flush

    const saved = readSaved()
    expect(saved[PROJECT_PATH]['a.ts'].draft).toBe('edit-A') // background bucket still serialized
    expect(saved[wtB]['b.ts'].draft).toBe('edit-B')          // active bucket serialized
  })

  it('overlays live buckets onto the migrated base — an unvisited legacy bucket is never clobbered (gate before first save)', () => {
    const wtGhost = `${PROJECT_PATH}/.worktrees/ghost`
    // A legacy per-worktree draft for a worktree the user never opens this session.
    localStorage.setItem(`${draftsKey(PROJECT)}:wt:ghost`, JSON.stringify({ files: { 'g.ts': entry('ghost-draft') } }))

    const { result, unmount } = mount(null)
    act(() => { result.current.updateFileDraft('a.ts', 'edit-A') })
    unmount()

    const saved = readSaved()
    expect(saved[PROJECT_PATH]['a.ts'].draft).toBe('edit-A')   // active edit saved
    expect(saved[wtGhost]['g.ts'].draft).toBe('ghost-draft')   // migrated-but-unvisited bucket preserved
  })

  it('a draft in worktree A survives a switch to B and back (round-trips through persistence)', () => {
    const wtA = `${PROJECT_PATH}/.worktrees/A`
    const wtB = `${PROJECT_PATH}/.worktrees/B`
    const { result, rerender, unmount } = mount(wtA)

    act(() => { result.current.updateFileDraft('a.ts', 'draft-in-A') })
    rerender({ wt: wtB })          // away…
    expect(result.current.files['a.ts']).toBeUndefined() // not visible in B
    rerender({ wt: wtA })          // …and back
    expect(result.current.files['a.ts'].draft).toBe('draft-in-A') // restored live

    unmount()
    expect(readSaved()[wtA]['a.ts'].draft).toBe('draft-in-A') // and persisted under A's key
  })

  it('prunes empty buckets — a worktree with no live drafts is not written', () => {
    const { result, unmount } = mount(null)
    act(() => { result.current.updateFileViewport('a.ts', 1) }) // viewport stays default → not a draft
    unmount()
    expect(readSaved()[PROJECT_PATH]).toBeUndefined()
  })

  it('a worktree switch is a prop update, not a remount: shell layout holds still while the file view re-points (#3b restore)', () => {
    const wtA = `${PROJECT_PATH}/.worktrees/A`
    // Distinct drafts per worktree so we can SEE the file view follow the selection.
    localStorage.setItem(draftsKey(PROJECT), JSON.stringify({
      [PROJECT_PATH]: { 'a.ts': entry('primary-draft') },
      [wtA]: { 'a.ts': entry('A-draft') },
    }))

    const { result, rerender } = mount(null)
    const layoutBefore = result.current.panelLayout
    expect(result.current.files['a.ts'].draft).toBe('primary-draft')

    rerender({ wt: wtA })
    // SHELL held still — the SAME panelLayout object (no remount, no reset).
    expect(result.current.panelLayout).toBe(layoutBefore)
    // FILE VIEW followed — A's seeded bucket projects LIVE, no reload needed (#3b).
    expect(result.current.files['a.ts'].draft).toBe('A-draft')

    rerender({ wt: null })
    expect(result.current.panelLayout).toBe(layoutBefore)
    expect(result.current.files['a.ts'].draft).toBe('primary-draft')
  })

  it('restores a switched-to worktree draft and never prunes it (#3b — no remount to reload it)', () => {
    const wtB = `${PROJECT_PATH}/.worktrees/B`
    // B has a persisted draft. The session mounts on primary; useFileState seeds ALL
    // buckets up front, so switching to B restores its draft LIVE (no remount/reload),
    // and the flush re-serializes it rather than pruning it.
    localStorage.setItem(draftsKey(PROJECT), JSON.stringify({ [wtB]: { 'b.ts': entry('persisted-B') } }))

    const { result, rerender, unmount } = mount(null)
    act(() => { result.current.updateFileDraft('a.ts', 'edit-A') })
    rerender({ wt: wtB })                                  // select B → its seeded draft is live
    expect(result.current.files['b.ts'].draft).toBe('persisted-B')
    unmount()

    const saved = readSaved()
    expect(saved[wtB]['b.ts'].draft).toBe('persisted-B')  // B's draft survived (not pruned)
    expect(saved[PROJECT_PATH]['a.ts'].draft).toBe('edit-A')
  })

  it('a file opened in a switched-to worktree never prunes that worktree\'s unopened-path base draft (#3b partial hydration)', async () => {
    const wtB = `${PROJECT_PATH}/.worktrees/B`
    // B has a draft for an UNOPENED path. The user switches to B and opens a DIFFERENT
    // file (clean on disk), partially hydrating B's bucket with a clean entry. The
    // unopened-path draft must NOT be pruned — under the old remount model the reload
    // masked this; with all-bucket seeding the draft is live and survives the flush.
    localStorage.setItem(draftsKey(PROJECT), JSON.stringify({ [wtB]: { 'unopened.ts': entry('keep-me') } }))

    const { result, rerender, unmount } = mount(null)
    rerender({ wt: wtB })
    await act(async () => { result.current.openFileInGroup(result.current.activeGroupId, 'open.ts') })
    unmount()

    expect(readSaved()[wtB]['unopened.ts'].draft).toBe('keep-me')
  })

  it('reflects a background-worktree save on flush — a draft cleared by a save after switching is not written back stale (review r2 finding)', async () => {
    // Defer the save PUT so it resolves AFTER we switch away from worktree A.
    let resolvePut: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn((_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PUT') {
        return new Promise(res => { resolvePut = () => res({ ok: true, status: 200, json: () => Promise.resolve({ revision: 2 }) }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content: '', revision: 1 }) })
    }))

    const wtA = `${PROJECT_PATH}/.worktrees/A`
    const wtB = `${PROJECT_PATH}/.worktrees/B`
    const { result, rerender, unmount } = mount(wtA)

    act(() => { result.current.updateFileDraft('a.ts', 'draft-A') })
    // Start a save of A's file with the current buffer (it captures wtA), then switch
    // to B before it resolves.
    let savePromise!: Promise<unknown>
    act(() => { savePromise = result.current.saveFile('a.ts', 'draft-A') })
    rerender({ wt: wtB })
    // The save resolves into A's now-background bucket → its draft clears (the saved
    // bytes equal the buffer).
    await act(async () => { resolvePut!(); await savePromise })

    unmount()
    // The flush serializes A's CURRENT (cleared) bucket, not a stale captured draft.
    expect(readSaved()[wtA]?.['a.ts']).toBeUndefined()
  })

  it('persists a background-worktree save via the DEBOUNCE, without unmount (durable #3a / HIGH-2)', async () => {
    vi.useFakeTimers()
    try {
      let resolvePut: (() => void) | null = null
      vi.stubGlobal('fetch', vi.fn((_url: string, opts?: { method?: string }) => {
        if (opts?.method === 'PUT') {
          return new Promise(res => { resolvePut = () => res({ ok: true, status: 200, json: () => Promise.resolve({ revision: 2 }) }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content: '', revision: 1 }) })
      }))

      const wtA = `${PROJECT_PATH}/.worktrees/A`
      const wtB = `${PROJECT_PATH}/.worktrees/B`
      const { result, rerender } = mount(wtA)

      act(() => { result.current.updateFileDraft('a.ts', 'draft-A') })
      let savePromise!: Promise<unknown>
      act(() => { savePromise = result.current.saveFile('a.ts', 'draft-A') })
      rerender({ wt: wtB })
      // Drain EVERY pending debounce before the save resolves, so the only thing that
      // can re-arm the drafts flush afterward is the background save's all-bucket
      // mutation — A's draft-A is on disk at this point.
      await act(async () => { await vi.advanceTimersByTimeAsync(600) })
      expect(readSaved()[wtA]['a.ts'].draft).toBe('draft-A')

      // The save resolves into A's now-BACKGROUND bucket → its draft clears. No active
      // edit follows; only an all-bucket-keyed schedule (not the active `files` one)
      // can persist this. Keying on `files` alone would leave draft-A on disk.
      await act(async () => { resolvePut!(); await savePromise })
      await act(async () => { await vi.advanceTimersByTimeAsync(600) })

      expect(readSaved()[wtA]?.['a.ts']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('migration commit — legacy keys retired, no resurrection (review finding 1)', () => {
  it('retires the legacy :wt:<slug> key at mount and does not resurrect a cleared bucket', () => {
    const wtKey = `${draftsKey(PROJECT)}:wt:feature`
    const abspath = `${PROJECT_PATH}/.worktrees/feature`
    localStorage.setItem(wtKey, JSON.stringify({ files: { 'b.ts': entry('legacy') } }))

    const { unmount } = renderHook(() => usePersistence(PROJECT, PROJECT_PATH))
    // The mount effect persisted the merged record and retired the legacy key.
    expect(localStorage.getItem(wtKey)).toBeNull()
    expect(readSaved()[abspath]['b.ts'].draft).toBe('legacy')
    unmount()

    // Simulate the user clearing that draft → saveDrafts prunes the now-empty bucket.
    localStorage.setItem(draftsKey(PROJECT), JSON.stringify({}))
    // Reload: the cleared bucket must NOT come back (the legacy key is gone).
    expect(loadDraftsByWorktree(PROJECT, PROJECT_PATH)[abspath]).toBeUndefined()
  })

  it('retires legacy keys BEFORE writing the merged record (no transient 2x-storage, review r5 finding)', () => {
    const wtKey = `${draftsKey(PROJECT)}:wt:feature`
    localStorage.setItem(wtKey, JSON.stringify({ files: { 'b.ts': entry('legacy') } }))

    // Capture whether the legacy key still occupies storage at the instant the merged
    // record is written. Writing while it is present would double the legacy data on
    // disk and could force a premature quota eviction.
    let legacyPresentAtMergedWrite: boolean | null = null
    const realSet = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === draftsKey(PROJECT) && legacyPresentAtMergedWrite === null) {
        legacyPresentAtMergedWrite = localStorage.getItem(wtKey) !== null
      }
      realSet.call(this, k, v)
    })
    try {
      renderHook(() => usePersistence(PROJECT, PROJECT_PATH)).unmount()
    } finally {
      spy.mockRestore()
    }
    expect(legacyPresentAtMergedWrite).toBe(false) // freed first, then the merged write
  })
})
