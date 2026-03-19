import { spawn, execSync } from 'child_process'
import type { Project } from './projects'

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
  status: 'processing' | 'idle'
  project: string
}

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`)
  }
}

/** Query multmux status for a specific project directory */
async function getSessionsForProject(project: Project): Promise<MultmuxSession[]> {
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
  // Deduplicate by name (a session might show up if cwd is ambiguous)
  const seen = new Set<string>()
  const all: MultmuxSession[] = []
  for (const sessions of results) {
    for (const s of sessions) {
      if (!seen.has(s.name)) {
        seen.add(s.name)
        all.push(s)
      }
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
      sessions.push({
        name: match[1].trim(),
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
export async function startMultmuxSession(provider: string, name: string, cwd: string, prompt?: string): Promise<void> {
  validateSessionName(name)
  const args = [provider]
  if (prompt) args.push(prompt)
  args.push('-n', name)
  await spawnOutput(MULTMUX_PATH, args, 10000, cwd)
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
