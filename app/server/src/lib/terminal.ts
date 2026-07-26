import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { validateSessionName } from './session-names'
import { buildChildProcessEnv } from './ssh-auth'
import { discoverClipboardEnv } from './clipboard-env'
import { assertCanSpawn } from './pty-capacity'
import { shellSessionsDir } from '@yaco/cli/core/paths'

export const MAX_TERMINAL_TEXT_PASTE_BYTES = 1_000_000

/** tmux window sizing across attached clients: the window follows whichever
 *  client most recently became active, so the device you are currently using
 *  sees content fit to its own screen. With a single attached client — the
 *  normal case — this is simply that client's size. */
const WINDOW_SIZE_POLICY = 'latest'

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

interface TmuxResult {
  status: number | null
  stderr: string
  error?: Error
}

/** Run tmux off the event loop. Every tmux call here sits on a request or
 *  WebSocket path, so a synchronous spawn would stall the whole server — including
 *  every other terminal's output — for the duration of the subprocess. */
function tmux(args: string[], env: NodeJS.ProcessEnv = process.env, input?: string): Promise<TmuxResult> {
  return new Promise((resolve) => {
    const child = spawn('tmux', args, { env })
    let stderr = ''
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error: Error) => resolve({ status: null, stderr, error }))
    child.on('close', (status) => resolve({ status, stderr }))
    child.stdin.on('error', () => { /* closed before we could write */ })
    child.stdin.end(input ?? '')
  })
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
async function pushClipboardEnvToTmux(): Promise<void> {
  if (pushedClipboardEnvToTmux) return
  const clip = discoverClipboardEnv()
  if (!clip.DISPLAY || !clip.XAUTHORITY) return
  const env = buildChildProcessEnv()
  for (const [k, v] of Object.entries(clip)) {
    if (!v) continue
    const result = await tmux(['set-environment', '-g', k, v], env)
    if (result.status !== 0) {
      console.warn(`[terminal] tmux set-environment -g ${k} failed: ${result.stderr.trim() || `exit ${result.status}`}`)
      return
    }
  }
  pushedClipboardEnvToTmux = true
}

async function checkTmuxSession(name: string): Promise<TmuxSessionState> {
  validateSessionName(name)
  const result = await tmux(['has-session', '-t', name])
  if (result.error) {
    console.warn(`[terminal] tmux has-session failed for ${name}: ${result.error.message}`)
    return 'unknown'
  }
  if (result.status === 0) return 'live'
  if (result.status === 1) return 'missing'

  console.warn(`[terminal] tmux has-session returned ${result.status} for ${name}: ${result.stderr.trim()}`)
  return 'unknown'
}

async function runTmux(args: string[], env: NodeJS.ProcessEnv = process.env, input?: string): Promise<void> {
  const result = await tmux(args, env, input)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`tmux ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`)
  }
}

