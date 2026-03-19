import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/
const BRIDGE_SCRIPT = join(import.meta.dir, 'pty_bridge.py')

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`)
  }
}

/** Resolve a multmux short name to the full tmux session name */
function resolveTmuxSession(shortName: string): string {
  try {
    const { execSync } = require('child_process')
    const sessions: string[] = execSync('tmux list-sessions -F "#{session_name}"', { encoding: 'utf-8' })
      .trim().split('\n')
    if (sessions.includes(shortName)) return shortName
    const match = sessions.find((s: string) => s.startsWith(shortName + '-') && s.endsWith('-mt'))
    if (match) return match
  } catch { /* tmux not running */ }
  return shortName
}

export interface PtyHandle {
  proc: ChildProcess
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  onData: (cb: (data: string) => void) => void
  onExit: (cb: () => void) => void
  kill: () => void
}

/** Spawn a PTY bridge attached to a tmux session */
export function attachSession(sessionName: string, cols: number, rows: number): PtyHandle {
  validateSessionName(sessionName)
  const tmuxName = resolveTmuxSession(sessionName)

  const proc = spawn('python3', [BRIDGE_SCRIPT, tmuxName, String(cols), String(rows)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  return {
    proc,
    write(data: string) {
      proc.stdin?.write(data)
    },
    resize(c: number, r: number) {
      // Send resize as JSON to the bridge's stdin
      proc.stdin?.write(JSON.stringify({ type: 'resize', cols: c, rows: r }))
    },
    onData(cb: (data: string) => void) {
      proc.stdout?.on('data', (chunk: Buffer) => cb(chunk.toString()))
    },
    onExit(cb: () => void) {
      proc.on('exit', cb)
    },
    kill() {
      proc.kill('SIGHUP')
    },
  }
}
