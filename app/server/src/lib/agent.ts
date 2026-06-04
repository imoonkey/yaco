import { spawn } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { isAbsolute, join, normalize, relative, sep } from 'path'
import type { Project } from './projects'
import { validateSessionName } from './session-names'
import { buildChildProcessEnv } from './ssh-auth'
import {
  YACO_AGENT_COMMAND_TIMEOUT_MS,
  YACO_AGENT_STATUS_TIMEOUT_MS,
  MULTMUX_SESSIONS_DIR,
  YACO_PATH,
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

/** Raw shape of `<MULTMUX_SESSIONS_DIR>/<handle>.json` state files
 *  (`${YACO_HOME:-~/.yaco}/sessions/`, see constants.ts MULTMUX_SESSIONS_DIR).
 *  Written by the `yaco agent` runtime; read here. */
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

async function readStateFiles(): Promise<MultmuxStateFile[]> {
  let files: string[]
  try {
    files = (await readdir(MULTMUX_SESSIONS_DIR)).filter(f => f.endsWith('.json'))
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[agent] failed to read global sessions directory:', e)
    }
    return []
  }

  const reads = await Promise.all(files.map(async (file) => {
    try {
      const raw = await readFile(join(MULTMUX_SESSIONS_DIR, file), 'utf-8')
      return JSON.parse(raw) as MultmuxStateFile
    } catch (e) {
      console.warn(`[agent] failed to parse state file ${file}:`, e)
      return null
    }
  }))
  return reads.filter((s): s is MultmuxStateFile => s !== null)
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

/** Read sessions from `<MULTMUX_SESSIONS_DIR>/*.json` state files
 *  (primary source of truth; see constants.ts MULTMUX_SESSIONS_DIR). */
export async function readSessionsFromStateFiles(project: Pick<Project, 'name' | 'path'>): Promise<MultmuxSession[]> {
  const sessions: MultmuxSession[] = []

  for (const state of await readStateFiles()) {
    const sessionPath = getStateSessionPath(state)
    if (!sessionPath || !isPathDescendantOrEqual(sessionPath, project.path)) continue

    const session = toMultmuxSession(state, project)
    if (session) sessions.push(session)
  }

  return sessions
}

/** Read sessions from state files across all projects */
export async function readAllSessionsFromStateFiles(projects: Pick<Project, 'name' | 'path'>[]): Promise<MultmuxSession[]> {
  const all: MultmuxSession[] = []

  for (const state of await readStateFiles()) {
    const sessionPath = getStateSessionPath(state)
    if (!sessionPath) continue

    const project = resolveProjectForSessionPath(sessionPath, projects)
    if (!project) continue

    const session = toMultmuxSession(state, project)
    if (session) all.push(session)
  }

  return all
}

/** Unwrap a `{ ok, data }` envelope from `yaco agent <X> --json` stdout. */
function parseYacoEnvelope(raw: string, what: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`failed to parse yaco ${what} output: ${raw.slice(0, 200)}`)
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { ok?: unknown }).ok !== true) {
    const err = (parsed as { error?: { message?: string } } | null)?.error?.message
    throw new Error(`yaco ${what} failed: ${err ?? raw.slice(0, 200)}`)
  }
  return (parsed as { data: unknown }).data
}

/** Spawn `yaco agent <args> --json` and return the unwrapped `data`.
 *  Throws with the structured CLI error message on `{ok:false}` envelopes
 *  or non-zero exit. Per app↔CLI contract, every spawn from app/server
 *  uses `--json` so failures surface as parseable envelopes on stderr
 *  rather than free-form text. */
async function runYacoAgentJson(args: string[], timeoutMs: number, what: string): Promise<unknown> {
  let raw: string
  try {
    raw = await spawnOutput(YACO_PATH, args, timeoutMs)
  } catch (e) {
    // Non-zero exit path: spawnOutput's rejection carries `exit <code>: <stderr>`.
    // The stderr usually holds the failure envelope when --json was set, so try
    // to parse it before re-throwing the opaque message.
    const msg = (e as Error).message ?? String(e)
    const m = msg.match(/exit \d+:\s*([\s\S]*)$/)
    const tail = m ? m[1].trim() : ''
    if (tail) {
      try {
        const parsed = JSON.parse(tail) as { ok?: boolean; error?: { code?: string; message?: string } }
        if (parsed && parsed.ok === false && parsed.error?.message) {
          throw new Error(`yaco ${what} failed [${parsed.error.code ?? 'INTERNAL'}]: ${parsed.error.message}`)
        }
      } catch { /* not JSON — fall through */ }
    }
    throw e
  }
  return parseYacoEnvelope(raw, what)
}

