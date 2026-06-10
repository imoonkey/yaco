// @vitest-environment jsdom
//
// Characterization for the T1a data-resource adapters: the single-poller
// composition `useWorkspaceData` owns exactly one git poller, one sessions
// poller, and one sessions manager, and surfaces the explicit resource shape
// (no hook return type leaks into the public interfaces).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup, waitFor } from '@testing-library/react'
import { useWorkspaceSessions } from '../useWorkspaceSessions'
import { useWorkspaceData } from '../resources'
import type { WorkspaceGitResource, WorkspaceSessionsResource } from '../resources'
import type { AgentSession, GitChange, SessionProvider } from '../../types'

// Call-through spy on the sessions manager so we can count how many manager
// instances the composition mounts, without losing real behavior (the pinned
// load, ordering, shape mapping all still run).
vi.mock('../useWorkspaceSessions', async (importActual) => {
  const actual = await importActual<typeof import('../useWorkspaceSessions')>()
  return { useWorkspaceSessions: vi.fn(actual.useWorkspaceSessions) }
})
const sessionsManagerSpy = vi.mocked(useWorkspaceSessions)

// --- H2: compile-time guard. tsc fails here if either public interface stops
// being an explicit field map (e.g. a `ReturnType<typeof ...>` leak reshapes
// the surface). Runtime shape checks below cannot see a type-only regression. ---
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

// Exported so noUnusedLocals does not strip them; the `Expect<Equal<...>>`
// constraint is still evaluated at each alias declaration.
export type _GitResourceIsExplicit = Expect<Equal<WorkspaceGitResource, {
  changes: GitChange[]
  stale: boolean
  stats?: { added: number; deleted: number }
  loading: boolean
  error: Error | null
  refresh: () => Promise<void>
}>>

export type _SessionsResourceIsExplicit = Expect<Equal<WorkspaceSessionsResource, {
  projectSessions: AgentSession[]
  orderedSessions: AgentSession[]
  pinnedSet: Set<string>
  liveSessionHandles: Set<string>
  getSessionUnread: (name: string) => number
  startSession: (provider: SessionProvider) => Promise<void>
  killSession: (name: string) => Promise<void>
  renameSession: (oldName: string, newName: string) => Promise<void>
  togglePin: (name: string) => void
  reorderPinned: (fromName: string, toName: string) => void
  refresh: () => Promise<void>
}>>

// jsdom lacks EventSource; the useSSE singleton constructs one when
// usePinnedSessions registers its 'ui-state:changed' listener.
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly url: string
  readyState = FakeEventSource.CONNECTING
  constructor(url: string) { this.url = url }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.readyState = FakeEventSource.CLOSED }
}

let fetchSpy: ReturnType<typeof vi.fn>

function installFetch() {
  fetchSpy = vi.fn(async (input: unknown) => {
    const url = String(input)
    const json = url.includes('/git/') && url.includes('/status')
      ? { changes: [], stale: false }
      : [] // sessions + pinned-sessions both return arrays
    return { ok: true, status: 200, json: async () => json } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchSpy)
}

const requestUrls = () => fetchSpy.mock.calls.map((c) => String(c[0]))
const countMatching = (re: RegExp) => requestUrls().filter((u) => re.test(u)).length

const SESSIONS_ROUTE = /\/api\/sessions\?project=/
const GIT_STATUS_ROUTE = /\/api\/git\/[^/]+\/status/
const PINNED_ROUTE = /\/api\/ui-state\/pinned-sessions\?project=/

function makeOpts() {
  return {
    projectName: 'res-proj',
    projectPath: '/tmp/res-proj',
    worktree: null,
    activeSession: '',
    actions: { setActiveSession: vi.fn(), setMobilePane: vi.fn() },
    setFocusTarget: vi.fn(),
  }
}

describe('useWorkspaceData single-poller composition', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
    installFetch()
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('mounts exactly one git poller and one sessions poller', async () => {
    renderHook(() => useWorkspaceData(makeOpts()))
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(countMatching(GIT_STATUS_ROUTE)).toBe(1)
    expect(countMatching(SESSIONS_ROUTE)).toBe(1)
  })

  it('mounts exactly one sessions manager (never double-mounts) per render', async () => {
    let renders = 0
    renderHook(() => { renders++; return useWorkspaceData(makeOpts()) })
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2))

    // The composition invokes the manager exactly once per render of itself.
    // A broken adapter that called useWorkspaceSessions twice (while still
    // polling useSessions once) would make this 2x the render count.
    expect(renders).toBeGreaterThanOrEqual(1)
    expect(sessionsManagerSpy).toHaveBeenCalledTimes(renders)

    // Independent side-effect proof: the manager's usePinnedSessions issues
    // exactly one pinned-sessions load on mount; a second manager instance
    // would double it.
    expect(countMatching(PINNED_ROUTE)).toBe(1)
  })

  it('exposes the explicit git + sessions resource shape', () => {
    const { result } = renderHook(() => useWorkspaceData(makeOpts()))

    const { git, sessions } = result.current
    expect(Array.isArray(git.changes)).toBe(true)
    expect(typeof git.stale).toBe('boolean')
    expect(typeof git.loading).toBe('boolean')
    expect(typeof git.refresh).toBe('function')

    expect(Array.isArray(sessions.projectSessions)).toBe(true)
    expect(Array.isArray(sessions.orderedSessions)).toBe(true)
    expect(sessions.pinnedSet).toBeInstanceOf(Set)
    expect(sessions.liveSessionHandles).toBeInstanceOf(Set)
    expect(typeof sessions.startSession).toBe('function')
    expect(typeof sessions.killSession).toBe('function')
    expect(typeof sessions.renameSession).toBe('function')
    expect(typeof sessions.togglePin).toBe('function')
    expect(typeof sessions.reorderPinned).toBe('function')
    expect(typeof sessions.refresh).toBe('function')
  })
})
