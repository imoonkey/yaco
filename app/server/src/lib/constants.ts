import { execSync } from 'child_process'
import { sessionsDir } from '@yaco/cli/core/paths'
import { DEFAULT_TASK_LOCK_TIMEOUT_MS } from '@yaco/cli/core/task'

/** Resolved path to the yaco binary (startup-time resolution).
 *  YACO_PATH env var wins (test/escape hatch); otherwise we trust `which`,
 *  falling back to the bare `yaco` name so PATH resolution still runs. */
export const YACO_PATH = (() => {
  if (process.env.YACO_PATH) return process.env.YACO_PATH
  try {
    return execSync('which yaco', { encoding: 'utf-8' }).trim() || 'yaco'
  } catch {
    return 'yaco'
  }
})()

/** Global yaco agent session state directory.
 *  Resolves to `${YACO_HOME:-~/.yaco}/sessions` via the shared YACO resolver
 *  (see `@yaco/cli/core/paths#sessionsDir`). The agent runtime owns writes;
 *  the YACO server reads + watches this directory. The agent CLI's
 *  YACO_AGENT_SESSIONS_DIR override is intentionally NOT honored here —
 *  YACO should observe the same root the agent is publishing to under
 *  default operation. */
export const MULTMUX_SESSIONS_DIR = sessionsDir()

/** Git max buffer for ls-files commands (50 MB) */
export const GIT_MAX_BUFFER = 50 * 1024 * 1024

/** Maximum file size for content endpoint (1 MB) */
export const FILE_SIZE_LIMIT = 1_000_000

/** Maximum file size for raw binary endpoint (20 MB) */
export const RAW_FILE_SIZE_LIMIT = 20_000_000

/** Timeout for `yaco agent send/kill/rename` commands (ms) */
export const YACO_AGENT_COMMAND_TIMEOUT_MS = 5_000

/** Timeout for `yaco agent start` command (ms) */
export const YACO_AGENT_START_TIMEOUT_MS = 15_000

/** Timeout for `yaco agent status --json` backfill (ms) */
export const YACO_AGENT_STATUS_TIMEOUT_MS = 10_000

/** Timeout for `yaco task <subcommand>` commands (ms).
 *  Must strictly EXCEED the CLI's task-lock timeout so that, under
 *  contention, the CLI emits its structured LOCK envelope before this
 *  server-side execFile kills the child — otherwise we'd swallow LOCK
 *  into a generic 500. +5_000ms headroom covers fork/parse overhead. */
export const YACO_TASK_COMMAND_TIMEOUT_MS = DEFAULT_TASK_LOCK_TIMEOUT_MS + 5_000

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

/** WebSocket ping interval for dead connection detection (ms) */
export const WS_PING_INTERVAL_MS = 30_000