/** Fetch authoritative session snapshot from `yaco agent status --json --all`.
 *  Runs reconcile() internally (liveness checks, GC, metadata backfill).
 *  Maps returned sessions to projects by sessionPath. */
export async function fetchAllSessionsFromCli(
  projects: Pick<Project, 'name' | 'path'>[],
): Promise<MultmuxSession[]> {
  // execSync.*'yaco agent status --all --json'
  const data = await runYacoAgentJson(
    ['agent', 'status', '--all', '--json'],
    YACO_AGENT_STATUS_TIMEOUT_MS,
    'agent status',
  )
  if (!Array.isArray(data)) return []

  const states = data as MultmuxStateFile[]
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

/** Send a message to an agent session via `yaco agent send`. */
export async function sendToSession(handle: string, message: string): Promise<void> {
  validateSessionName(handle)
  // execSync.*'yaco agent send <handle> <message> --json'
  await runYacoAgentJson(
    ['agent', 'send', handle, message, '--json'],
    YACO_AGENT_COMMAND_TIMEOUT_MS,
    'agent send',
  )
}

/** Capture the last `lines` lines of an agent session's tmux pane,
 *  ANSI-stripped. Reads tmux scrollback directly — works regardless of
 *  whether a channel tap was previously acquired. In `--json` mode
 *  `yaco agent capture` wraps the pane buffer as `{ok:true,data:{text}}`. */
export async function captureSession(handle: string, lines: number): Promise<string> {
  validateSessionName(handle)
  // execSync.*'yaco agent capture <handle> --lines <n> --strip-ansi true --json'
  const data = await runYacoAgentJson(
    ['agent', 'capture', handle, '--lines', String(lines), '--strip-ansi', 'true', '--json'],
    YACO_AGENT_COMMAND_TIMEOUT_MS,
    'agent capture',
  )
  if (data && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string') {
    return (data as { text: string }).text
  }
  // Defensive: capture should always wrap in {text}; if it ever changes,
  // surface whatever stringifies cleanly rather than silently dropping it.
  return typeof data === 'string' ? data : JSON.stringify(data ?? '')
}

const STATE_POLL_MS = 200
const STATE_POLL_TIMEOUT_MS = 10_000

/** Start a new agent session via `yaco agent start <provider>`. Returns as
 *  soon as the tmux session is attachable (state file has PID), without
 *  waiting for the agent to become idle. The yaco process continues in the
 *  background (waitForReady, /rename, sessionId resolution, etc.).
 *  When name is omitted, yaco generates a word-based default name.
 *
 *  Always uses the canonical `yaco agent start <provider>` form; the
 *  top-level `yaco <provider>` shortcut is reserved for human callers. */
export async function startMultmuxSession(
  provider: 'claude' | 'codex',
  name: string | undefined,
  cwd: string,
  prompt?: string,
  resumeId?: string,
): Promise<{ handle: string; sessionId: string }> {
  if (name) validateSessionName(name)
  // execSync.*'yaco agent start <provider> [yaco-flags] [passthrough...]'
  const args: string[] = ['agent', 'start', provider, '--json']
  if (resumeId) {
    args.push('--resume', resumeId)
  } else if (prompt) {
    args.push(prompt)
  }
  if (name) args.push('-n', name)

  // Snapshot existing state files before spawn — used to detect newly created files
  // for both named (collision suffix detection) and unnamed sessions.
  let beforeFiles: Set<string>
  try {
    beforeFiles = existsSync(MULTMUX_SESSIONS_DIR)
      ? new Set(readdirSync(MULTMUX_SESSIONS_DIR).filter(f => f.endsWith('.json')))
      : new Set()
  } catch {
    beforeFiles = new Set()
  }

  // Spawn yaco — it handles waitForReady / /rename / sessionId in background
  const proc = spawn(YACO_PATH, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd,
    env: buildChildProcessEnv(),
  })
  proc.unref()

  let exitCode: number | null = null
  let stderr = ''
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  proc.on('close', (code) => { exitCode = code })

  // For named sessions: after this many ms without finding the exact file,
  // start scanning all state files for a collision-suffixed match.
  const NAMED_FALLBACK_MS = 3_000
  const spawnTime = Date.now()
  const SPAWN_WINDOW_MS = 30_000

  const deadline = Date.now() + STATE_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exitCode !== null && exitCode !== 0) {
      throw new Error(`yaco agent start exit ${exitCode}: ${stderr}`)
    }

    try {
      if (name) {
        const expectedFile = `${name}.json`
        // Named session: poll known filename, but only trust it if it's new
        // (prevents attaching to a pre-existing colliding session)
        if (!beforeFiles.has(expectedFile)) {
          try {
            const raw = readFileSync(join(MULTMUX_SESSIONS_DIR, expectedFile), 'utf-8')
            const state = JSON.parse(raw) as MultmuxStateFile
            if (state.pid > 0) {
              // For resumes, verify sessionId matches to avoid wrong-session attachment
              if (!resumeId || state.sessionId === resumeId) {
                return { handle: state.handle ?? name, sessionId: state.sessionId ?? '' }
              }
            }
          } catch { /* exact file not yet written — try fallback below */ }
        }

        // Fallback: scan for collision-suffixed handle (e.g., name-2, name-3)
        // after a grace period, to handle yaco renaming on collision
        if (Date.now() - spawnTime > NAMED_FALLBACK_MS && existsSync(MULTMUX_SESSIONS_DIR)) {
          const allFiles = readdirSync(MULTMUX_SESSIONS_DIR).filter(f => f.endsWith('.json'))
          for (const f of allFiles) {
            try {
              const raw = readFileSync(join(MULTMUX_SESSIONS_DIR, f), 'utf-8')
              const state = JSON.parse(raw) as MultmuxStateFile
              if (state.pid <= 0) continue
              if (state.sessionPath !== cwd || state.provider !== provider) continue
              // Match by resumeId if resuming, or by handle prefix if starting fresh
              if (resumeId && state.sessionId === resumeId) {
                return { handle: state.handle, sessionId: state.sessionId ?? '' }
              }
              if (!resumeId && state.handle.startsWith(name)) {
                return { handle: state.handle, sessionId: state.sessionId ?? '' }
              }
            } catch { /* skip unreadable file */ }
          }
        }
      } else {
        // Unnamed session: find new state file with matching cwd
        // Use beforeFiles snapshot + spawnTime window to narrow correlation
        if (existsSync(MULTMUX_SESSIONS_DIR)) {
          const nowFiles = readdirSync(MULTMUX_SESSIONS_DIR).filter(f => f.endsWith('.json'))
          for (const f of nowFiles) {
            if (beforeFiles.has(f)) continue
            try {
              const raw = readFileSync(join(MULTMUX_SESSIONS_DIR, f), 'utf-8')
              const state = JSON.parse(raw) as MultmuxStateFile
              if (state.sessionPath !== cwd || state.provider !== provider || state.pid <= 0) continue
              // Require createdAt within spawn window to avoid matching stale sessions
              const createdAt = Date.parse(state.createdAt)
              if (isNaN(createdAt) || Math.abs(createdAt - spawnTime) > SPAWN_WINDOW_MS) continue
              return { handle: state.handle, sessionId: state.sessionId ?? '' }
            } catch { /* skip unreadable file */ }
          }
        }
      }
    } catch { /* state file not yet written */ }

    await new Promise(r => setTimeout(r, STATE_POLL_MS))
  }

  throw new Error('timeout waiting for session tmux process')
}

