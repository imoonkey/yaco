import { spawnSync } from 'node:child_process'
import { validateSessionName } from '../session-names'

/** Send a single Escape keystroke to an agent tmux session. Used to cancel
 *  Claude's AskUserQuestion TUI dialog so the agent unblocks and can react
 *  to a normal next-turn message. Single Esc only — double-Esc opens
 *  Claude's message-backtrack dialog. */
export function sendEscape(handle: string): void {
  validateSessionName(handle)
  spawnSync('tmux', ['send-keys', '-t', handle, 'Escape'], { stdio: 'ignore' })
}
