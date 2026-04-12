import { spawn } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { isAbsolute, join, normalize, relative, sep } from 'path'
import type { Project } from './projects'
import { validateSessionName } from './session-names'
import { buildChildProcessEnv } from './ssh-auth'
import {
  MULTMUX_COMMAND_TIMEOUT_MS,
  MULTMUX_STATUS_TIMEOUT_MS,
  MULTMUX_SESSIONS_DIR,
  MULTMUX_PATH,
} from './constants'

export interface MultmuxSession {
  name: string
  provider: 'claude' | 'codex'
  status: 'starting' | 'idle' | 'processing'
  project: string
  sessionPath: string
  sessionId: string
  pid: number
}

export function inferMultmuxProvider(name: string): 'claude' | 'codex' {
  return name.toLowerCase().includes('codex') ? 'codex' : 'claude'
}

/** Raw shape of ~/.multmux/sessions/<handle>.json state files */
export interface MultmuxStateFile {
  handle: string
  provider: 'claude' | 'codex'
  sessionPath: string
  pid: number
  sessionId: string
  status: 'starting' | 'idle' | 'processing'
  createdAt: string
}

const VALID_STATUSES = new Set(['starting', 'idle', 'processing'])

function normalizePath(path: string): string {
  const normalized = normalize(path)
  if (normalized === sep) return normalized
  return normalized.replace(/[\\/]+$/, '')
}

function getStateSessionPath(state: MultmuxStateFile): string | null {
  if (typeof state.sessionPath !== 'string' || !state.sessionPath) return null
  return normalizePath(state.sessionPath)
}

