import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'

const { mockedSessionsDir } = vi.hoisted(() => ({
  mockedSessionsDir: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/workflow-agent-test-sessions-${process.pid}`,
}))

// Must mock before importing the module under test
vi.mock('../session-names', () => ({
  validateSessionName: (name: string) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error(`Invalid: ${name}`)
  },
}))

vi.mock('../constants', () => ({
  YACO_AGENT_COMMAND_TIMEOUT_MS: 5_000,
  AGENT_SESSIONS_DIR: mockedSessionsDir,
  YACO_AGENT_START_TIMEOUT_MS: 15_000,
  YACO_AGENT_STATUS_TIMEOUT_MS: 10_000,
  YACO_PATH: 'yaco',
}))

import { readAllSessionsFromStateFiles, readSessionsFromStateFiles, type AgentSessionState } from '../agent'
import { NOTICE_MAX } from '@yaco/cli/core/agent'

function writeStateFile(dir: string, handle: string, overrides: Partial<AgentSessionState> = {}) {
  const state: AgentSessionState = {
    handle,
    provider: 'claude',
    sessionPath: '/tmp/project',
    pid: 12345,
    sessionId: 'abc-123',
    status: 'idle',
    createdAt: '2026-03-24T00:00:00.000Z',
    ...overrides,
  }
  writeFileSync(join(dir, `${handle}.json`), JSON.stringify(state))
}

describe('readSessionsFromStateFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-test-'))
    rmSync(mockedSessionsDir, { recursive: true, force: true })
    mkdirSync(mockedSessionsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    rmSync(mockedSessionsDir, { recursive: true, force: true })
  })

  const project = () => ({ name: 'test-project', path: tmpDir })

  it('returns empty array when the global sessions dir does not exist', async () => {
    rmSync(mockedSessionsDir, { recursive: true })
    expect(await readSessionsFromStateFiles(project())).toEqual([])
  })

  it('reads idle session correctly', async () => {
    writeStateFile(mockedSessionsDir, '1-claude', { status: 'idle', sessionPath: tmpDir })
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      name: '1-claude',
      provider: 'claude',
      status: 'idle',
      project: 'test-project',
      projectPath: tmpDir,
      sessionPath: tmpDir,
      sessionId: 'abc-123',
    })
  })

  it('reads processing session correctly', async () => {
    writeStateFile(mockedSessionsDir, 'worker-1', { status: 'processing', provider: 'codex', sessionPath: tmpDir })
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      name: 'worker-1',
      provider: 'codex',
      status: 'processing',
    })
  })

  it('passes through starting status without normalization', async () => {
    writeStateFile(mockedSessionsDir, 'new-session', { status: 'starting', sessionPath: tmpDir })
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.status).toBe('starting')
  })

  it('reads a blocked session with its blockReason', async () => {
    writeStateFile(mockedSessionsDir, 'waiting', {
      status: 'blocked',
      blockReason: 'permission',
      sessionPath: tmpDir,
    })
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ name: 'waiting', status: 'blocked', blockReason: 'permission' })
  })

  it('carries a CLI-written notice from the state file onto the row (F3 plumbing)', async () => {
    // The real state-file → AgentSessionState → toSessionRow → AgentSession hop
    // that the projector/engine unit tests stub by injecting LiveSession.notice.
    writeStateFile(mockedSessionsDir, 'asker', {
      status: 'blocked',
      blockReason: 'question',
      sessionPath: tmpDir,
      notice: 'Ship v1 or wait for review?',
    })
    const single = await readSessionsFromStateFiles(project())
    expect(single[0]?.notice).toBe('Ship v1 or wait for review?')
    const all = await readAllSessionsFromStateFiles([project()])
    expect(all[0]?.notice).toBe('Ship v1 or wait for review?')
  })

  it('carries interrupt idleReason from the state file onto the row', async () => {
    writeStateFile(mockedSessionsDir, 'interrupted', {
      status: 'idle',
      sessionPath: tmpDir,
      idleReason: 'interrupted',
    })

    const single = await readSessionsFromStateFiles(project())
    expect(single[0]?.idleReason).toBe('interrupted')
    const all = await readAllSessionsFromStateFiles([project()])
    expect(all[0]?.idleReason).toBe('interrupted')
  })

  it('re-clamps an oversized state-file notice at the read boundary', async () => {
    writeStateFile(mockedSessionsDir, 'verbose', { status: 'blocked', blockReason: 'question', sessionPath: tmpDir, notice: 'z'.repeat(NOTICE_MAX + 300) })
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions[0]?.notice?.length).toBe(NOTICE_MAX + 1) // NOTICE_MAX + ellipsis
  })

  it('drops a stray blockReason when status is not blocked', async () => {
    writeStateFile(mockedSessionsDir, 'idle-stray', {
      status: 'idle',
      blockReason: 'question',
      sessionPath: tmpDir,
    } as Partial<AgentSessionState>)
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.status).toBe('idle')
    expect(sessions[0]).not.toHaveProperty('blockReason')
  })

  it('excludes sessions with unknown status', async () => {
    // Simulate a state file with an unrecognized status value
    const state = {
      handle: 'ghost',
      provider: 'claude',
      sessionPath: tmpDir,
      pid: 99999,
      sessionId: '',
      status: 'stopped', // yaco agent no longer writes this, but test the guard
      createdAt: '2026-03-24T00:00:00.000Z',
    }
    writeFileSync(join(mockedSessionsDir, 'ghost.json'), JSON.stringify(state))
    expect(await readSessionsFromStateFiles(project())).toEqual([])
  })

  it('handles multiple sessions', async () => {
    writeStateFile(mockedSessionsDir, '1-claude', { status: 'idle', sessionPath: tmpDir })
    writeStateFile(mockedSessionsDir, '2-codex', { status: 'processing', provider: 'codex', sessionPath: tmpDir })
    writeStateFile(mockedSessionsDir, '3-claude', { status: 'starting', sessionPath: tmpDir })
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(3)
    expect(sessions.map(s => s.name).sort()).toEqual(['1-claude', '2-codex', '3-claude'])
  })

  it('skips malformed JSON files', async () => {
    writeStateFile(mockedSessionsDir, 'good', { status: 'idle', sessionPath: tmpDir })
    writeFileSync(join(mockedSessionsDir, 'bad.json'), 'not json{{{')
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.name).toBe('good')
  })

  it('skips non-json files', async () => {
    writeStateFile(mockedSessionsDir, 'real', { status: 'idle', sessionPath: tmpDir })
    writeFileSync(join(mockedSessionsDir, 'readme.txt'), 'not a state file')
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
  })

  it('trusts the provider string from the state file verbatim', async () => {
    // Handle says "codex" but provider says "gemini": no inference happens —
    // the YACO-owned provider field is the single source of truth.
    const state = {
      handle: 'my-codex-worker',
      provider: 'gemini',
      sessionPath: tmpDir,
      pid: 12345,
      sessionId: '',
      status: 'idle',
      createdAt: '2026-03-24T00:00:00.000Z',
    }
    writeFileSync(join(mockedSessionsDir, 'my-codex-worker.json'), JSON.stringify(state))
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('gemini')
  })

  it('excludes sessions with a missing provider field', async () => {
    const state = {
      handle: 'no-provider',
      sessionPath: tmpDir,
      pid: 12345,
      sessionId: '',
      status: 'idle',
      createdAt: '2026-03-24T00:00:00.000Z',
    }
    writeFileSync(join(mockedSessionsDir, 'no-provider.json'), JSON.stringify(state))
    expect(await readSessionsFromStateFiles(project())).toEqual([])
  })

  it('defaults empty sessionId to empty string', async () => {
    writeStateFile(mockedSessionsDir, 'no-sid', { sessionId: undefined as unknown as string, sessionPath: tmpDir })
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions[0]!.sessionId).toBe('')
  })

  it('filters to sessions whose sessionPath is under the project path', async () => {
    writeStateFile(mockedSessionsDir, 'nested', { sessionPath: join(tmpDir, 'server') })
    writeStateFile(mockedSessionsDir, 'outside', { sessionPath: `${tmpDir}-other` })

    const sessions = await readSessionsFromStateFiles(project())

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.name).toBe('nested')
  })

  it('uses the most specific matching project when reading all sessions', async () => {
    const parent = tmpDir
    const child = join(tmpDir, 'server')
    writeStateFile(mockedSessionsDir, 'child-session', { sessionPath: child })

    const sessions = await readAllSessionsFromStateFiles([
      { name: 'parent', path: parent },
      { name: 'child', path: child },
    ])

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('child')
    expect(sessions[0]!.projectPath).toBe(child)
  })

  it('passes through spawnedBy and parentSession lineage when present', async () => {
    writeStateFile(mockedSessionsDir, 'child', {
      sessionPath: tmpDir,
      spawnedBy: 'agent',
      parentSession: 'parent-handle',
    } as Partial<AgentSessionState>)
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions[0]).toMatchObject({ spawnedBy: 'agent', parentSession: 'parent-handle' })
  })

  it('omits lineage fields for legacy state files without them', async () => {
    writeStateFile(mockedSessionsDir, 'legacy', { sessionPath: tmpDir })
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions[0]).not.toHaveProperty('spawnedBy')
    expect(sessions[0]).not.toHaveProperty('parentSession')
  })

  it('drops an unknown spawnedBy value', async () => {
    writeStateFile(mockedSessionsDir, 'weird', {
      sessionPath: tmpDir,
      spawnedBy: 'user:carrier-pigeon',
    } as unknown as Partial<AgentSessionState>)
    const sessions = await readSessionsFromStateFiles(project())
    expect(sessions[0]).not.toHaveProperty('spawnedBy')
  })
})
