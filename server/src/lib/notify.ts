import { spawn } from 'child_process'

/** Send a macOS desktop notification via osascript (uses spawn — no shell injection) */
export function notify(title: string, message: string): void {
  const script = `display notification ${applescriptString(message)} with title ${applescriptString(title)}`
  spawn('osascript', ['-e', script], { stdio: 'ignore' })
}

/** Escape a string for AppleScript: wrap in quotes, escape backslashes and quotes */
function applescriptString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}
