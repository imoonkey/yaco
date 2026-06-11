// @vitest-environment jsdom
//
// Characterization: the workspace composition mounts exactly one owner per
// pollable concern — one sessions poller, one git poller, one filetree owner —
// and shares a single process-wide SSE EventSource ("one SSE path").
//
// This pins the phase-0 invariant the panel-extraction refactor must preserve.
// After phase 3h the owners are provider-level (always mounted; they survive
// section collapse + dock hide):
//   sessions/git pollers    → WorkspaceProvider (`useWorkspaceData`)
//   filetree owner + the    → WorkspaceProvider (`useFileTree` + `useSSERefresh('filetree')`)
//   'filetree' SSE consumer
// The guard renders the REAL `WorkspaceLayout` (every panel mounts through it),
// stubbing only the heavy LEAVES (FileExplorer, xterm Terminal, the lazy text
// search). So a genuine double-mount in a real layout branch — or a panel that
// re-owns a poller/SSE — fails the counts. Duplicate-owner control tests prove
// the counters are non-vacuous for all three routes.
//
// `.ts` (not `.tsx`) per task scope, so elements use `createElement`/`renderHook`
// callbacks rather than JSX.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, forwardRef } from 'react'
import { render, renderHook, cleanup, waitFor, act } from '@testing-library/react'
import { useFileTree, useSessions, useGitStatus } from '../../hooks/useApi'
import { useSSERefresh } from '../../hooks/useSSE'
import { Workspace } from '../WorkspaceScreen'
import type { WorktreeInfo } from '../../hooks/useProjectWorktrees'

// Stub only the heavy leaves the real WorkspaceLayout mounts; everything else
// (the provider's pollers/SSE, the panels, the chrome) runs for real so a real
// double-mount is observable. No tab/session is open, so the editor sits on its
// empty state and the terminal on its placeholder — neither leaf mounts here, but
// they are stubbed defensively against future default state.
vi.mock('../../components/FileExplorer', () => ({ FileExplorer: forwardRef(() => null) }))
vi.mock('../../components/Terminal', () => ({ Terminal: () => null }))
vi.mock('../WorkspaceTextSearch', () => ({ WorkspaceTextSearch: () => null }))
vi.mock('../../components/ComposeTray', () => ({ ComposeTray: () => null }))
vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({
    capability: { status: 'unavailable' }, state: 'idle', elapsedMs: 0,
    appendText: null, target: null, errorMessage: null, notice: null,
    open: () => {}, record: () => {}, stop: () => {}, retry: () => {},
    confirm: () => {}, copy: () => {}, discard: () => {}, markTargetLost: () => {},
  }),
}))

const PROJECT = 'guard-proj'

// --- jsdom lacks EventSource; the real useSSE singleton constructs one on mount.
// Track every construction so we can assert a genuine 0 -> 1 per test. ---
const esInstances: FakeEventSource[] = []
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly url: string
  readyState = FakeEventSource.CONNECTING
  onerror: ((ev: unknown) => void) | null = null
  constructor(url: string) {
    this.url = url
    esInstances.push(this)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }
}

let fetchSpy: ReturnType<typeof vi.fn>

function installFetch() {
  fetchSpy = vi.fn(async (input: unknown) => {
    const url = String(input)
    const json = url.includes('/git/') && url.includes('/status')
      ? { changes: [], stale: false }
      : []
    return { ok: true, status: 200, json: async () => json } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchSpy)
}

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
}

const requestUrls = () => fetchSpy.mock.calls.map((c) => String(c[0]))
const countMatching = (re: RegExp) => requestUrls().filter((u) => re.test(u)).length

const SESSIONS_ROUTE = /\/api\/sessions\?project=/
const GIT_STATUS_ROUTE = /\/api\/git\/[^/]+\/status/
const FILETREE_ROOT_ROUTE = /\/api\/files\/[^/?]+$/ // root only — no /children, no query

