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
})
