import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { validateSessionName } from './session-names'
import { buildChildProcessEnv } from './ssh-auth'
import { discoverClipboardEnv } from './clipboard-env'
import { assertCanSpawn } from './pty-capacity'
import { shellSessionsDir } from './yacoHome'

export const MAX_TERMINAL_TEXT_PASTE_BYTES = 1_000_000

export type TerminalTextPasteErrorCode = 'too-large' | 'tmux-failed'

export class TerminalTextPasteError extends Error {
  code: TerminalTextPasteErrorCode

  constructor(code: TerminalTextPasteErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

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

let onSessionChange: (() => void) | null = null

/** Register a callback invoked on shell session start, close, or process exit */
export function setShellSessionChangeCallback(cb: () => void): void {
  onSessionChange = cb
}

function getShellSessionsDir(): string {
  return process.env.WORKFLOW_SHELL_SESSIONS_DIR || shellSessionsDir()
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

function tmux(args: string[], env: NodeJS.ProcessEnv = process.env, input?: string): { status: number | null; stderr: string; error?: Error } {
  const result = spawnSync('tmux', args, {
    encoding: 'utf-8',
    env,
    input,
  })
  return {
    status: result.status,
    stderr: String(result.stderr ?? ''),
    error: result.error,
  }
}

// Push the discovered Linux graphical-session env (DISPLAY, XAUTHORITY,
// WAYLAND_DISPLAY) into the running tmux server's global environment so any
// shell or agent window that opens afterwards inherits it. Without this, the
// tmux server keeps the env it had when it first started — usually empty for
// graphical vars when launched from a systemd-user service — and downstream
// tools like xclip refuse to talk to the X server. Already-running agent
// processes still use their original env until they restart; this only fixes
// future spawns.
let pushedClipboardEnvToTmux = false
function pushClipboardEnvToTmux(): void {
  if (pushedClipboardEnvToTmux) return
  const clip = discoverClipboardEnv()
  if (!clip.DISPLAY || !clip.XAUTHORITY) return
  const env = buildChildProcessEnv()
  for (const [k, v] of Object.entries(clip)) {
    if (!v) continue
    const result = tmux(['set-environment', '-g', k, v], env)
    if (result.status !== 0) {
      console.warn(`[terminal] tmux set-environment -g ${k} failed: ${result.stderr.trim() || `exit ${result.status}`}`)
      return
    }
  }
  pushedClipboardEnvToTmux = true
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

function runTmux(args: string[], env: NodeJS.ProcessEnv = process.env, input?: string): void {
  const result = tmux(args, env, input)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`tmux ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`)
  }
}

export function pasteTextToSession(sessionName: string, text: string): void {
  validateSessionName(sessionName)
  if (!text) return

  const byteLength = Buffer.byteLength(text, 'utf-8')
  if (byteLength > MAX_TERMINAL_TEXT_PASTE_BYTES) {
    throw new TerminalTextPasteError(
      'too-large',
      `Terminal paste exceeds ${MAX_TERMINAL_TEXT_PASTE_BYTES} bytes (got ${byteLength})`,
    )
  }

  const bufferName = `yaco-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    runTmux(['load-buffer', '-b', bufferName, '-'], process.env, text)
    try {
      runTmux(['paste-buffer', '-p', '-t', tmuxPaneTarget(sessionName), '-b', bufferName])
    } finally {
      const cleanup = tmux(['delete-buffer', '-b', bufferName])
      if (cleanup.status !== 0) {
        console.warn(`[terminal] failed to delete tmux paste buffer ${bufferName}: ${cleanup.stderr.trim() || `exit ${cleanup.status}`}`)
      }
    }
  } catch (e) {
    if (e instanceof TerminalTextPasteError) throw e
    const message = e instanceof Error ? e.message : String(e)
    throw new TerminalTextPasteError('tmux-failed', message)
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
  try {
    // `latest` = window follows whichever client most recently became active,
    // so each device sees content fit to its own screen.
    runTmux(['set-option', '-t', tmuxPaneTarget(name), 'window-size', 'latest'])
  } catch (e) {
    console.warn(`[terminal] failed to set tmux window-size for ${name}:`, e)
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
  //
  // `-li` = login + interactive: matches macOS Terminal.app default and gives
  // us /etc/profile + ~/.profile + ~/.bashrc, so SSH_AUTH_SOCK (via keychain)
  // and other env from the user's interactive shell are present. No `-c` here
  // — bash drops into the user's REPL.
  const shellCmd =
    `unset $(env | awk -F= '/^npm_(config|lifecycle|package)_/{print $1}'); ` +
    `exec ${shellQuote(shell)} -li`
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
  pushClipboardEnvToTmux()
  if (readShellState(sessionName)) configureShellTmuxSession(sessionName)

  const proc = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cols,
    rows,
    env: buildChildProcessEnv(),
  })

  // Force window to this client's size. `window-size latest` is supposed to
  // do this on attach, but a fresh attach isn't always counted as "latest
  // active" until the user types — so a previously-attached small client
  // (or a zombie from a leaked node-pty) can clamp the window. Explicit
  // resize-window bypasses the policy.
  //
  // Side effect: tmux's `resize-window -x -y` automatically flips
  // `window-size` to `manual` (documented). Restore `latest` immediately
  // so future client size changes (laptop pane resize, device switch)
  // still auto-resize the window.
  try {
    runTmux(['resize-window', '-t', tmuxPaneTarget(sessionName), '-x', String(cols), '-y', String(rows)])
    runTmux(['set-option', '-t', tmuxPaneTarget(sessionName), 'window-size', 'latest'])
  } catch (e) {
    console.warn(`[terminal] failed to resize-window for ${sessionName}:`, e)
  }

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
