import { capturePane, hasSession } from "../tmux.ts";
import { stripAnsi, validateName } from "../utils.ts";
import { reconcile } from "./status.ts";

const POLL_INTERVAL_MS = 1000;
const WAIT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function capture(
  name: string,
  options: { wait?: boolean; lines?: number; stripAnsiCodes?: boolean },
): Promise<string> {
  validateName(name);
  const includeEscapes = options.stripAnsiCodes === false;
  if (!hasSession(name)) {
    throw new Error(`Session "${name}" not found`);
  }

  if (options.wait) {
    const start = Date.now();
    while (Date.now() - start < WAIT_TIMEOUT_MS) {
      // G8: Use shared reconciliation contract for idle detection
      const resolved = reconcile(name);
      if (!resolved) {
        throw new Error(`Session "${name}" ended while waiting`);
      }
      if (resolved.status === "idle") {
        const output = capturePane(name, options.lines, includeEscapes);
        return options.stripAnsiCodes !== false ? stripAnsi(output) : output;
      }
      if (!hasSession(name)) {
        throw new Error(`Session "${name}" ended while waiting`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Timeout waiting for "${name}" to become idle`);
  }

  const output = capturePane(name, options.lines, includeEscapes);
  return options.stripAnsiCodes !== false ? stripAnsi(output) : output;
}
