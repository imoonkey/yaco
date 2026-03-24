import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'

// Must mock before importing the module under test
vi.mock('../session-names', () => ({
  validateSessionName: (name: string) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error(`Invalid: ${name}`)
  },
}))

import { readSessionsFromStateFiles, type MultmuxStateFile } from '../multmux'

function writeStateFile(dir: string, handle: string, overrides: Partial<MultmuxStateFile> = {}) {
  const state: MultmuxStateFile = {
    handle,
    provider: 'claude',
    tmuxSession: `${handle}-project-mt`,
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
  let multmuxDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-test-'))
    multmuxDir = join(tmpDir, '.multmux')
    mkdirSync(multmuxDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const project = () => ({ name: 'test-project', path: tmpDir })

  it('returns empty array when .multmux dir does not exist', () => {
    rmSync(multmuxDir, { recursive: true })
    expect(readSessionsFromStateFiles(project())).toEqual([])
  })

  it('reads idle session correctly', () => {
    writeStateFile(multmuxDir, '1-claude', { status: 'idle' })
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      name: '1-claude',
      provider: 'claude',
      status: 'idle',
      project: 'test-project',
      sessionId: 'abc-123',
    })
  })

  it('reads processing session correctly', () => {
    writeStateFile(multmuxDir, 'worker-1', { status: 'processing', provider: 'codex' })
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      name: 'worker-1',
      provider: 'codex',
      status: 'processing',
    })
  })

  it('normalizes starting → idle', () => {
    writeStateFile(multmuxDir, 'new-session', { status: 'starting' })
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.status).toBe('idle')
  })

  it('excludes sessions with unknown status', () => {
    // Simulate a state file with an unrecognized status value
    const state = {
      handle: 'ghost',
      provider: 'claude',
      tmuxSession: 'ghost-project-mt',
      pid: 99999,
      sessionId: '',
      status: 'stopped', // multmux no longer writes this, but test the guard
      createdAt: '2026-03-24T00:00:00.000Z',
    }
    writeFileSync(join(multmuxDir, 'ghost.json'), JSON.stringify(state))
    expect(readSessionsFromStateFiles(project())).toEqual([])
  })

  it('handles multiple sessions', () => {
    writeStateFile(multmuxDir, '1-claude', { status: 'idle' })
    writeStateFile(multmuxDir, '2-codex', { status: 'processing', provider: 'codex' })
    writeStateFile(multmuxDir, '3-claude', { status: 'starting' })
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(3)
    expect(sessions.map(s => s.name).sort()).toEqual(['1-claude', '2-codex', '3-claude'])
  })

  it('skips malformed JSON files', () => {
    writeStateFile(multmuxDir, 'good', { status: 'idle' })
    writeFileSync(join(multmuxDir, 'bad.json'), 'not json{{{')
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.name).toBe('good')
  })

  it('skips non-json files', () => {
    writeStateFile(multmuxDir, 'real', { status: 'idle' })
    writeFileSync(join(multmuxDir, 'readme.txt'), 'not a state file')
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
  })

  it('infers provider from handle when provider field is invalid', () => {
    const state = {
      handle: 'my-codex-worker',
      provider: 'unknown-provider', // invalid
      tmuxSession: 'my-codex-worker-project-mt',
      pid: 12345,
      sessionId: '',
      status: 'idle',
      createdAt: '2026-03-24T00:00:00.000Z',
    }
    writeFileSync(join(multmuxDir, 'my-codex-worker.json'), JSON.stringify(state))
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('codex')
  })

  it('defaults empty sessionId to empty string', () => {
    writeStateFile(multmuxDir, 'no-sid', { sessionId: undefined as unknown as string })
    const sessions = readSessionsFromStateFiles(project())
    expect(sessions[0]!.sessionId).toBe('')
  })
})
