// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import {
  useWorkspaceSessions,
  resolveSessionClick,
  resolveOpenBeside,
  STARTING_SESSION_PREFIX,
} from '../useWorkspaceSessions'
import { renameSession, startSession } from '../../hooks/useApi'
import type { AgentSession } from '../../types'

vi.mock('../../hooks/useApi', () => ({
  startSession: vi.fn(),
  closeSession: vi.fn(),
  renameSession: vi.fn(),
}))

vi.mock('../../hooks/usePinnedSessions', () => ({
  usePinnedSessions: () => ({ pinnedSessions: [], setPinnedSessions: vi.fn() }),
}))

function makeSession(name: string, status: 'idle' | 'processing' = 'idle', parentSession?: string): AgentSession {
  return { name, provider: 'claude', status, project: 'test', summary: '', parentSession }
}

function makeOpts(overrides: Partial<Parameters<typeof useWorkspaceSessions>[0]> = {}) {
  return {
    projectPath: '/test',
    sessions: [] as AgentSession[],
    refreshSessions: vi.fn(),
    ackSession: vi.fn<(project: string, sessionName: string) => void>(),
    projectName: 'test',
    onAttachSession: vi.fn(),
    ...overrides,
  }
}

// --- resolveSessionClick (flat focus | create — no rebind) ------------------

describe('resolveSessionClick', () => {
  it('focuses the terminal tab already showing the session (no rebind, no dup PTY)', () => {
    const bindings = { 'terminal': 's1', 'terminal:2': 's2' }
    expect(resolveSessionClick('s2', bindings)).toEqual({ kind: 'focus', terminalId: 'terminal:2' })
  })

  it('creates — never rebinds — when the session is not shown, even with live terminals', () => {
    expect(resolveSessionClick('s3', { terminal: 's1' })).toEqual({ kind: 'create' })
  })

  it('creates when no terminal exists', () => {
    expect(resolveSessionClick('s3', {})).toEqual({ kind: 'create' })
  })

  it('prefers focus over create when the session is already shown', () => {
    const bindings = { 'terminal': 's1', 'terminal:2': 's2' }
    expect(resolveSessionClick('s1', bindings)).toEqual({ kind: 'focus', terminalId: 'terminal' })
  })
})

// --- resolveOpenBeside (1-per-session guard) --------------------------------

describe('resolveOpenBeside', () => {
  it('focuses the existing terminal for an already-shown session', () => {
    expect(resolveOpenBeside('s1', { 'terminal:2': 's1' })).toEqual({ kind: 'focus', terminalId: 'terminal:2' })
  })

  it('signals create for a not-yet-shown session', () => {
    expect(resolveOpenBeside('s9', { terminal: 's1' })).toEqual({ kind: 'create' })
  })
})

// --- rename (rebinds bound terminals via the provider callback) -------------

describe('useWorkspaceSessions rename', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('renames the session and rebinds every bound terminal', async () => {
    vi.mocked(renameSession).mockResolvedValue(undefined)
    const onRenameBoundTerminals = vi.fn()
    const opts = makeOpts({ sessions: [makeSession('s1', 'processing')], onRenameBoundTerminals })
    const { result } = renderHook((props) => useWorkspaceSessions(props), { initialProps: opts })

    await act(async () => { await result.current.handleRenameSession('s1', 's2') })

    expect(renameSession).toHaveBeenCalledWith('s1', 's2')
    expect(onRenameBoundTerminals).toHaveBeenCalledWith('s1', 's2')
  })
})

describe('useWorkspaceSessions orderedSessions', () => {
  afterEach(() => {
    cleanup()
  })

  it('includes an unpinned crashed session and surfaces it ahead of idle', () => {
    const crashed: AgentSession = {
      name: 'boom', provider: 'codex', status: 'crashed', exitCode: 1, project: 'test', summary: '',
    }
    const opts = makeOpts({ sessions: [makeSession('calm', 'idle'), crashed] })
    const { result } = renderHook((props) => useWorkspaceSessions(props), { initialProps: opts })
    const names = result.current.orderedSessions.map((s) => s.name)
    expect(names).toContain('boom') // regression: crashed must not be dropped from the list
    expect(names.indexOf('boom')).toBeLessThan(names.indexOf('calm')) // crashed leads idle
  })
})

