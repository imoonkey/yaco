import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  appendedTaskIds: [] as string[],
  tasks: {
    'active-done': {
      parent: null,
      depends: [],
      state: 'done',
      workset: 'active',
      title: 'Active done task',
      stateEnteredAt: '2026-08-17T12:00:00.000Z',
    },
    'archived-v0.1': {
      parent: null,
      depends: [],
      state: 'done',
      workset: 'archive',
      title: 'Archived task',
      stateEnteredAt: '2026-08-17T12:00:00.000Z',
    },
  },
}))

vi.mock('yaco-cli/core/paths', () => ({
  readYacoProjectPaths: () => ({ tasks: 'plan/tasks' }),
}))

vi.mock('yaco-cli/core/task', () => ({
  loadTaskStore: async () => ({ tasks: state.tasks }),
}))

vi.mock('../projects', () => ({
  loadProjects: async () => [{ name: 'yaco', path: '/repo/yaco' }],
}))

vi.mock('../agent', () => ({ readAllSessionsFromStateFiles: async () => [] }))
vi.mock('../notify', () => ({ broadcastAttention: vi.fn() }))
vi.mock('../ui-state', () => ({
  getPinnedSessions: async () => [],
  getUnreadWatermarks: async () => ({ projectReadAt: {}, sessionReadAt: {} }),
  getDismissedActGenerations: async () => new Set<string>(),
  removeDismissedActGenerations: async () => {},
}))
vi.mock('../eventsLog', () => ({
  readEvents: async () => [],
  appendEvent: async (_projectId: string, event: { taskId?: string }) => {
    if (event.taskId) state.appendedTaskIds.push(event.taskId)
    return event
  },
}))

const { startAttentionEngine, stopAttentionEngine } = await import('../attention-runtime')

describe('attention runtime task loading', () => {
  afterEach(() => {
    stopAttentionEngine()
    state.appendedTaskIds.length = 0
  })

  it('does not generate live attention edges for archived tasks', async () => {
    await startAttentionEngine()

    expect(state.appendedTaskIds).toEqual(['active-done'])
  })
})
