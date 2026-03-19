import { spawn, execSync } from 'child_process'
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

/** Query multmux status for a specific project directory */
export async function getSessionsForProject(project: Project): Promise<MultmuxSession[]> {
  try {
    const output = await spawnOutput(MULTMUX_PATH, ['status'], 5000, project.path)
    return parseMultmuxOutput(output, project.name)
  } catch {
    return []
  }
}

/** Get sessions across all projects */
export async function getAllSessions(projects: Project[]): Promise<MultmuxSession[]> {
  const results = await Promise.all(projects.map(getSessionsForProject))
  const seen = new Set<string>()
  const all: MultmuxSession[] = []
  for (const sessions of results) {
    for (const session of sessions) {
      if (seen.has(session.name)) continue
      seen.add(session.name)
      all.push(session)
    }
  }
  return all
}

/** Parse multmux status output — format: "name<whitespace>idle|processing" */
export function parseMultmuxOutput(output: string, projectName: string): MultmuxSession[] {
  const sessions: MultmuxSession[] = []
  const lines = output.trim().split('\n').filter(l => l.trim())

  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(processing|idle)\s*$/i)
    if (match) {
      const name = match[1].trim()
      sessions.push({
        name,
        provider: inferMultmuxProvider(name),
        status: match[2].toLowerCase() as 'processing' | 'idle',
        project: projectName,
      })
    }
  }
  return sessions
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
