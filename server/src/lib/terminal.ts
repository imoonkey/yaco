import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { closeSync } from 'node:fs'
import { validateSessionName } from './session-names'
import { buildChildProcessEnv } from './ssh-auth'
import { PTY_MAX_BUFFER_SIZE } from './constants'
import { assertCanSpawn } from './pty-capacity'

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
  return buffer.length > PTY_MAX_BUFFER_SIZE ? buffer.slice(-PTY_MAX_BUFFER_SIZE) : buffer
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

export function getShellSessionCount(): number {
  return shellSessions.size
}

export function startShellSession(cwd: string, project: string, requestedName?: string): string {
  const name = requestedName?.trim() || nextShellSessionName()
  validateSessionName(name)

  if (shellSessions.has(name)) {
    throw new Error(`Session already exists: ${name}`)
  }

  assertCanSpawn()

  const proc = pty.spawn(process.env.SHELL ?? 'bash', ['--login'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: buildChildProcessEnv(),
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

  assertCanSpawn()

  const proc = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cols,
    rows,
    env: buildChildProcessEnv(),
  })

  return {
    initialData: '',
    persistent: false,
    proc,
  }
}

export function releaseSession(sessionName: string, attached: AttachedSession): void {
  validateSessionName(sessionName)

  if (attached.persistent) {
    return
  }

  // SIGHUP before destroy — faster child termination. node-pty's destroy()
  // queues SIGHUP behind its socket-close event, which on macOS occasionally
  // lags. Sending it directly shortens the window.
  try { attached.proc.kill('SIGHUP') } catch { /* already dead */ }
  attached.proc.destroy()

  // Backstop for node-pty's known macOS leak: its destroy() relies on a
  // socket-close event that "sometimes never gets closed" (see node-pty
  // unixTerminal.js around line 86). Without an explicit close(2) on the
  // master fd, /dev/ptmx fds accumulate — empirically ~10/h on this box,
  // hitting the 511-slot ceiling within days. Wait past node-pty's own
  // 200ms exit-path timeout, then force-close. EBADF (already closed) is
  // the expected happy path on most calls and is silently ignored.
  const fd = (attached.proc as unknown as { fd?: number }).fd
  if (typeof fd === 'number' && fd >= 0) {
    setTimeout(() => {
      try { closeSync(fd) } catch { /* already closed */ }
    }, 500).unref()
  }
}