/** Query the yaco agent CLI for live sessions at a given path. */
export async function queryMultmuxStatus(cwd: string): Promise<MultmuxStateFile[]> {
  try {
    // execSync.*'yaco agent status --path <cwd> --json'
    const data = await runYacoAgentJson(
      ['agent', 'status', '--path', cwd, '--json'],
      YACO_AGENT_STATUS_TIMEOUT_MS,
      'agent status',
    )
    return Array.isArray(data) ? data as MultmuxStateFile[] : []
  } catch {
    return []
  }
}

/** Close an agent session via `yaco agent kill` (handles state file cleanup).
 *  kill is handle-global — no project/cwd resolution needed. */
export async function closeMultmuxSession(handle: string): Promise<void> {
  validateSessionName(handle)
  // execSync.*'yaco agent kill <handle> --json'
  await runYacoAgentJson(
    ['agent', 'kill', handle, '--json'],
    YACO_AGENT_COMMAND_TIMEOUT_MS,
    'agent kill',
  )
}

/** Rename an agent session via `yaco agent rename`.
 *  rename is handle-global — no project/cwd resolution needed. */
export async function renameMultmuxSession(oldHandle: string, newHandle: string): Promise<void> {
  validateSessionName(oldHandle)
  validateSessionName(newHandle)
  // execSync.*'yaco agent rename <old> <new> --json'
  await runYacoAgentJson(
    ['agent', 'rename', oldHandle, newHandle, '--json'],
    YACO_AGENT_COMMAND_TIMEOUT_MS,
    'agent rename',
  )
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
