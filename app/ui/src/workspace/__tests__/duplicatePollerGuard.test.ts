// @vitest-environment jsdom
//
// Characterization: the workspace composition mounts exactly one owner per
// pollable concern — one sessions poller, one git poller, one filetree owner —
// and shares a single process-wide SSE EventSource ("one SSE path").
//
// This pins the phase-0 invariant the panel-extraction refactor must preserve.
// Today the owners live directly in `WorkspaceScreen`'s `Workspace` body:
//   useFileTree(projectName, worktree)   // WorkspaceScreen.tsx:140  (filetree owner)
//   useSessions(projectName)             // WorkspaceScreen.tsx:141  (sessions poller)
//   useGitStatus(projectName, worktree)  // WorkspaceScreen.tsx:142  (git poller)
//   useSSERefresh('filetree', …)         // WorkspaceScreen.tsx:147  (one SSE consumer)
// When phase 3 splits these into panels, two panels each owning a hook would
// double the poll load (or open a second SSE stream). The guard renders the REAL
// `Workspace` (heavy children mocked) and counts requests from that render, so a
// duplicate owner added to the composition fails the test. Duplicate-owner
// control tests prove the counters are non-vacuous for all three routes.
//
// `.ts` (not `.tsx`) per task scope, so elements use `createElement`/`renderHook`
// callbacks rather than JSX.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, renderHook, cleanup, waitFor, act } from '@testing-library/react'
import { useFileTree, useSessions, useGitStatus } from '../../hooks/useApi'
import { useSSERefresh } from '../../hooks/useSSE'
import { Workspace } from '../WorkspaceScreen'
import type { WorktreeInfo } from '../../hooks/useProjectWorktrees'

// Mock only the heavy children the real `Workspace` renders directly, so the
// render exercises the top-level poller/SSE composition (the real useFileTree /
// useSessions / useGitStatus / useSSERefresh) without mounting xterm, the editor,
// or the voice/VAD stack. The poller hooks live in `Workspace`'s own body, so
// they still run for real with `WorkspaceLayout` short-circuited to null.
vi.mock('../WorkspaceLayout', () => ({ WorkspaceLayout: () => null }))
vi.mock('../../components/ComposeTray', () => ({ ComposeTray: () => null }))
vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({
    capability: { status: 'unavailable' }, state: 'idle', elapsedMs: 0,
    liveTranscript: '', pendingCount: 0, compose: null, target: null,
    errorMessage: null, noSpeechMessage: null,
    start: () => {}, stop: () => {}, confirm: () => {}, discard: () => {},
    copy: () => {}, dismiss: () => {}, retry: () => {}, markTargetLost: () => {},
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