/** Minimal prop surface for the real `Workspace` composition. */
function workspaceProps() {
  return {
    projectName: PROJECT,
    projectPath: '/tmp/guard-proj',
    worktree: null,
    worktrees: [] as WorktreeInfo[],
    activeWorktree: null,
    onWorktreeSelect: () => {},
    projects: [],
    activeProject: PROJECT,
    projectUnreadCounts: {},
    projectSessionCounts: {},
    onProjectSelect: () => {},
    onProjectReorder: () => {},
    onProjectRemove: () => {},
    onAddProject: () => {},
    onMarkAllRead: () => {},
  }
}

describe('duplicate-poller / single-SSE guard', () => {
  beforeEach(() => {
    esInstances.length = 0
    vi.stubGlobal('EventSource', FakeEventSource)
    // The real editor tab bar observes its scroll container; jsdom has none.
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    installFetch()
    stubMatchMedia()
  })
  afterEach(() => {
    cleanup()
    // Force the useSSE singleton's connection closed so the next test's first
    // consumer reopens it: getSource() reuses `source` only while its readyState
    // !== CLOSED, so marking CLOSED guarantees a fresh 0 -> 1 next test.
    for (const es of esInstances) es.readyState = FakeEventSource.CLOSED
    esInstances.length = 0
    vi.clearAllMocks()
  })

  it('real Workspace composition mounts exactly one sessions poller, one git poller, one filetree owner', async () => {
    await act(async () => {
      render(createElement(Workspace, workspaceProps()))
    })

    // Each owner issues exactly one request on mount (poll intervals are 30–60s
    // and never fire in-test). Counts come from the REAL composition, so a
    // duplicate owner added to `Workspace` would break these.
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(countMatching(SESSIONS_ROUTE)).toBe(1)
    expect(countMatching(GIT_STATUS_ROUTE)).toBe(1)
    expect(countMatching(FILETREE_ROOT_ROUTE)).toBe(1)

    // …and that render opens exactly one SSE stream (0 -> 1 this test).
    expect(esInstances).toHaveLength(1)
    expect(esInstances[0].url).toBe('/api/notifications/stream')
  })

  it('counter detects a duplicate filetree owner (non-vacuous)', async () => {
    renderHook(() => {
      useFileTree(PROJECT, null)
      useFileTree(PROJECT, null)
    })
    await waitFor(() => expect(countMatching(FILETREE_ROOT_ROUTE)).toBe(2))
  })

  it('counter detects a duplicate sessions owner (non-vacuous)', async () => {
    renderHook(() => {
      useSessions(PROJECT)
      useSessions(PROJECT)
    })
    await waitFor(() => expect(countMatching(SESSIONS_ROUTE)).toBe(2))
  })

  it('counter detects a duplicate git owner (non-vacuous)', async () => {
    renderHook(() => {
      useGitStatus(PROJECT, null)
      useGitStatus(PROJECT, null)
    })
    await waitFor(() => expect(countMatching(GIT_STATUS_ROUTE)).toBe(2))
  })

  it('opens exactly one SSE stream (0 -> 1) regardless of consumer count', async () => {
    // afterEach reset proves this is not inherited from an earlier test.
    expect(esInstances).toHaveLength(0)

    // Many consumers across two separate mounts — the real workspace registers
    // several refresh channels (filetree, sessions, git, progress, …).
    renderHook(() => {
      useSSERefresh('filetree', () => {})
      useSSERefresh('sessions', () => {})
      useSSERefresh('git', () => {})
      useSSERefresh('progress', () => {})
    })
    renderHook(() => {
      useSSERefresh('notifications', () => {})
      useSSERefresh('projects', () => {})
    })

    await waitFor(() => expect(esInstances.length).toBeGreaterThanOrEqual(1))

    // One stream, one URL, never re-opened by additional consumers.
    expect(esInstances).toHaveLength(1)
    expect(esInstances[0].url).toBe('/api/notifications/stream')
    expect(esInstances[0].readyState).not.toBe(FakeEventSource.CLOSED)
  })
})
