import { spawn, execSync } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { Project } from './projects'
import { resolveTmuxSession, validateSessionName } from './session-names'

// Resolve multmux path at startup
const MULTMUX_PATH = (() => {
  try {
    return execSync('which multmux', { encoding: 'utf-8' }).trim()
  } catch {
    return 'multmux'
  }
})()

export interface MultmuxSession {
  name: string
  provider: 'claude' | 'codex'
  status: 'processing' | 'idle'
  project: string
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
  status: 'starting' | 'idle' | 'processing' | 'stopped'
  createdAt: string
}

/** Normalize state file status to workflow UI semantics.
 *  starting → idle (pre-work bootstrap, not real processing)
 *  stopped  → null (excluded from active list) */
function normalizeStateFileStatus(status: string): 'processing' | 'idle' | null {
  if (status === 'processing') return 'processing'
  if (status === 'idle' || status === 'starting') return 'idle'
  return null // stopped or unknown → exclude
}

/** Read sessions from .multmux/*.json state files (primary source of truth) */
export function readSessionsFromStateFiles(project: Pick<Project, 'name' | 'path'>): MultmuxSession[] {
  const dir = join(project.path, '.multmux')
  if (!existsSync(dir)) return []

  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch {
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
      })
    } catch {
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

/** Send a message to a multmux session */
export async function sendToSession(handle: string, message: string): Promise<void> {
  validateSessionName(handle)
  await spawnOutput(MULTMUX_PATH, ['send', handle, message], 5000)
}

/** Start a new multmux session: multmux <provider> -n <name> */
export async function startMultmuxSession(provider: 'claude' | 'codex', name: string, cwd: string, prompt?: string): Promise<void> {
  validateSessionName(name)
  const args: string[] = [provider]
  if (prompt) args.push(prompt)
  args.push('-n', name)
  await spawnOutput(MULTMUX_PATH, args, 10000, cwd)
}

export async function closeMultmuxSession(handle: string): Promise<void> {
  validateSessionName(handle)
  const tmuxName = resolveTmuxSession(handle)
  await spawnOutput('tmux', ['kill-session', '-t', tmuxName], 5000)
}

/** Collect stdout from a spawned process */
function spawnOutput(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
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
