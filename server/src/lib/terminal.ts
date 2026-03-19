import pty from 'node-pty'
import type { IPty } from 'node-pty'
import { execSync } from 'child_process'

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`)
  }
}

/** Resolve a multmux short name to the full tmux session name */
function resolveTmuxSession(shortName: string): string {
  try {
    const sessions = execSync('tmux list-sessions -F "#{session_name}"', { encoding: 'utf-8' })
      .trim().split('\n')
    if (sessions.includes(shortName)) return shortName
    const match = sessions.find(s => s.startsWith(shortName + '-') && s.endsWith('-mt'))
    if (match) return match
  } catch { /* tmux not running */ }
  return shortName
}

/** Spawn a PTY attached to a tmux session */
export function attachSession(sessionName: string, cols: number, rows: number): IPty {
  validateSessionName(sessionName)
  const tmuxName = resolveTmuxSession(sessionName)
  return pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
    name: 'xterm-256color',
    cols,
    rows,
    env: process.env as Record<string, string>,
  })
}
