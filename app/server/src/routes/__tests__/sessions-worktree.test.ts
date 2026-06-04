import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all session dependencies — we only care about worktree enrichment
vi.mock('../../lib/agent', () => ({
  readSessionsFromStateFiles: vi.fn(),
  readAllSessionsFromStateFiles: vi.fn(),
  closeMultmuxSession: vi.fn(),
  renameMultmuxSession: vi.fn(),
  sendToSession: vi.fn(),
  startMultmuxSession: vi.fn(),
}))

vi.mock('../../lib/projects', () => ({
  loadProjects: vi.fn(() => Promise.resolve([
    { name: 'my-project', path: '/home/user/my-project' },
  ])),
}))

vi.mock('../../lib/session-summary', () => ({
  resolveSessionSummaries: vi.fn(() => new Map()),
}))

vi.mock('../../lib/terminal', () => ({
  listShellSessions: vi.fn(() => []),
  closeShellSession: vi.fn(),
  startShellSession: vi.fn(),
}))

vi.mock('../../lib/history', () => ({
  getHistory: vi.fn(),
}))

// Use real extractWorktreeSlug — that's what we're testing
const { readAllSessionsFromStateFiles } = await import('../../lib/agent')
const { sessionRoutes } = await import('../sessions')

const mockReadAll = readAllSessionsFromStateFiles as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET / — worktree extraction', () => {
  it('adds worktree field for sessions inside .worktrees/', async () => {
    mockReadAll.mockReturnValue([
      {
        name: 'agent-1',
        provider: 'claude',
        status: 'idle',
        project: 'my-project',
        sessionPath: '/home/user/my-project/.worktrees/feat-auth/src',
        sessionId: 'sid-1',
        pid: 100,
      },
    ])

    const res = await sessionRoutes.request('/')
    expect(res.status).toBe(200)
    const json = await res.json()

    expect(json[0].worktree).toBe('feat-auth')
  })

  it('has no worktree field for sessions not in .worktrees/', async () => {
    mockReadAll.mockReturnValue([
      {
        name: 'agent-2',
        provider: 'claude',
        status: 'idle',
        project: 'my-project',
        sessionPath: '/home/user/my-project',
        sessionId: 'sid-2',
        pid: 200,
      },
    ])

    const res = await sessionRoutes.request('/')
    expect(res.status).toBe(200)
    const json = await res.json()

    expect(json[0].worktree).toBeUndefined()
  })

  it('extracts correct slug from various worktree paths', async () => {
    mockReadAll.mockReturnValue([
      {
        name: 'a1',
        provider: 'claude',
        status: 'idle',
        project: 'my-project',
        sessionPath: '/project/.worktrees/fix-bug',
        sessionId: 's1',
        pid: 1,
      },
      {
        name: 'a2',
        provider: 'codex',
        status: 'idle',
        project: 'my-project',
        sessionPath: '/project/regular-path',
        sessionId: 's2',
        pid: 2,
      },
      {
        name: 'a3',
        provider: 'claude',
        status: 'idle',
        project: 'my-project',
        sessionPath: '/project/.worktrees/refactor-api/deep/nested',
        sessionId: 's3',
        pid: 3,
      },
    ])

    const res = await sessionRoutes.request('/')
    const json = await res.json()

    expect(json[0].worktree).toBe('fix-bug')
    expect(json[1].worktree).toBeUndefined()
    expect(json[2].worktree).toBe('refactor-api')
  })
})
