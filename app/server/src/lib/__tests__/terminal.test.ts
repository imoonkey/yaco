import { EventEmitter } from 'events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  spawnMock,
  tmuxSpawnMock,
  validateSessionNameMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  tmuxSpawnMock: vi.fn(),
  validateSessionNameMock: vi.fn(),
}))

/** Everything written to a tmux child's stdin, in call order. */
const tmuxStdin: string[] = []

/** Adapt a `{ status, stderr, error? }` verdict from tmuxSpawnMock into the
 *  slice of the ChildProcess surface that terminal.ts consumes. */
function fakeTmuxChild(result: { status: number | null; stderr?: string; error?: Error }) {
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  const stdin = Object.assign(new EventEmitter(), {
    end: vi.fn((input?: string) => { tmuxStdin.push(String(input ?? '')) }),
  })
  const child = Object.assign(new EventEmitter(), { stderr, stdin })
  queueMicrotask(() => {
    if (result.stderr) stderr.emit('data', result.stderr)
    if (result.error) child.emit('error', result.error)
    else child.emit('close', result.status)
  })
  return child
}

const aliveTmuxSessions = new Set<string>()
const TEST_STATE_DIR = join(process.cwd(), '.tmp', 'terminal-test', 'shell-sessions')

function writeShellState(name: string, project = 'workflow'): void {
  mkdirSync(TEST_STATE_DIR, { recursive: true })
  writeFileSync(join(TEST_STATE_DIR, `${name}.json`), JSON.stringify({
    name,
    project,
    cwd: '/tmp/project',
    createdAt: '2026-05-10T00:00:00.000Z',
  }), 'utf-8')
}

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execSync: vi.fn(() => 'yaco\n'),
    spawn: (...args: unknown[]) => fakeTmuxChild(tmuxSpawnMock(...args)),
  }
})

vi.mock('../ssh-auth', () => ({
  buildChildProcessEnv: vi.fn(() => ({ PATH: process.env.PATH ?? '' })),
}))

vi.mock('../clipboard-env', () => ({
  discoverClipboardEnv: vi.fn(() => ({})),
}))

vi.mock('../session-names', () => ({
  validateSessionName: validateSessionNameMock,
}))

