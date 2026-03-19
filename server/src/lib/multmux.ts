import { spawn } from 'child_process'

export interface MultmuxSession {
  name: string
  status: 'processing' | 'idle'
}

const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`)
  }
}

/** Query multmux status and parse output */
export async function getMultmuxSessions(): Promise<MultmuxSession[]> {
  try {
    const output = await spawnOutput('multmux', ['status'], 5000)
    return parseMultmuxOutput(output)
  } catch {
    return []
  }
}

/** Parse multmux status output into sessions */
export function parseMultmuxOutput(output: string): MultmuxSession[] {
  const sessions: MultmuxSession[] = []
  const lines = output.trim().split('\n').filter(l => l.trim())

  for (const line of lines) {
    const match = line.match(/^(.+?):\s*(processing|idle)\s*$/i)
    if (match) {
      sessions.push({
        name: match[1].trim(),
        status: match[2].toLowerCase() as 'processing' | 'idle',
      })
    }
  }
  return sessions
}

/** Send a command to a multmux session (uses spawn with args array — no shell) */
export async function sendToSession(handle: string, message: string): Promise<void> {
  validateSessionName(handle)
  await spawnOutput('multmux', ['send', handle, message], 5000)
}

/** Start a new multmux session */
export async function startMultmuxSession(handle: string, cmd: string, cwd: string): Promise<void> {
  validateSessionName(handle)
  await spawnOutput('multmux', ['start', handle, cmd, '--cwd', cwd], 10000)
}

/** Collect stdout from a spawned process */
function spawnOutput(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')) }, timeoutMs)
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`exit ${code}`))
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}
