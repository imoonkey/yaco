import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  spawnMock,
  validateSessionNameMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  validateSessionNameMock: vi.fn(),
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}))

vi.mock('../session-names', () => ({
  validateSessionName: validateSessionNameMock,
}))

import { attachSession, closeShellSession, releaseSession, startShellSession } from '../terminal'
import { PtyCapacityError, markDegraded, __resetForTests as resetPtyCapacity } from '../pty-capacity'

function createPty() {
  return {
    pid: 12345,
    destroy: vi.fn(),
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
    resetPtyCapacity()
  })

  it('attaches to the tmux session using the handle directly', () => {
    const proc = createPty()
    spawnMock.mockReturnValue(proc)

    const attached = attachSession('worker', 120, 40)

    expect(validateSessionNameMock).toHaveBeenCalledWith('worker')
    expect(spawnMock).toHaveBeenCalledWith('tmux', ['attach-session', '-t', 'worker'], expect.objectContaining({
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

  it('uses a namespace import for node-pty so tsx/ESM gets a real spawn function', () => {
    const source = readFileSync(join(__dirname, '..', 'terminal.ts'), 'utf-8')
    expect(source).toMatch(/import \* as pty from 'node-pty'/)
  })

  it('tracks shell sessions as persistent attachments and releases them without killing the shell', () => {
    const proc = createPty()
    spawnMock.mockReturnValue(proc)

    const shellName = startShellSession('/tmp/project', 'workflow', 'shell-1')
    const attached = attachSession(shellName, 80, 24)

    expect(attached).toEqual({
      initialData: '',
      persistent: true,
      proc,
    })

    releaseSession(shellName, attached)

    expect(proc.resize).toHaveBeenCalledWith(80, 24)
    expect(proc.destroy).not.toHaveBeenCalled()

    closeShellSession(shellName)
    expect(proc.kill).toHaveBeenCalled()
  })

  it('destroys non-persistent tmux attach processes on release', () => {
    const proc = createPty()
    spawnMock.mockReturnValue(proc)
    const attached = attachSession('worker', 80, 24)
    releaseSession('worker', attached)

    expect(proc.destroy).toHaveBeenCalled()
  })

  it('rejects tmux attaches under pressure without calling pty.spawn', () => {
    markDegraded('test')

    expect(() => attachSession('worker', 80, 24)).toThrow(PtyCapacityError)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('reattaching to an existing shell session bypasses the pressure gate', () => {
    const proc = createPty()
    spawnMock.mockReturnValue(proc)
    const shellName = startShellSession('/tmp/project', 'workflow', 'shell-p')

    markDegraded('test')
    spawnMock.mockClear()
    const attached = attachSession(shellName, 80, 24)

    expect(attached.persistent).toBe(true)
    expect(spawnMock).not.toHaveBeenCalled()
    closeShellSession(shellName)
  })
})