describe('useWorkspaceSessions optimistic start', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('shows a starting placeholder immediately and reconciles it when the real session lands', async () => {
    // POST resolves with the real handle, but the list won't include it until a
    // later poll — the placeholder must bridge that gap, then disappear.
    let resolveStart: (name: string) => void = () => {}
    vi.mocked(startSession).mockReturnValue(new Promise<string>((res) => { resolveStart = res }))

    const opts = makeOpts({ sessions: [] as AgentSession[] })
    const { result, rerender } = renderHook((props) => useWorkspaceSessions(props), { initialProps: opts })

    // Click new-session: a starting placeholder appears synchronously.
    act(() => { void result.current.handleNewSession('codex') })
    const placeholder = result.current.orderedSessions.find(s => s.name.startsWith(STARTING_SESSION_PREFIX))
    expect(placeholder).toBeTruthy()
    expect(placeholder!.status).toBe('starting')
    expect(placeholder!.provider).toBe('codex')

    // POST resolves with the real handle; the optimistic row adopts it (still
    // 'starting') and bridges until the server list catches up.
    await act(async () => { resolveStart('codex-real') })
    const bridged = result.current.orderedSessions.find(s => s.name === 'codex-real')
    expect(bridged?.status).toBe('starting')

    // Server poll now includes the real session → placeholder reconciles away.
    rerender(makeOpts({ sessions: [makeSession('codex-real', 'processing')] }))
    const names = result.current.orderedSessions.map(s => s.name)
    expect(names).toContain('codex-real')
    expect(names.some(n => n.startsWith(STARTING_SESSION_PREFIX))).toBe(false)
  })

  it('drops the placeholder if the start fails', async () => {
    vi.mocked(startSession).mockRejectedValue(new Error('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result } = renderHook((props) => useWorkspaceSessions(props), { initialProps: makeOpts() })
    await act(async () => { await result.current.handleNewSession('codex') })

    expect(result.current.orderedSessions.some(s => s.name.startsWith(STARTING_SESSION_PREFIX))).toBe(false)
  })

  it('retires a nameless placeholder when its real session appears before the POST resolves (no duplicate row)', async () => {
    // The sessions-dir watcher can surface the real session in the list before the
    // start POST returns its handle — so the placeholder (still name-null) can't be
    // matched by name and must be retired by provider correlation, not left to
    // double the real row.
    vi.mocked(startSession).mockReturnValue(new Promise<string>(() => {})) // never resolves

    const { result, rerender } = renderHook(
      (props) => useWorkspaceSessions(props),
      { initialProps: makeOpts({ sessions: [] as AgentSession[] }) },
    )

    act(() => { void result.current.handleNewSession('codex') })
    expect(result.current.orderedSessions.some(s => s.name.startsWith(STARTING_SESSION_PREFIX))).toBe(true)

    // Server list gains the real codex session while the POST is still in flight.
    const codexReal: AgentSession = { name: 'codex-real', provider: 'codex', status: 'processing', project: 'test', summary: '' }
    await act(async () => { rerender(makeOpts({ sessions: [codexReal] })) })

    const names = result.current.orderedSessions.map(s => s.name)
    expect(names).toEqual(['codex-real'])
  })

  it('does not consume a placeholder against sessions already present at first load', async () => {
    // The first real (non-null) server snapshot is a baseline, not a set of
    // "appearances" — a pre-existing same-provider session must not retire the
    // placeholder; only a genuinely new session (a later snapshot) does.
    vi.mocked(startSession).mockReturnValue(new Promise<string>(() => {})) // never resolves
    const existing: AgentSession = { name: 'codex-existing', provider: 'codex', status: 'idle', project: 'test', summary: '' }

    const { result, rerender } = renderHook(
      (props) => useWorkspaceSessions(props),
      { initialProps: makeOpts({ sessions: null }) }, // no snapshot yet
    )

    act(() => { void result.current.handleNewSession('codex') })
    // First real snapshot already holds an unrelated codex session — placeholder survives.
    await act(async () => { rerender(makeOpts({ sessions: [existing] })) })
    expect(result.current.orderedSessions.some(s => s.name.startsWith(STARTING_SESSION_PREFIX))).toBe(true)

    // A genuinely new codex session then appears → placeholder is retired, no dup.
    const mine: AgentSession = { name: 'codex-mine', provider: 'codex', status: 'processing', project: 'test', summary: '' }
    await act(async () => { rerender(makeOpts({ sessions: [existing, mine] })) })
    const names = result.current.orderedSessions.map(s => s.name).sort()
    expect(names).toEqual(['codex-existing', 'codex-mine'])
  })
})

describe('useWorkspaceSessions markSubtreeRead', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('acks the parent and every descendant, skipping an unrelated sibling', () => {
    const sessions = [
      makeSession('parent'),
      makeSession('childA', 'idle', 'parent'),
      makeSession('childB', 'idle', 'parent'),
      makeSession('grandchild', 'idle', 'childB'),
      makeSession('sibling'),
    ]
    const ackSession = vi.fn<(project: string, sessionName: string) => void>()
    const opts = makeOpts({ sessions, ackSession })
    const { result } = renderHook((props) => useWorkspaceSessions(props), { initialProps: opts })

    act(() => result.current.markSubtreeRead('parent'))

    const acked = ackSession.mock.calls.map(([, name]) => name)
    expect(new Set(acked)).toEqual(new Set(['parent', 'childA', 'childB', 'grandchild']))
    expect(acked).not.toContain('sibling')
    for (const [project] of ackSession.mock.calls) expect(project).toBe('test')
  })
})
