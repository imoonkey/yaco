import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/** The app's own half of the task GET: worktree-status enrichment.
 *
 *  The read under it is in process now, so the graph is seeded on disk rather
 *  than scripted through a `yaco task list` stub. Enrichment itself is
 *  unchanged — it is the app's join, not the CLI's.
 */

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

function seedTasks(tasks: Record<string, Record<string, unknown>>): void {
  const dir = join(testProjectPath, 'plan/tasks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify(tasks, null, 2) + '\n')
}

describe('GET /:project — worktree enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    testProjectPath = mkdtempSync(join(tmpdir(), 'workflow-task-wt-test-'))
  })

  afterEach(() => {
    rmSync(testProjectPath, { recursive: true, force: true })
  })

  it('enriches tasks that have worktree field with worktreeStatus', async () => {
    seedTasks({
      'T1': { title: 'Task 1', worktree: 'feat-login' },
      'T2': { title: 'Task 2' },
    })

    const mockStatus = { active: true, dirty: false, branch: 'task/feat-login', ahead: 2, behind: 0 }
    getWorktreeStatusesMock.mockResolvedValue(new Map([['feat-login', mockStatus]]))

    const res = await taskRoutes.request('/test-project', { method: 'GET' })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tasks['T1'].worktreeStatus).toEqual(mockStatus)
    expect(json.tasks['T2'].worktreeStatus).toBeUndefined()
  })

  it('tasks without worktree field have no worktreeStatus', async () => {
    seedTasks({
      'T1': { title: 'Plain task' },
      'T2': { title: 'Another task', status: 'done' },
    })

    getWorktreeStatusesMock.mockResolvedValue(new Map())

    const res = await taskRoutes.request('/test-project', { method: 'GET' })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.tasks['T1'].worktreeStatus).toBeUndefined()
    expect(json.tasks['T2'].worktreeStatus).toBeUndefined()
  })

  it('returns an empty graph when the task store has no tasks.json yet', async () => {
    getWorktreeStatusesMock.mockResolvedValue(new Map())
    const res = await taskRoutes.request('/test-project', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tasks: {} })
  })
})