const {
  attachSession,
  closeShellSession,
  listShellSessions,
  MAX_TERMINAL_TEXT_PASTE_BYTES,
  pasteTextToSession,
  reconcileShellSessionExit,
  releaseSession,
  setShellSessionChangeCallback,
  startShellSession,
} = await import('../terminal')
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
    process.env.WORKFLOW_SHELL_SESSIONS_DIR = TEST_STATE_DIR
    rmSync(TEST_STATE_DIR, { recursive: true, force: true })
    aliveTmuxSessions.clear()
    tmuxStdin.length = 0
    vi.clearAllMocks()
    resetPtyCapacity()
    setShellSessionChangeCallback(() => {})
    tmuxSpawnMock.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('tmux')
      const [action] = args
      if (action === 'has-session') {
        const name = args[args.indexOf('-t') + 1]
        return { status: aliveTmuxSessions.has(name) ? 0 : 1, stdout: '', stderr: '' }
      }
      if (action === 'new-session') {
        const name = args[args.indexOf('-s') + 1]
        if (aliveTmuxSessions.has(name)) {
          return { status: 1, stdout: '', stderr: 'duplicate session' }
        }
        aliveTmuxSessions.add(name)
        return { status: 0, stdout: '', stderr: '' }
      }
      if (action === 'kill-session') {
        const name = args[args.indexOf('-t') + 1]
        const existed = aliveTmuxSessions.delete(name)
        return { status: existed ? 0 : 1, stdout: '', stderr: existed ? '' : 'no such session' }
      }
      if (action === 'set-option') {
        const target = args[args.indexOf('-t') + 1]
        const name = target.replace(/^=/, '').replace(/:$/, '')
        return { status: aliveTmuxSessions.has(name) ? 0 : 1, stdout: '', stderr: aliveTmuxSessions.has(name) ? '' : 'no such session' }
      }
      if (action === 'load-buffer' || action === 'paste-buffer' || action === 'delete-buffer') {
        return { status: 0, stdout: '', stderr: '' }
      }
      throw new Error(`unexpected tmux action: ${action}`)
    })
  })

  it('attaches to the tmux session using the handle directly', async () => {
    const proc = createPty()
    spawnMock.mockReturnValue(proc)

    const attached = await attachSession('worker', 120, 40)

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

  it('uses a namespace import for node-pty so tsx/ESM gets a real spawn function', async () => {
    const source = readFileSync(join(__dirname, '..', 'terminal.ts'), 'utf-8')
    expect(source).toMatch(/import \* as pty from 'node-pty'/)
  })

  it('starts shell sessions as YACO-managed tmux sessions', async () => {
    const shellName = await startShellSession('/tmp/project', 'workflow', 'shell-1')

    expect(shellName).toBe('shell-1')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(tmuxSpawnMock).toHaveBeenCalledWith('tmux', [
      'new-session',
      '-d',
      '-s',
      'shell-1',
      '-c',
      '/tmp/project',
      expect.stringContaining('-li'),
    ], expect.objectContaining({ env: expect.anything() }))
    expect(await listShellSessions()).toEqual([
      {
        name: 'shell-1',
        provider: 'shell',
        status: 'idle',
        project: 'workflow',
      },
    ])
  })

  it('enables tmux mouse for YACO-managed shell sessions', async () => {
    const shellName = await startShellSession('/tmp/project', 'workflow', 'shell-1')

    expect(tmuxSpawnMock).toHaveBeenCalledWith('tmux', [
      'set-option',
      '-t',
      `=${shellName}:`,
      'mouse',
      'on',
    ], expect.objectContaining({ env: expect.anything() }))
  })

  it('reattaches shell sessions through tmux attach clients', async () => {
    const proc = createPty()
    spawnMock.mockReturnValue(proc)

    const shellName = await startShellSession('/tmp/project', 'workflow', 'shell-1')
    tmuxSpawnMock.mockClear()
    const attached = await attachSession(shellName, 80, 24)

    expect(tmuxSpawnMock).toHaveBeenCalledWith('tmux', [
      'set-option',
      '-t',
      `=${shellName}:`,
      'mouse',
      'on',
    ], expect.objectContaining({ env: expect.anything() }))
    expect(spawnMock).toHaveBeenCalledWith('tmux', ['attach-session', '-t', 'shell-1'], expect.objectContaining({
      cols: 80,
      rows: 24,
      name: 'xterm-256color',
    }))
    expect(attached).toEqual({
      initialData: '',
      persistent: false,
      proc,
    })

    releaseSession(shellName, attached)

    expect(proc.destroy).toHaveBeenCalled()
    expect(aliveTmuxSessions.has(shellName)).toBe(true)
  })

  it('closes managed shell sessions by killing tmux and removing state', async () => {
    const shellName = await startShellSession('/tmp/project', 'workflow', 'shell-1')
    await closeShellSession(shellName)

    expect(aliveTmuxSessions.has(shellName)).toBe(false)
    expect(await listShellSessions()).toEqual([])
  })

  it('does not close arbitrary tmux sessions without workflow shell state', async () => {
    aliveTmuxSessions.add('shell-1')

    expect(await closeShellSession('shell-1')).toBe(false)
    expect(aliveTmuxSessions.has('shell-1')).toBe(true)
  })

  it('prunes stale shell state when tmux session is gone', async () => {
    await startShellSession('/tmp/project', 'workflow', 'shell-1')
    aliveTmuxSessions.delete('shell-1')

    expect(await listShellSessions()).toEqual([])
    expect(await closeShellSession('shell-1')).toBe(false)
  })

  it('reconciles a managed shell when its tmux attach exits after shell exit', async () => {
    const shellName = await startShellSession('/tmp/project', 'workflow', 'shell-1')
    const onChange = vi.fn()
    setShellSessionChangeCallback(onChange)
    aliveTmuxSessions.delete(shellName)

    expect(await reconcileShellSessionExit(shellName)).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(await listShellSessions()).toEqual([])
  })

  it('keeps managed shell state when a tmux attach exits but the session still lives', async () => {
    const shellName = await startShellSession('/tmp/project', 'workflow', 'shell-1')
    const onChange = vi.fn()
    setShellSessionChangeCallback(onChange)

    expect(await reconcileShellSessionExit(shellName)).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    expect(await listShellSessions()).toEqual([
      {
        name: shellName,
        provider: 'shell',
        status: 'idle',
        project: 'workflow',
      },
    ])
  })

  it('keeps shell state when tmux existence check fails', async () => {
    writeShellState('shell-1')
    tmuxSpawnMock.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('tmux')
      if (args[0] === 'has-session') {
        return { status: null, stdout: '', stderr: '', error: new Error('tmux unavailable') }
      }
      throw new Error(`unexpected tmux action: ${args[0]}`)
    })

    expect(await listShellSessions()).toEqual([
      {
        name: 'shell-1',
        provider: 'shell',
        status: 'idle',
        project: 'workflow',
      },
    ])
    expect(readFileSync(join(TEST_STATE_DIR, 'shell-1.json'), 'utf-8')).toContain('shell-1')
  })

  it('throws instead of removing state when closing with unknown tmux state', async () => {
    writeShellState('shell-1')
    tmuxSpawnMock.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('tmux')
      if (args[0] === 'has-session') {
        return { status: 2, stdout: '', stderr: 'socket unavailable' }
      }
      throw new Error(`unexpected tmux action: ${args[0]}`)
    })

    await expect(closeShellSession('shell-1')).rejects.toThrow(/Cannot determine/)
    expect(readFileSync(join(TEST_STATE_DIR, 'shell-1.json'), 'utf-8')).toContain('shell-1')
  })

  it('cleans state when tmux creation fails after prewriting ownership', async () => {
    tmuxSpawnMock.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('tmux')
      if (args[0] === 'has-session') {
        return { status: 1, stdout: '', stderr: '' }
      }
      if (args[0] === 'new-session') {
        return { status: 1, stdout: '', stderr: 'new failed' }
      }
      throw new Error(`unexpected tmux action: ${args[0]}`)
    })

    await expect(startShellSession('/tmp/project', 'workflow', 'shell-1')).rejects.toThrow(/new failed/)
    expect(await listShellSessions()).toEqual([])
  })

  it('removes state files whose basename does not match the embedded name', async () => {
    mkdirSync(TEST_STATE_DIR, { recursive: true })
    writeFileSync(join(TEST_STATE_DIR, 'shell-1.json'), JSON.stringify({
      name: 'shell-2',
      project: 'workflow',
      cwd: '/tmp/project',
      createdAt: '2026-05-10T00:00:00.000Z',
    }), 'utf-8')
    aliveTmuxSessions.add('shell-2')

    expect(await listShellSessions()).toEqual([])
  })

  it('skips live tmux names when allocating shell handles', async () => {
    aliveTmuxSessions.add('shell-1')

    expect(await startShellSession('/tmp/project', 'workflow')).toBe('shell-2')
  })

  it('destroys non-persistent tmux attach processes on release', async () => {
    const proc = createPty()
    spawnMock.mockReturnValue(proc)
    const attached = await attachSession('worker', 80, 24)
    releaseSession('worker', attached)

    expect(proc.destroy).toHaveBeenCalled()
  })

  it('rejects tmux attaches under pressure without calling pty.spawn', async () => {
    markDegraded('test')

    await expect(attachSession('worker', 80, 24)).rejects.toThrow(PtyCapacityError)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('reattaching to shell sessions uses the same pressure gate as other tmux attaches', async () => {
    const shellName = await startShellSession('/tmp/project', 'workflow', 'shell-p')

    markDegraded('test')
    spawnMock.mockClear()

    await expect(attachSession(shellName, 80, 24)).rejects.toThrow(PtyCapacityError)
    expect(spawnMock).not.toHaveBeenCalled()
    await closeShellSession(shellName)
  })

  it('pastes terminal text through a tmux bracketed paste buffer without submitting', async () => {
    await pasteTextToSession('worker', 'hello\nworld')

    const loadCall = tmuxSpawnMock.mock.calls.find(([, args]) => args[0] === 'load-buffer')
    expect(loadCall).toBeDefined()
    const bufferName = loadCall![1][loadCall![1].indexOf('-b') + 1]
    expect(bufferName).toMatch(/^yaco-/)
    expect(tmuxStdin).toContain('hello\nworld')

    expect(tmuxSpawnMock).toHaveBeenCalledWith('tmux', [
      'paste-buffer',
      '-p',
      '-t',
      '=worker:',
      '-b',
      bufferName,
    ], expect.objectContaining({ env: expect.anything() }))
    expect(tmuxSpawnMock).toHaveBeenCalledWith('tmux', [
      'delete-buffer',
      '-b',
      bufferName,
    ], expect.objectContaining({ env: expect.anything() }))
    expect(tmuxSpawnMock.mock.calls.some(([, args]) => args[0] === 'send-keys')).toBe(false)
  })

  it('rejects oversized terminal text paste payloads before invoking tmux', async () => {
    await expect(pasteTextToSession('worker', 'x'.repeat(MAX_TERMINAL_TEXT_PASTE_BYTES + 1))).rejects.toThrow(/exceeds/)
    expect(tmuxSpawnMock).not.toHaveBeenCalled()
  })
})
