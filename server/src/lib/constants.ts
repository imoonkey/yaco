import { execSync } from 'child_process'

/** Resolved path to the multmux binary (startup-time resolution) */
export const MULTMUX_PATH = (() => {
  try {
    return execSync('which multmux', { encoding: 'utf-8' }).trim()
  } catch {
    return 'multmux'
  }
})()

/** Git max buffer for ls-files commands (50 MB) */
export const GIT_MAX_BUFFER = 50 * 1024 * 1024

/** Maximum file size for content endpoint (1 MB) */
export const FILE_SIZE_LIMIT = 1_000_000

/** Timeout for multmux send/kill/rename commands (ms) */
export const MULTMUX_COMMAND_TIMEOUT_MS = 5_000

/** Timeout for multmux start command (ms) */
export const MULTMUX_START_TIMEOUT_MS = 15_000

/** Timeout for multmux status --json backfill (ms) */
export const MULTMUX_STATUS_TIMEOUT_MS = 10_000

/** Timeout for git status/diff commands (ms) */
export const GIT_COMMAND_TIMEOUT_MS = 5_000

/** SSE heartbeat interval (ms) */
export const SSE_HEARTBEAT_MS = 30_000

/** Sentinel value for sessions that haven't received a first prompt */
export const PENDING_SESSION_ID = 'pending:awaiting-first-prompt'

/** node-pty scrollback buffer cap (bytes) */
export const PTY_MAX_BUFFER_SIZE = 200_000

/** Voice upload size limit (20 MB) */
export const VOICE_MAX_UPLOAD_BYTES = 20_000_000

/** Max files for non-git search-index walk */
export const SEARCH_INDEX_BUDGET = 100_000

/** Default terminal dimensions */
export const DEFAULT_TERMINAL_COLS = 80
export const DEFAULT_TERMINAL_ROWS = 24

/** Max terminal dimensions */
export const MAX_TERMINAL_COLS = 500
export const MAX_TERMINAL_ROWS = 200
