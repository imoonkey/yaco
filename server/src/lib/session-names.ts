export const SESSION_NAME_RE = /^[a-zA-Z0-9_.-]+$/

export function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: ${name}`)
  }
}
