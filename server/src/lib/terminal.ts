import * as pty from 'node-pty'
import type { IPty } from 'node-pty'

const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`)
  }
}

/** Spawn a PTY attached to a tmux session. Returns a pty handle for piping I/O. */
export function attachSession(sessionName: string, cols: number, rows: number): IPty {
  validateSessionName(sessionName)
  // tmux session names used by multmux end with -mt suffix in the tmux server
  // We try the exact name first; tmux will error if not found
  const proc = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cols,
    rows,
    env: process.env as Record<string, string>,
  })
  return proc
}

/** Resize a PTY */
export function resizePty(proc: IPty, cols: number, rows: number): void {
  proc.resize(cols, rows)
}
