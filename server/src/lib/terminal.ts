import { spawn } from 'child_process'

const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/

function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`)
  }
}

/** Send input to a tmux session (uses spawn with args array — no shell) */
export function sendKeys(sessionName: string, keys: string): void {
  validateSessionName(sessionName)
  spawn('tmux', ['send-keys', '-t', sessionName, keys], { stdio: 'ignore' })
}

/** Capture current pane content */
export async function capturePane(sessionName: string): Promise<string> {
  validateSessionName(sessionName)
  return new Promise((resolve) => {
    const proc = spawn('tmux', ['capture-pane', '-t', sessionName, '-p', '-S', '-100'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    proc.on('close', () => resolve(output))
    proc.on('error', () => resolve(''))
  })
}
