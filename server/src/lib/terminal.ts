import pty from 'node-pty'
import type { IPty } from 'node-pty'
import { resolveTmuxSession, validateSessionName } from './session-names'

const MAX_BUFFER_SIZE = 200_000

export interface ShellSessionSummary {
  name: string
  provider: 'shell'
  status: 'idle'
  project: string
}

interface ShellSession {
  name: string
  project: string
  proc: IPty
  buffer: string
}

export interface AttachedSession {
  initialData: string
  persistent: boolean
  proc: IPty
}

const shellSessions = new Map<string, ShellSession>()

let onSessionChange: (() => void) | null = null

/** Register a callback invoked on shell session start, close, or process exit */
export function setShellSessionChangeCallback(cb: () => void): void {
  onSessionChange = cb
}

function trimBuffer(buffer: string): string {
  return buffer.length > MAX_BUFFER_SIZE ? buffer.slice(-MAX_BUFFER_SIZE) : buffer
}

function nextShellSessionName(): string {
  let index = 1
  while (shellSessions.has(`shell-${index}`)) index += 1
  return `shell-${index}`
}

export function listShellSessions(): ShellSessionSummary[] {
  return [...shellSessions.values()].map(session => ({
    name: session.name,
    provider: 'shell',
    status: 'idle',
    project: session.project,
  }))
}

export function startShellSession(cwd: string, project: string, requestedName?: string): string {
  const name = requestedName?.trim() || nextShellSessionName()
  validateSessionName(name)

  if (shellSessions.has(name)) {
    throw new Error(`Session already exists: ${name}`)
  }

  const proc = pty.spawn(process.env.SHELL ?? 'bash', ['--login'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>,
  })

  const session: ShellSession = {
    name,
    project,
    proc,
    buffer: '',
  }

  proc.onData((data) => {
    session.buffer = trimBuffer(session.buffer + data)
  })

  proc.onExit(() => {
    shellSessions.delete(name)
    onSessionChange?.()
  })

  shellSessions.set(name, session)
  onSessionChange?.()
  return name
}

export function closeShellSession(name: string): boolean {
  validateSessionName(name)
  const session = shellSessions.get(name)
  if (!session) return false

  session.proc.kill()
  shellSessions.delete(name)
  onSessionChange?.()
  return true
}

/** Spawn a PTY attached to a tmux session or a managed shell session. */
export function attachSession(sessionName: string, cols: number, rows: number): AttachedSession {
  validateSessionName(sessionName)
  const shellSession = shellSessions.get(sessionName)

  if (shellSession) {
    shellSession.proc.resize(cols, rows)
    return {
      initialData: shellSession.buffer,
      persistent: true,
      proc: shellSession.proc,
    }
  }

  const tmuxName = resolveTmuxSession(sessionName)
  const proc = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
    name: 'xterm-256color',
    cols,
    rows,
    env: process.env as Record<string, string>,
  })

  return {
    initialData: '',
    persistent: false,
    proc,
  }
}
