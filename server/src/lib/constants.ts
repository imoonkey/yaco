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
