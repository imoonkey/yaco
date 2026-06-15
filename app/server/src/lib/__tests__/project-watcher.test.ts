import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { isAbsolute, join, relative, sep } from 'path'

const mock = vi.hoisted(() => ({
  sessionsDir: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/workflow-project-watcher-sessions-${process.pid}`,
  projects: [] as { name: string; path: string }[],
  emitCalls: [] as string[],
}))

vi.mock('../constants', () => ({
  AGENT_SESSIONS_DIR: mock.sessionsDir,
}))

vi.mock('../gitignore', () => ({
  getProjectGitignore: vi.fn(async () => null),
  clearGitignoreCache: vi.fn(),
}))

vi.mock('../notify', () => ({
  emitRefresh: (channel: string) => {
    mock.emitCalls.push(channel)
  },
}))

vi.mock('../projects', () => ({
  loadProjects: vi.fn(async () => mock.projects),
}))

vi.mock('../agent', () => ({
  isPathDescendantOrEqual: (candidatePath: string, rootPath: string) => {
    const candidate = candidatePath.replace(/[\\/]+$/, '')
    const root = rootPath.replace(/[\\/]+$/, '')
    const rel = relative(root, candidate)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  },
}))

// The watcher notifies the attention engine on session/task changes; stub the
// triggers so the watcher tests don't construct the real fs-backed engine.
vi.mock('../attention-runtime', () => ({
  notifyAttentionSessionChange: vi.fn(),
  notifyAttentionTaskChange: vi.fn(),
}))

import { startProjectWatchers, stopProjectWatchers } from '../project-watcher'

function writeSession(handle: string, sessionPath: string): void {
  writeFileSync(join(mock.sessionsDir, `${handle}.json`), JSON.stringify({
    handle,
    provider: 'codex',
    sessionPath,
    pid: 123,
    sessionId: '',
    status: 'idle',
    createdAt: '2026-05-15T00:00:00.000Z',
  }))
}

describe('project-watcher agent session refreshes', () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'workflow-project-watcher-'))
    rmSync(mock.sessionsDir, { recursive: true, force: true })
    mkdirSync(mock.sessionsDir, { recursive: true })
    mock.projects = [{ name: 'project', path: projectDir }]
    mock.emitCalls = []
  })

  afterEach(() => {
    stopProjectWatchers()
    rmSync(mock.sessionsDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('emits sessions refresh when an agent session state file is created', async () => {
    await startProjectWatchers(mock.projects)

    writeSession('created-session', projectDir)

    await vi.waitFor(() => {
      expect(mock.emitCalls).toContain('sessions')
    }, { timeout: 2000 })
  })

  it('emits sessions refresh when a primed agent session state file is deleted', async () => {
    writeSession('deleted-session', projectDir)
    await startProjectWatchers(mock.projects)
    mock.emitCalls = []

    rmSync(join(mock.sessionsDir, 'deleted-session.json'))

    await vi.waitFor(() => {
      expect(mock.emitCalls).toContain('sessions')
    }, { timeout: 2000 })
  })

  it('arms the sessions watcher even when the dir is absent at startup (R3 re-arm)', async () => {
    // Start with NO sessions dir — the watcher must poll-until-exists then arm,
    // otherwise the change-driven engine has a cold-start blind spot.
    rmSync(mock.sessionsDir, { recursive: true, force: true })
    await startProjectWatchers(mock.projects)

    // Dir created late (as the agent runtime would on first session).
    mkdirSync(mock.sessionsDir, { recursive: true })
    writeSession('late-session', projectDir)

    await vi.waitFor(() => {
      expect(mock.emitCalls).toContain('sessions')
    }, { timeout: 3000 })
  })

  it('emits a dedicated tasks refresh when a plan/tasks file changes', async () => {
    // Pre-create the task dir so the recursive watch already covers it (avoids a
    // new-subdir watch race), then start the watcher and write the task file.
    const tasksDir = join(projectDir, 'plan', 'tasks', 'inbox')
    mkdirSync(tasksDir, { recursive: true })
    await startProjectWatchers(mock.projects)

    writeFileSync(join(tasksDir, 'tasks.json'), '{}')

    await vi.waitFor(() => {
      expect(mock.emitCalls).toContain('tasks')
    }, { timeout: 2000 })
  })

  it('honors a custom yaco.toml [paths].tasks location for the tasks channel', async () => {
    // Config relocates the task graph to plan/items; a write there must still
    // drive the dedicated 'tasks' channel (not just the hardcoded plan/tasks).
    writeFileSync(join(projectDir, 'yaco.toml'), '[paths]\ntasks = "items"\n')
    const tasksDir = join(projectDir, 'plan', 'items')
    mkdirSync(tasksDir, { recursive: true })
    await startProjectWatchers(mock.projects)

    writeFileSync(join(tasksDir, 'tasks.json'), '{}')

    await vi.waitFor(() => {
      expect(mock.emitCalls).toContain('tasks')
    }, { timeout: 2000 })
  })
})
