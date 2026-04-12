import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'

const { mockedSessionsDir } = vi.hoisted(() => ({
  mockedSessionsDir: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/workflow-multmux-test-sessions-${process.pid}`,
}))

// Must mock before importing the module under test
vi.mock('../session-names', () => ({
  validateSessionName: (name: string) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error(`Invalid: ${name}`)
  },
}))

vi.mock('../constants', () => ({
  MULTMUX_COMMAND_TIMEOUT_MS: 5_000,
  MULTMUX_SESSIONS_DIR: mockedSessionsDir,
  MULTMUX_START_TIMEOUT_MS: 15_000,
  MULTMUX_PATH: 'multmux',
}))

import { readAllSessionsFromStateFiles, readSessionsFromStateFiles, type MultmuxStateFile } from '../multmux'

function writeStateFile(dir: string, handle: string, overrides: Partial<MultmuxStateFile> = {}) {
  const state: MultmuxStateFile = {
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

  it('returns empty array when the global sessions dir does not exist', () => {
    rmSync(mockedSessionsDir, { recursive: true })
    expect(readSessionsFromStateFiles(project())).toEqual([])
  })

  it('reads idle session correctly', () => {
    writeStateFile(mockedSessionsDir, '1-claude', { status: 'idle', sessionPath: tmpDir })
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      name: '1-claude',
      provider: 'claude',
      status: 'idle',
      project: 'test-project',
      sessionPath: tmpDir,
      sessionId: 'abc-123',
    })
  })

  it('reads processing session correctly', () => {
    writeStateFile(mockedSessionsDir, 'worker-1', { status: 'processing', provider: 'codex', sessionPath: tmpDir })
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      name: 'worker-1',
      provider: 'codex',
      status: 'processing',
    })
  })

  it('passes through starting status without normalization', () => {
    writeStateFile(mockedSessionsDir, 'new-session', { status: 'starting', sessionPath: tmpDir })
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.status).toBe('starting')
  })

  it('excludes sessions with unknown status', () => {
    // Simulate a state file with an unrecognized status value
    const state = {
      handle: 'ghost',
      provider: 'claude',
      sessionPath: tmpDir,
      pid: 99999,
      sessionId: '',
      status: 'stopped', // multmux no longer writes this, but test the guard
      createdAt: '2026-03-24T00:00:00.000Z',
    }
    writeFileSync(join(mockedSessionsDir, 'ghost.json'), JSON.stringify(state))
    expect(readSessionsFromStateFiles(project())).toEqual([])
  })

  it('handles multiple sessions', () => {
    writeStateFile(mockedSessionsDir, '1-claude', { status: 'idle', sessionPath: tmpDir })
    writeStateFile(mockedSessionsDir, '2-codex', { status: 'processing', provider: 'codex', sessionPath: tmpDir })
    writeStateFile(mockedSessionsDir, '3-claude', { status: 'starting', sessionPath: tmpDir })
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(3)
    expect(sessions.map(s => s.name).sort()).toEqual(['1-claude', '2-codex', '3-claude'])
  })

  it('skips malformed JSON files', () => {
    writeStateFile(mockedSessionsDir, 'good', { status: 'idle', sessionPath: tmpDir })
    writeFileSync(join(mockedSessionsDir, 'bad.json'), 'not json{{{')
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.name).toBe('good')
  })

  it('skips non-json files', () => {
    writeStateFile(mockedSessionsDir, 'real', { status: 'idle', sessionPath: tmpDir })
    writeFileSync(join(mockedSessionsDir, 'readme.txt'), 'not a state file')
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
  })

  it('infers provider from handle when provider field is invalid', () => {
    const state = {
      handle: 'my-codex-worker',
      provider: 'unknown-provider', // invalid
      sessionPath: tmpDir,
      pid: 12345,
      sessionId: '',
      status: 'idle',
      createdAt: '2026-03-24T00:00:00.000Z',
    }
    writeFileSync(join(mockedSessionsDir, 'my-codex-worker.json'), JSON.stringify(state))
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('codex')
  })

  it('defaults empty sessionId to empty string', () => {
    writeStateFile(mockedSessionsDir, 'no-sid', { sessionId: undefined as unknown as string, sessionPath: tmpDir })
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions[0]!.sessionId).toBe('')
  })

  it('filters to sessions whose sessionPath is under the project path', () => {
    writeStateFile(mockedSessionsDir, 'nested', { sessionPath: join(tmpDir, 'server') })
    writeStateFile(mockedSessionsDir, 'outside', { sessionPath: `${tmpDir}-other` })

    const sessions = readSessionsFromStateFiles(project())

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.name).toBe('nested')
  })

  it('uses the most specific matching project when reading all sessions', () => {
    const parent = tmpDir
    const child = join(tmpDir, 'server')
    writeStateFile(mockedSessionsDir, 'child-session', { sessionPath: child })

    const sessions = readAllSessionsFromStateFiles([
      { name: 'parent', path: parent },
      { name: 'child', path: child },
    ])

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('child')
  })
})
