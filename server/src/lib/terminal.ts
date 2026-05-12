import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { validateSessionName } from './session-names'
import { buildChildProcessEnv } from './ssh-auth'
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
  cwd: string
  createdAt: string
}

type TmuxSessionState = 'live' | 'missing' | 'unknown'

export interface AttachedSession {
  initialData: string
  persistent: boolean
  proc: IPty
}

const DEFAULT_SHELL_SESSIONS_DIR = join(homedir(), '.workflow', 'shell-sessions')

let onSessionChange: (() => void) | null = null

/** Register a callback invoked on shell session start, close, or process exit */
export function setShellSessionChangeCallback(cb: () => void): void {
  onSessionChange = cb
}

function getShellSessionsDir(): string {
  return process.env.WORKFLOW_SHELL_SESSIONS_DIR || DEFAULT_SHELL_SESSIONS_DIR
}

function shellStatePath(name: string): string {
  validateSessionName(name)
  return join(getShellSessionsDir(), `${name}.json`)
}

function tmuxPaneTarget(name: string): string {
  validateSessionName(name)
  return `=${name}:`
}

function ensureShellSessionsDir(): void {
  mkdirSync(getShellSessionsDir(), { recursive: true })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function parseShellState(raw: string): ShellSession | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ShellSession>
    if (
      typeof parsed.name !== 'string' ||
      typeof parsed.project !== 'string' ||
      typeof parsed.cwd !== 'string' ||
      typeof parsed.createdAt !== 'string'
    ) {
      return null
    }
    validateSessionName(parsed.name)
    return {
      name: parsed.name,
      project: parsed.project,
      cwd: parsed.cwd,
      createdAt: parsed.createdAt,
    }
  } catch {
    return null
  }
}

function removeShellState(name: string): void {
  try {
    unlinkSync(shellStatePath(name))
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
  }
}

function readShellState(name: string): ShellSession | null {
  try {
    return parseShellState(readFileSync(shellStatePath(name), 'utf-8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
    return null
  }
}

function readShellStates(): ShellSession[] {
  const dir = getShellSessionsDir()
  if (!existsSync(dir)) return []

  const states: ShellSession[] = []
  const seen = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const path = join(dir, file)
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(`[terminal] failed to read shell state ${file}:`, e)
      }
      continue
    }
    const state = parseShellState(raw)
    if (!state || file !== `${state.name}.json` || seen.has(state.name)) {
      try {
        unlinkSync(path)
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn(`[terminal] failed to remove invalid shell state ${file}:`, e)
        }
      }
      continue
    }
    seen.add(state.name)
    states.push(state)
  }
  return states
}

function writeShellState(state: ShellSession): void {
  ensureShellSessionsDir()
  const path = shellStatePath(state.name)
  const tmpPath = `${path}.${process.pid}.tmp`
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
  renameSync(tmpPath, path)
}

function tmux(args: string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; stderr: string; error?: Error } {
  const result = spawnSync('tmux', args, {
    encoding: 'utf-8',
    env,
  })
  return {
    status: result.status,
    stderr: String(result.stderr ?? ''),
    error: result.error,
  }
}

function checkTmuxSession(name: string): TmuxSessionState {
  validateSessionName(name)
  const result = tmux(['has-session', '-t', name])
  if (result.error) {
    console.warn(`[terminal] tmux has-session failed for ${name}: ${result.error.message}`)
    return 'unknown'
  }
  if (result.status === 0) return 'live'
  if (result.status === 1) return 'missing'

  console.warn(`[terminal] tmux has-session returned ${result.status} for ${name}: ${result.stderr.trim()}`)
  return 'unknown'
}

function runTmux(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = tmux(args, env)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`tmux ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`)
  }
}

function configureShellTmuxSession(name: string): void {
  try {
    runTmux(['set-option', '-t', tmuxPaneTarget(name), 'mouse', 'on'])
  } catch (e) {
    console.warn(`[terminal] failed to enable tmux mouse for ${name}:`, e)
  }
  try {
    runTmux(['set-option', '-t', tmuxPaneTarget(name), 'status', 'off'])
  } catch (e) {
    console.warn(`[terminal] failed to hide tmux status for ${name}:`, e)
  }
}

function nextShellSessionName(): string {
  let index = 1
  while (checkTmuxSession(`shell-${index}`) === 'live') index += 1
  return `shell-${index}`
}

export function listShellSessions(): ShellSessionSummary[] {
  const liveSessions: ShellSession[] = []
  for (const state of readShellStates()) {
    const tmuxState = checkTmuxSession(state.name)
    if (tmuxState === 'live' || tmuxState === 'unknown') {
      liveSessions.push(state)
    } else if (tmuxState === 'missing') {
      removeShellState(state.name)
    }
  }

  return liveSessions.map(session => ({
    name: session.name,
    provider: 'shell',
    status: 'idle',
    project: session.project,
  }))
}

export function getShellSessionCount(): number {
  return listShellSessions().length
}

export function startShellSession(cwd: string, project: string, requestedName?: string): string {
  const name = requestedName?.trim() || nextShellSessionName()
  validateSessionName(name)

  const existingState = readShellState(name)
  const tmuxState = checkTmuxSession(name)

  if (existingState && tmuxState === 'missing') {
    removeShellState(name)
  }

  if (tmuxState === 'live' || tmuxState === 'unknown') {
    throw new Error(`Session already exists: ${name}`)
  }

  writeShellState({
    name,
    project,
    cwd,
    createdAt: new Date().toISOString(),
  })

  const shell = process.env.SHELL ?? 'bash'
  // Strip npm_config_*, npm_lifecycle_*, npm_package_* from the session env.
  // tmux server caches its initial env, so vars leaked by `npm run` persist
  // there even after `buildChildProcessEnv` strips them from the child env we
  // hand to `tmux new-session`. Unsetting inside the shell command itself is
  // the only reliable hook — tmux just runs this string via /bin/sh -c.
  const shellCmd =
    `unset $(env | awk -F= '/^npm_(config|lifecycle|package)_/{print $1}'); ` +
    `exec ${shellQuote(shell)} --login`
  try {
    runTmux([
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      cwd,
      shellCmd,
    ], buildChildProcessEnv())
  } catch (e) {
    removeShellState(name)
    throw e
  }

  configureShellTmuxSession(name)
  onSessionChange?.()
  return name
}

export function closeShellSession(name: string): boolean {
  validateSessionName(name)
  const state = readShellState(name)
  if (!state) return false

  const tmuxState = checkTmuxSession(name)
  if (tmuxState === 'live') {
    runTmux(['kill-session', '-t', name])
  } else if (tmuxState === 'unknown') {
    throw new Error(`Cannot determine tmux session state: ${name}`)
  }
  removeShellState(name)
  onSessionChange?.()
  return true
}

export function reconcileShellSessionExit(name: string): boolean {
  validateSessionName(name)
  const state = readShellState(name)
  if (!state) return false

  if (checkTmuxSession(name) !== 'missing') return false

  removeShellState(name)
  onSessionChange?.()
  return true
}

/** Spawn a PTY attached to a tmux session. */
export function attachSession(sessionName: string, cols: number, rows: number): AttachedSession {
  validateSessionName(sessionName)
  assertCanSpawn()
  if (readShellState(sessionName)) configureShellTmuxSession(sessionName)

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
}
