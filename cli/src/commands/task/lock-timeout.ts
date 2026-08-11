/** The one place `YACO_TASK_LOCK_TIMEOUT_MS` is read.
 *
 *  It is a test/debug override — it lets integration tests exercise the LOCK
 *  exit path without waiting the full 10s default — and it lives at the command
 *  edge because `core/task` is an exported closure. Rule 1 of the design's
 *  export eligibility says a deadline is an explicit argument below the seam,
 *  and the ambient allowlist is closed at `YACO_HOME`, `HOME` and
 *  `YACO_AGENT_SESSIONS_DIR`; a fourth name there fails the export audit.
 *
 *  Every command that takes the tasks-file lock calls this and passes the
 *  result down, so the documented override still covers the whole surface it
 *  used to: `task set`, `task rm`, `task archive`, `task link/unlink`, and
 *  `agent rename`.
 */

/** Explicit lock deadline for this invocation, or undefined to let
 *  `DEFAULT_TASK_LOCK_TIMEOUT_MS` stand. A non-numeric or non-positive value
 *  is ignored rather than fatal: it is a debugging knob, not an interface. */
export function taskLockTimeoutMs(): number | undefined {
  const raw = process.env["YACO_TASK_LOCK_TIMEOUT_MS"];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
