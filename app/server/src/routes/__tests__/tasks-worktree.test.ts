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
    mkdirSync(join(testProjectPath, 'projects'), { recursive: true })
  })

  afterEach(() => {
    rmSync(testProjectPath, { recursive: true, force: true })
  })

  it('enriches tasks that have worktree field with worktreeStatus', async () => {
    const tasks = {
      'T1': { title: 'Task 1', worktree: 'feat-login' },
      'T2': { title: 'Task 2' },
    }
    writeFileSync(join(testProjectPath, 'projects/tasks.json'), JSON.stringify(tasks))

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
    writeFileSync(join(testProjectPath, 'projects/tasks.json'), JSON.stringify(tasks))

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