export async function pasteTextToSession(sessionName: string, text: string): Promise<void> {
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
    await runTmux(['load-buffer', '-b', bufferName, '-'], process.env, text)
    try {
      await runTmux(['paste-buffer', '-p', '-t', tmuxPaneTarget(sessionName), '-b', bufferName])
    } finally {
      const cleanup = await tmux(['delete-buffer', '-b', bufferName])
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

/** Apply the shell-session options in ONE tmux invocation. A tmux call costs ~30ms
 *  (client startup + server round trip) whatever it carries, and this runs on the
 *  attach path — so the options ride a single client as `;`-separated commands
 *  instead of paying that cost three times. */
async function configureShellTmuxSession(name: string): Promise<void> {
  const target = tmuxPaneTarget(name)
  try {
    await runTmux([
      'set-option', '-t', target, 'mouse', 'on', ';',
      'set-option', '-t', target, 'status', 'off', ';',
      'set-option', '-t', target, 'window-size', WINDOW_SIZE_POLICY,
    ])
  } catch (e) {
    console.warn(`[terminal] failed to configure tmux session ${name}:`, e)
  }
}

async function nextShellSessionName(): Promise<string> {
  let index = 1
  while (await checkTmuxSession(`shell-${index}`) === 'live') index += 1
  return `shell-${index}`
}

export async function listShellSessions(): Promise<ShellSessionSummary[]> {
  const states = readShellStates()
  const checked = await Promise.all(
    states.map(async state => ({ state, tmuxState: await checkTmuxSession(state.name) })),
  )

  const liveSessions: ShellSession[] = []
  for (const { state, tmuxState } of checked) {
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

export async function getShellSessionCount(): Promise<number> {
  return (await listShellSessions()).length
}

export async function startShellSession(cwd: string, project: string, requestedName?: string): Promise<string> {
  const name = requestedName?.trim() || await nextShellSessionName()
  validateSessionName(name)

  const existingState = readShellState(name)
  const tmuxState = await checkTmuxSession(name)

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
    await runTmux([
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

  await configureShellTmuxSession(name)
  onSessionChange?.()
  return name
}

export async function closeShellSession(name: string): Promise<boolean> {
  validateSessionName(name)
  const state = readShellState(name)
  if (!state) return false

  const tmuxState = await checkTmuxSession(name)
  if (tmuxState === 'live') {
    await runTmux(['kill-session', '-t', name])
  } else if (tmuxState === 'unknown') {
    throw new Error(`Cannot determine tmux session state: ${name}`)
  }
  removeShellState(name)
  onSessionChange?.()
  return true
}

export async function reconcileShellSessionExit(name: string): Promise<boolean> {
  validateSessionName(name)
  const state = readShellState(name)
  if (!state) return false

  if (await checkTmuxSession(name) !== 'missing') return false

  removeShellState(name)
  onSessionChange?.()
  return true
}

/** Spawn a PTY attached to a tmux session. */
export async function attachSession(sessionName: string, cols: number, rows: number): Promise<AttachedSession> {
  validateSessionName(sessionName)
  assertCanSpawn()
  await pushClipboardEnvToTmux()
  if (readShellState(sessionName)) await configureShellTmuxSession(sessionName)

  const proc = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cols,
    rows,
    env: buildChildProcessEnv(),
  })

  // NOTHING may be awaited between the spawn above and the return below. node-pty
  // drops output emitted while no listener is attached, and tmux sends the whole
  // attach repaint ~30ms in; the caller subscribes on the microtask that resumes its
  // `await attachSession(...)`, which still precedes every pty I/O callback. An await
  // here would put a real I/O turn in that gap and swallow the repaint — the terminal
  // then stays blank until tmux redraws for some other reason.

  // Force window to this client's size. WINDOW_SIZE_POLICY is supposed to do
  // this on attach, but a fresh attach isn't always counted as "latest active"
  // until the user types — so a previously-attached small client (or a zombie
  // from a leaked node-pty) can clamp the window. Explicit resize-window
  // bypasses the policy.
  //
  // Side effect: tmux's `resize-window -x -y` automatically flips
  // `window-size` to `manual` (documented). Restore the policy in the same
  // invocation so future client size changes (laptop pane resize, device
  // switch) still auto-resize the window.
  //
  // NOT awaited: tmux repaints the whole pane ~30ms after attach and the browser
  // is waiting for exactly that, so holding the return for two more subprocess
  // round trips (~60ms) delays the paint by more than it took to produce. The pty
  // spawned at this client's size already, so the resize is a no-op in the common
  // case and produces no second repaint.
  void runTmux([
    'resize-window', '-t', tmuxPaneTarget(sessionName), '-x', String(cols), '-y', String(rows), ';',
    'set-option', '-t', tmuxPaneTarget(sessionName), 'window-size', WINDOW_SIZE_POLICY,
  ]).catch((e: unknown) => {
    // tmux stops the sequence at the first failing command, so this covers either
    // the resize or the policy restore — and a failed restore leaves the window
    // pinned to `manual` until the next attach.
    console.warn(`[terminal] failed to resize window / restore sizing policy for ${sessionName}:`, e)
  })

  return {
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
