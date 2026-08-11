/** `yaco agent history --path <project-path>` — the argv-and-render adapter over
 *  the shared project-history read.
 *
 *  Merging, windowing and live tagging are `core/agent`'s `readProjectHistory`,
 *  which `app/server` calls in process; this module resolves the flags, supplies
 *  the live sessions from YACO's own state files, and renders. One
 *  implementation behind both call mechanisms. */

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { isErr } from "../../lib/core/result.ts";
import { DEFAULT_HISTORY_LIMIT, readProjectHistory } from "../../lib/core/agent/providers/history.ts";
import { listByPath } from "../../lib/core/agent/session-state.ts";
import type { HistorySession, HistoryWindow } from "../../lib/core/agent/providers/types.ts";

export const HISTORY_USAGE =
  "yaco agent history [--path <project-path>] [--since <iso-timestamp-with-timezone>] [--limit <n>] [--json]";

export interface HistoryArgs {
  projectPath: string;
  limit: number;
  since?: Date;
  json: boolean;
}

function usage(detail: string): CliError {
  return new CliError(ErrCode.USAGE, `${HISTORY_USAGE} (${detail})`);
}

function requireValue(label: string, value: string | undefined): string {
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw usage(`${label} requires a value`);
  }
  return value;
}

function parseLimitValue(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw usage(`--limit requires a positive integer (got: ${value ?? "<missing>"})`);
  }
  const limit = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw usage(`--limit requires a positive integer (got: ${value})`);
  }
  return limit;
}

function parseSinceValue(value: string | undefined): Date {
  const raw = requireValue("--since", value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw usage(`--since requires a full ISO-8601 timestamp with timezone, e.g. 2026-06-15T00:00:00Z (got: ${raw})`);
  }
  const since = new Date(raw);
  if (Number.isNaN(since.getTime())) {
    throw usage(`--since requires a full ISO-8601 timestamp with timezone, e.g. 2026-06-15T00:00:00Z (got: ${raw})`);
  }
  return since;
}

/** Strict allowlist parser. Only documented flags are accepted; any unknown
 *  flag or leftover positional is USAGE so machine callers cannot silently scan
 *  the wrong history window. */
export function parseHistoryArgs(args: string[]): HistoryArgs {
  let projectPath = process.cwd();
  let limit = DEFAULT_HISTORY_LIMIT;
  let since: Date | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--path") { projectPath = requireValue("--path", args[++i]); continue; }
    if (arg.startsWith("--path=")) { projectPath = requireValue("--path", arg.slice("--path=".length)); continue; }
    if (arg === "--limit") { limit = parseLimitValue(args[++i]); continue; }
    if (arg.startsWith("--limit=")) { limit = parseLimitValue(arg.slice("--limit=".length)); continue; }
    if (arg === "--since") { since = parseSinceValue(args[++i]); continue; }
    if (arg.startsWith("--since=")) { since = parseSinceValue(arg.slice("--since=".length)); continue; }
    if (arg.startsWith("-")) throw usage(`unknown flag: ${arg}`);
    throw usage(`unexpected argument: ${arg}`);
  }

  return { projectPath, limit, since, json };
}

export async function runHistory(
  projectPath: string,
  options: { limit?: number; since?: Date } = {},
): Promise<HistoryWindow> {
  const window = await readProjectHistory(projectPath, listByPath(projectPath), options);
  if (isErr(window)) throw new CliError(window.code as ErrCode, window.message, window.details);
  return window.value;
}

/** Concise text rendering: one line per session, newest-first as returned. */
export function renderHistory(sessions: HistorySession[]): string {
  if (sessions.length === 0) return "(no sessions)\n";
  const lines = sessions.map((s) => {
    const live = s.live ? " *" : "";
    const title = s.title ?? s.summary ?? "";
    return `${s.provider.padEnd(7)} ${s.sessionId}${live}  ${title}`;
  });
  return lines.join("\n") + "\n";
}
