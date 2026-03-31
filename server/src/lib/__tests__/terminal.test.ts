import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  spawnMock,
  resolveTmuxSessionMock,
  resolveSessionTmuxNameMock,
  validateSessionNameMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveTmuxSessionMock: vi.fn((name: string) => `${name}-fallback-mt`),
  resolveSessionTmuxNameMock: vi.fn(),
  validateSessionNameMock: vi.fn(),
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}))

vi.mock('../session-names', () => ({
  resolveTmuxSession: resolveTmuxSessionMock,
  validateSessionName: validateSessionNameMock,
}))

vi.mock('../multmux', () => ({
  resolveSessionTmuxName: resolveSessionTmuxNameMock,
}))

import { attachSession } from '../terminal'

function createPty() {
  return {
    pid: 12345,
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
  }
}

describe('attachSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveTmuxSessionMock.mockReturnValue('worker-fallback-mt')
  })

  it('attaches to the project-scoped tmux session when the state file provides one', () => {
    const proc = createPty()
    spawnMock.mockReturnValue(proc)
    resolveSessionTmuxNameMock.mockReturnValue('worker-project-mt')

    const attached = attachSession('worker', 120, 40, '/tmp/project')

    expect(validateSessionNameMock).toHaveBeenCalledWith('worker')
    expect(resolveSessionTmuxNameMock).toHaveBeenCalledWith('/tmp/project', 'worker')
    expect(resolveTmuxSessionMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledWith('tmux', ['attach-session', '-t', 'worker-project-mt'], expect.objectContaining({
      cols: 120,
      rows: 40,
      name: 'xterm-256color',
    }))
    expect(attached).toEqual({
      initialData: '',
      persistent: false,
      proc,
    })
  })

  it('falls back to global tmux resolution when the state file has no tmux name', () => {
    const proc = createPty()
    spawnMock.mockReturnValue(proc)
    resolveSessionTmuxNameMock.mockReturnValue(null)

    attachSession('worker', 80, 24, '/tmp/project')

    expect(resolveTmuxSessionMock).toHaveBeenCalledWith('worker')
    expect(spawnMock).toHaveBeenCalledWith('tmux', ['attach-session', '-t', 'worker-fallback-mt'], expect.any(Object))
  })

  it('uses a namespace import for node-pty so tsx/ESM gets a real spawn function', () => {
    const source = readFileSync(join(__dirname, '..', 'terminal.ts'), 'utf-8')
    expect(source).toMatch(/import \* as pty from 'node-pty'/)
  })
})
