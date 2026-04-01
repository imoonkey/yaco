import { spawn } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { Project } from './projects'
import { validateSessionName } from './session-names'
import { buildChildProcessEnv } from './ssh-auth'
import { MULTMUX_COMMAND_TIMEOUT_MS, MULTMUX_START_TIMEOUT_MS, MULTMUX_PATH } from './constants'

export interface MultmuxSession {
  name: string
  provider: 'claude' | 'codex'
  status: 'processing' | 'idle'
  project: string
  sessionId: string
  pid: number
  stateFileSummary?: string
}

export function inferMultmuxProvider(name: string): 'claude' | 'codex' {
  return name.toLowerCase().includes('codex') ? 'codex' : 'claude'
}

/** Raw shape of .multmux/<handle>.json state files */
export interface MultmuxStateFile {
  handle: string
  provider: 'claude' | 'codex'
  tmuxSession: string
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

/** Read sessions from .multmux/*.json state files (primary source of truth) */
export function readSessionsFromStateFiles(project: Pick<Project, 'name' | 'path'>): MultmuxSession[] {
  const dir = join(project.path, '.multmux')
  if (!existsSync(dir)) return []

  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch (e) {
    console.warn(`[multmux] failed to read .multmux directory for ${project.name}:`, e)
    return []
  }

  const sessions: MultmuxSession[] = []
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8')
      const state = JSON.parse(raw) as MultmuxStateFile
      const status = normalizeStateFileStatus(state.status)
      if (!status) continue

      const provider = state.provider === 'codex' || state.provider === 'claude'
        ? state.provider
        : inferMultmuxProvider(state.handle)

      sessions.push({
        name: state.handle,
        provider,
        status,
        project: project.name,
        sessionId: state.sessionId ?? '',
        pid: state.pid,
        stateFileSummary: state.summary,
      })
    } catch (e) {
      console.warn(`[multmux] failed to parse state file ${file}:`, e)
      continue
    }
  }
  return sessions
}

/** Read sessions from state files across all projects */
export function readAllSessionsFromStateFiles(projects: Pick<Project, 'name' | 'path'>[]): MultmuxSession[] {
  const seen = new Set<string>()
  const all: MultmuxSession[] = []
  for (const project of projects) {
    for (const session of readSessionsFromStateFiles(project)) {
      if (seen.has(session.name)) continue
      seen.add(session.name)
      all.push(session)
    }
  }
  return all
}

/** Resolve the actual tmux session name for a handle within a specific project.
 *  Returns null if the state file doesn't exist or lacks a tmuxSession field. */
export function resolveSessionTmuxName(projectPath: string, handle: string): string | null {
  const stateFile = join(projectPath, '.multmux', `${handle}.json`)
  try {
    const raw = readFileSync(stateFile, 'utf-8')
    const state = JSON.parse(raw) as MultmuxStateFile
    return state.tmuxSession || null
  } catch (e) {
    console.warn(`[multmux] failed to read state file for ${handle}:`, e)
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
