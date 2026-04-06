import { spawn } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { isAbsolute, join, normalize, relative, sep } from 'path'
import type { Project } from './projects'
import { validateSessionName } from './session-names'
import { buildChildProcessEnv } from './ssh-auth'
import {
  MULTMUX_COMMAND_TIMEOUT_MS,
  MULTMUX_SESSIONS_DIR,
  MULTMUX_START_TIMEOUT_MS,
  MULTMUX_PATH,
} from './constants'

export interface MultmuxSession {
  name: string
  provider: 'claude' | 'codex'
  status: 'processing' | 'idle'
  project: string
  sessionPath: string
  sessionId: string
  pid: number
  stateFileSummary?: string
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
  summary?: string
}

/** Normalize state file status to workflow UI semantics.
 *  starting → idle (pre-work bootstrap, not real processing)
 *  unknown  → null (file should have been deleted by multmux) */
function normalizeStateFileStatus(status: string): 'processing' | 'idle' | null {
  if (status === 'processing') return 'processing'
  if (status === 'idle' || status === 'starting') return 'idle'
  return null
}

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

  const status = normalizeStateFileStatus(state.status)
  if (!status) return null

  const provider = state.provider === 'codex' || state.provider === 'claude'
    ? state.provider
    : inferMultmuxProvider(state.handle)

  return {
    name: state.handle,
    provider,
    status,
    project: project.name,
    sessionPath,
    sessionId: state.sessionId ?? '',
    pid: state.pid,
    stateFileSummary: state.summary,
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

/** Resolve the tmux session name for a handle from the global state file. */
export function resolveSessionTmuxName(handle: string): string | null {
  const stateFile = join(MULTMUX_SESSIONS_DIR, `${handle}.json`)
  try {
    const raw = readFileSync(stateFile, 'utf-8')
    const state = JSON.parse(raw) as MultmuxStateFile
    return typeof state.handle === 'string' && state.handle ? state.handle : null
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[multmux] failed to read state file for ${handle}:`, e)
    }
    return null
  }
}

/** Send a message to a multmux session */
export async function sendToSession(handle: string, message: string): Promise<void> {
  validateSessionName(handle)
  await spawnOutput(MULTMUX_PATH, ['send', handle, message], MULTMUX_COMMAND_TIMEOUT_MS)
}

/** Start a new multmux session. Returns handle and sessionId from CLI output. */
export async function startMultmuxSession(
  provider: 'claude' | 'codex',
  name: string,
  cwd: string,
  prompt?: string,
): Promise<{ handle: string; sessionId: string }> {
  validateSessionName(name)
  const args: string[] = [provider]
  if (prompt) args.push(prompt)
  args.push('-n', name, '--json')
  const output = await spawnOutput(MULTMUX_PATH, args, MULTMUX_START_TIMEOUT_MS, cwd)
  try {
    const state = JSON.parse(output) as MultmuxStateFile
    return { handle: state.handle, sessionId: state.sessionId ?? '' }
  } catch (e) {
    console.warn('[multmux] failed to parse start --json output:', e)
    return { handle: name, sessionId: '' }
  }
}

/** Close a multmux session via the CLI (handles state file cleanup). */
export async function closeMultmuxSession(handle: string, cwd: string): Promise<void> {
  validateSessionName(handle)
  await spawnOutput(MULTMUX_PATH, ['kill', handle], MULTMUX_COMMAND_TIMEOUT_MS, cwd)
}

export async function renameMultmuxSession(oldHandle: string, newHandle: string, cwd: string): Promise<void> {
  validateSessionName(oldHandle)
  validateSessionName(newHandle)
  await spawnOutput(MULTMUX_PATH, ['rename', oldHandle, newHandle], MULTMUX_COMMAND_TIMEOUT_MS, cwd)
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