export function isPathDescendantOrEqual(candidatePath: string, rootPath: string): boolean {
  if (!candidatePath || !rootPath) return false

  const candidate = normalizePath(candidatePath)
  const root = normalizePath(rootPath)
  const rel = relative(root, candidate)

  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function readStateFiles(): MultmuxStateFile[] {
  if (!existsSync(MULTMUX_SESSIONS_DIR)) return []

  let files: string[]
  try {
    files = readdirSync(MULTMUX_SESSIONS_DIR).filter(f => f.endsWith('.json'))
  } catch (e) {
    console.warn('[multmux] failed to read global sessions directory:', e)
    return []
  }

  const states: MultmuxStateFile[] = []
  for (const file of files) {
    try {
      const raw = readFileSync(join(MULTMUX_SESSIONS_DIR, file), 'utf-8')
      const state = JSON.parse(raw) as MultmuxStateFile
      states.push(state)
    } catch (e) {
      console.warn(`[multmux] failed to parse state file ${file}:`, e)
      continue
    }
  }

  return states
}

function toMultmuxSession(
  state: MultmuxStateFile,
  project: Pick<Project, 'name'>,
): MultmuxSession | null {
  if (typeof state.handle !== 'string' || !state.handle) return null
  const sessionPath = getStateSessionPath(state)
  if (!sessionPath) return null

  if (!VALID_STATUSES.has(state.status)) return null

  const provider = state.provider === 'codex' || state.provider === 'claude'
    ? state.provider
    : inferMultmuxProvider(state.handle)

  return {
    name: state.handle,
    provider,
    status: state.status,
    project: project.name,
    sessionPath,
    sessionId: state.sessionId ?? '',
    pid: state.pid,
  }
}

function resolveProjectForSessionPath(
  sessionPath: string,
  projects: Pick<Project, 'name' | 'path'>[],
): Pick<Project, 'name' | 'path'> | null {
  let match: Pick<Project, 'name' | 'path'> | null = null

  for (const project of projects) {
    if (!isPathDescendantOrEqual(sessionPath, project.path)) continue
    if (!match || normalizePath(project.path).length > normalizePath(match.path).length) {
      match = project
    }
  }

  return match
}

/** Read sessions from ~/.multmux/sessions/*.json state files (primary source of truth) */
export function readSessionsFromStateFiles(project: Pick<Project, 'name' | 'path'>): MultmuxSession[] {
  const sessions: MultmuxSession[] = []

  for (const state of readStateFiles()) {
    const sessionPath = getStateSessionPath(state)
    if (!sessionPath || !isPathDescendantOrEqual(sessionPath, project.path)) continue

    const session = toMultmuxSession(state, project)
    if (session) sessions.push(session)
  }

  return sessions
}

/** Read sessions from state files across all projects */
export function readAllSessionsFromStateFiles(projects: Pick<Project, 'name' | 'path'>[]): MultmuxSession[] {
  const all: MultmuxSession[] = []

  for (const state of readStateFiles()) {
    const sessionPath = getStateSessionPath(state)
    if (!sessionPath) continue

    const project = resolveProjectForSessionPath(sessionPath, projects)
    if (!project) continue

    const session = toMultmuxSession(state, project)
    if (session) all.push(session)
  }

  return all
}

/** Fetch authoritative session snapshot from `multmux status --json --all`.
 *  Runs reconcile() internally (liveness checks, GC, metadata backfill).
 *  Maps returned sessions to projects by sessionPath. */
export async function fetchAllSessionsFromCli(
  projects: Pick<Project, 'name' | 'path'>[],
): Promise<MultmuxSession[]> {
  const raw = await spawnOutput(
    MULTMUX_PATH,
    ['status', '--json', '--all'],
    MULTMUX_STATUS_TIMEOUT_MS,
  )

  let states: MultmuxStateFile[]
  try {
    states = JSON.parse(raw)
  } catch {
    throw new Error(`failed to parse multmux status output: ${raw.slice(0, 200)}`)
  }

  if (!Array.isArray(states)) return []

  const sessions: MultmuxSession[] = []
  for (const state of states) {
    const sessionPath = getStateSessionPath(state)
    if (!sessionPath) continue

    const project = resolveProjectForSessionPath(sessionPath, projects)
    if (!project) continue

    const session = toMultmuxSession(state, project)
    if (session) sessions.push(session)
  }

  return sessions
}

/** Send a message to a multmux session */
export async function sendToSession(handle: string, message: string): Promise<void> {
  validateSessionName(handle)
  await spawnOutput(MULTMUX_PATH, ['send', handle, message], MULTMUX_COMMAND_TIMEOUT_MS)
}

const STATE_POLL_MS = 200
const STATE_POLL_TIMEOUT_MS = 10_000

/** Start a new multmux session. Returns as soon as the tmux session is
 *  attachable (state file has PID), without waiting for the agent to become
 *  idle. The multmux process continues in the background (waitForReady,
 *  /rename, sessionId resolution, etc.).
 *  When name is omitted, multmux generates a word-based default name. */
export async function startMultmuxSession(
  provider: 'claude' | 'codex',
  name: string | undefined,
  cwd: string,
  prompt?: string,
  resumeId?: string,
): Promise<{ handle: string; sessionId: string }> {
  if (name) validateSessionName(name)
  const args: string[] = [provider]
  if (resumeId) {
    args.push('--resume', resumeId)
  } else if (prompt) {
    args.push(prompt)
  }
  if (name) args.push('-n', name)
  args.push('--json')

  // Snapshot existing state files before spawn (for unnamed sessions)
  const beforeFiles = name ? null : new Set(
    readdirSync(MULTMUX_SESSIONS_DIR).filter(f => f.endsWith('.json'))
  )

  // Spawn multmux — it will handle waitForReady / /rename / sessionId in background
  const proc = spawn(MULTMUX_PATH, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd,
    env: buildChildProcessEnv(),
  })
  proc.unref()

  let exitCode: number | null = null
  let stderr = ''
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  proc.on('close', (code) => { exitCode = code })

  const deadline = Date.now() + STATE_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exitCode !== null && exitCode !== 0) {
      throw new Error(`multmux exit ${exitCode}: ${stderr}`)
    }

    try {
      if (name) {
        // Named session: poll known filename
        const raw = readFileSync(join(MULTMUX_SESSIONS_DIR, `${name}.json`), 'utf-8')
        const state = JSON.parse(raw) as MultmuxStateFile
        if (state.pid > 0) {
          return { handle: state.handle ?? name, sessionId: state.sessionId ?? '' }
        }
      } else {
        // Unnamed session: find new state file with matching cwd
        const nowFiles = readdirSync(MULTMUX_SESSIONS_DIR).filter(f => f.endsWith('.json'))
        for (const f of nowFiles) {
          if (beforeFiles!.has(f)) continue
          const raw = readFileSync(join(MULTMUX_SESSIONS_DIR, f), 'utf-8')
          const state = JSON.parse(raw) as MultmuxStateFile
          if (state.sessionPath === cwd && state.provider === provider && state.pid > 0) {
            return { handle: state.handle, sessionId: state.sessionId ?? '' }
          }
        }
      }
    } catch { /* state file not yet written */ }

    await new Promise(r => setTimeout(r, STATE_POLL_MS))
  }

  throw new Error('timeout waiting for session tmux process')
}

/** Query multmux CLI for live sessions at a given path */
export async function queryMultmuxStatus(cwd: string): Promise<MultmuxStateFile[]> {
  try {
    const out = await spawnOutput(
      MULTMUX_PATH,
      ['status', '--json', '--path', cwd],
      MULTMUX_STATUS_TIMEOUT_MS,
    )
    return JSON.parse(out) as MultmuxStateFile[]
  } catch {
    return []
  }
}

/** Close a multmux session via the CLI (handles state file cleanup).
 *  kill is handle-global — no project/cwd resolution needed. */
export async function closeMultmuxSession(handle: string): Promise<void> {
  validateSessionName(handle)
  await spawnOutput(MULTMUX_PATH, ['kill', handle], MULTMUX_COMMAND_TIMEOUT_MS)
}

/** Rename a multmux session via the CLI.
 *  rename is handle-global — no project/cwd resolution needed. */
export async function renameMultmuxSession(oldHandle: string, newHandle: string): Promise<void> {
  validateSessionName(oldHandle)
  validateSessionName(newHandle)
  await spawnOutput(MULTMUX_PATH, ['rename', oldHandle, newHandle], MULTMUX_COMMAND_TIMEOUT_MS)
}

/** Collect stdout from a spawned process */
function spawnOutput(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: buildChildProcessEnv(),
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')) }, timeoutMs)
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`exit ${code}: ${err}`))
    })
    proc.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}
