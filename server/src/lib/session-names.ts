import { execSync } from 'child_process'

export const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/

export function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`)
  }
}

export function resolveTmuxSession(shortName: string): string {
  try {
    const sessions = execSync('tmux list-sessions -F "#{session_name}"', { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(Boolean)

    if (sessions.includes(shortName)) return shortName

    const match = sessions.find(session => session.startsWith(`${shortName}-`) && session.endsWith('-mt'))
    if (match) return match
  } catch {
    // tmux may not be running yet.
  }

  return shortName
}
