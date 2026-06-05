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
    mkdirSync(join(testProjectPath, 'plan'), { recursive: true })
  })

  afterEach(() => {
    rmSync(testProjectPath, { recursive: true, force: true })
  })

  it('enriches tasks that have worktree field with worktreeStatus', async () => {
    const tasks = {
      'T1': { title: 'Task 1', worktree: 'feat-login' },
      'T2': { title: 'Task 2' },
    }
    writeFileSync(join(testProjectPath, 'plan/tasks.json'), JSON.stringify(tasks))

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
    writeFileSync(join(testProjectPath, 'plan/tasks.json'), JSON.stringify(tasks))

    getWorktreeStatusesMock.mockResolvedValue(new Map())

    const res = await taskRoutes.request('/test-project', { method: 'GET' })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tasks['T1'].worktreeStatus).toBeUndefined()
    expect(json.tasks['T2'].worktreeStatus).toBeUndefined()
  })

  it('returns 404 when tasks.json does not exist', async () => {
    // Don't write tasks.json
    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(404)
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

  it('reads tasks from yaco.toml [paths].tasks override (NOT plan/tasks.json)', async () => {
    // Set up an override: tasks live at custom/tasks.json
    writeFileSync(
      join(testProjectPath, 'yaco.toml'),
      '[paths]\ntasks = "custom/tasks.json"\n',
    )
    mkdirSync(join(testProjectPath, 'custom'), { recursive: true })
    writeFileSync(
      join(testProjectPath, 'custom/tasks.json'),
      JSON.stringify({ OVERRIDE: { title: 'lives under override' } }),
    )

    // Decoy at the default path — if the route read this, the test would
    // pass without exercising the override resolver.
    mkdirSync(join(testProjectPath, 'plan'), { recursive: true })
    writeFileSync(
      join(testProjectPath, 'plan/tasks.json'),
      JSON.stringify({ DEFAULT: { title: 'should NOT be read' } }),
    )

    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tasks).toHaveProperty('OVERRIDE')
    expect(json.tasks).not.toHaveProperty('DEFAULT')
  })

  it('reads archives from yaco.toml [paths].archive override', async () => {
    writeFileSync(
      join(testProjectPath, 'yaco.toml'),
      '[paths]\narchive = "custom/archive"\n',
    )
    mkdirSync(join(testProjectPath, 'custom/archive'), { recursive: true })
    writeFileSync(
      join(testProjectPath, 'custom/archive/20260101_done.json'),
      JSON.stringify({ A1: { title: 'archived under override' } }),
    )
    // Decoy at default — must NOT be enumerated.
    mkdirSync(join(testProjectPath, 'plan/archive'), { recursive: true })
    writeFileSync(
      join(testProjectPath, 'plan/archive/20260101_decoy.json'),
      JSON.stringify({ D1: { title: 'should NOT be listed' } }),
    )

    const res = await taskRoutes.request('/test-project/archive', { method: 'GET' })
    expect(res.status).toBe(200)
    const json = await res.json()
    const files = (json.archives as Array<{ file: string }>).map(a => a.file)
    expect(files).toEqual(['20260101_done.json'])
  })
})
