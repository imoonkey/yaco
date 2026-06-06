import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let testProjectPath: string

vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([{ name: 'test-project', path: testProjectPath }]),
}))

vi.mock('../../lib/notify', () => ({
  emitRefresh: vi.fn(),
}))

// Mock getWorktreeStatuses to control worktree enrichment
const getWorktreeStatusesMock = vi.hoisted(() => vi.fn())
vi.mock('../../lib/worktree', () => ({
  getWorktreeStatuses: getWorktreeStatusesMock,
}))

const { taskRoutes } = await import('../tasks')

describe('GET /:project — worktree enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testProjectPath = mkdtempSync(join(tmpdir(), 'workflow-task-wt-test-'))
    mkdirSync(join(testProjectPath, 'plan/tasks'), { recursive: true })
  })

  afterEach(() => {
    rmSync(testProjectPath, { recursive: true, force: true })
  })

  it('enriches tasks that have worktree field with worktreeStatus', async () => {
    const tasks = {
      'T1': { title: 'Task 1', worktree: 'feat-login' },
      'T2': { title: 'Task 2' },
    }
    writeFileSync(join(testProjectPath, 'plan/tasks/tasks.json'), JSON.stringify(tasks))

    const mockStatus = { active: true, dirty: false, branch: 'task/feat-login', ahead: 2, behind: 0 }
    getWorktreeStatusesMock.mockResolvedValue(new Map([['feat-login', mockStatus]]))

    const res = await taskRoutes.request('/test-project', { method: 'GET' })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tasks['T1'].worktreeStatus).toEqual(mockStatus)
    expect(json.tasks['T2'].worktreeStatus).toBeUndefined()
  })

  it('tasks without worktree field have no worktreeStatus', async () => {
    const tasks = {
      'T1': { title: 'Plain task' },
      'T2': { title: 'Another task', status: 'done' },
    }
    writeFileSync(join(testProjectPath, 'plan/tasks/tasks.json'), JSON.stringify(tasks))

    getWorktreeStatusesMock.mockResolvedValue(new Map())

    const res = await taskRoutes.request('/test-project', { method: 'GET' })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tasks['T1'].worktreeStatus).toBeUndefined()
    expect(json.tasks['T2'].worktreeStatus).toBeUndefined()
  })

  it('returns an empty graph when the task store has no tasks.json yet', async () => {
    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tasks: {} })
  })
})

describe('GET /:project — yaco.toml [paths] overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testProjectPath = mkdtempSync(join(tmpdir(), 'workflow-task-paths-test-'))
    getWorktreeStatusesMock.mockResolvedValue(new Map())
  })

  afterEach(() => {
    rmSync(testProjectPath, { recursive: true, force: true })
  })

  it('reads tasks from yaco.toml [paths].tasks override', async () => {
    // Set up an override: tasks live under custom/tasks/tasks.json
    writeFileSync(
      join(testProjectPath, 'yaco.toml'),
      '[paths]\ntasks = "custom/tasks"\n',
    )
    mkdirSync(join(testProjectPath, 'custom/tasks'), { recursive: true })
    writeFileSync(
      join(testProjectPath, 'custom/tasks/tasks.json'),
      JSON.stringify({ OVERRIDE: { title: 'lives under override' } }),
    )

    // Decoy at the default path — if the route read this, the test would
    // pass without exercising the override resolver.
    mkdirSync(join(testProjectPath, 'plan/tasks'), { recursive: true })
    writeFileSync(
      join(testProjectPath, 'plan/tasks/tasks.json'),
      JSON.stringify({ DEFAULT: { title: 'should NOT be read' } }),
    )

    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tasks).toHaveProperty('OVERRIDE')
    expect(json.tasks).not.toHaveProperty('DEFAULT')
  })

  it('returns every workset (active, backlog, archive) without server-side filtering', async () => {
    mkdirSync(join(testProjectPath, 'plan/tasks'), { recursive: true })
    writeFileSync(
      join(testProjectPath, 'plan/tasks/tasks.json'),
      JSON.stringify({
        A1: { title: 'archived', state: 'done', workset: 'archive' },
        B1: { title: 'backlog', state: 'ready', workset: 'backlog' },
        D1: { title: 'active', state: 'ready', workset: 'active' },
      }),
    )
    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(200)
    const json = await res.json()
    // Archive is a workset in the canonical map now; the client filters it, not the server.
    expect(json.tasks).toHaveProperty('A1')
    expect(json.tasks).toHaveProperty('B1')
    expect(json.tasks).toHaveProperty('D1')
  })
})
