import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { sessionsDir } from "../paths/yaco-home.ts";
import type { SessionState } from "./model.ts";

export type { SessionState, SessionStatus } from "./model.ts";

// Agent session-state directory.
//
// Resolution order (call-time, NOT module-load-time so tests and explicit
// overrides take effect even if the module was already imported):
//   1. process.env.YACO_AGENT_SESSIONS_DIR — explicit escape hatch / test knob
//   2. sessionsDir() — ${YACO_HOME:-~/.yaco}/sessions (default)
function sessionsRoot(): string {
  return process.env["YACO_AGENT_SESSIONS_DIR"] || sessionsDir();
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const PROCESSING_RECHECK_MS = 15 * 1000;

export function stateDir(): string {
  return sessionsRoot();
}

export function statePath(handle: string): string {
  return join(sessionsRoot(), `${handle}.json`);
}

export function ensureStateDir(): void {
  const dir = sessionsRoot();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function writeState(state: SessionState): void {
  ensureStateDir();
  const path = statePath(state.handle);
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state));
  renameSync(tmpPath, path);
}

export function readState(handle: string): SessionState | null {
  const path = statePath(handle);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SessionState;
  } catch {
    return null;
  }
}

export function deleteState(handle: string): void {
  const path = statePath(handle);
  if (existsSync(path)) unlinkSync(path);
  cleanupBreadcrumbs(handle);
}

/** Where the wrapper's EXIT trap leaves what the pane held when the session
 *  died abnormally. See `scripts/agent-wrapper.sh#write_exit_report`. */
export function exitReportPath(handle: string): string {
  return join(sessionsRoot(), `.exit-${handle}`);
}

/** What the provider printed before it exited, and the code it exited with. */
export interface ExitReport {
  exitCode: number;
  output: string;
}

/** The exit report for THIS generation of `handle`, or null when there is
 *  none.
 *
 *  `createdAt` is the generation discriminator, exactly as it is for the crash
 *  tombstone: a handle is reusable, and a report left by an earlier session of
 *  the same name describes a different run. A file that is absent, truncated,
 *  foreign, or whose exit code is not a number reads as "no report" — this
 *  enriches an error message, so it must never be able to raise one. */
export function readExitReport(handle: string, createdAt: string): ExitReport | null {
  let raw: string;
  try {
    raw = readFileSync(exitReportPath(handle), "utf-8");
  } catch {
    return null;
  }
  const [generation, code, ...rest] = raw.split("\n");
  if (generation !== createdAt) return null;
  if (!code || !/^-?\d+$/.test(code)) return null;
  return { exitCode: Number(code), output: rest.join("\n").trim() };
}

/** Remove any breadcrumb pointing to or from this handle. */
function cleanupBreadcrumbs(handle: string): void {
  const dir = sessionsRoot();
  try {
    unlinkSync(exitReportPath(handle));
  } catch { /* absent */ }
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(".renamed-")) continue;
      // Breadcrumb FROM this handle
      if (f === `.renamed-${handle}`) {
        unlinkSync(join(dir, f));
        continue;
      }
      // Breadcrumb TO this handle
      const target = readFileSync(join(dir, f), "utf-8").trim();
      if (target === handle) unlinkSync(join(dir, f));
    }
  } catch { /* best effort */ }
}

/** Remove breadcrumbs whose target state file no longer exists (post-crash cleanup). */
export function cleanupOrphanBreadcrumbs(): void {
  const dir = sessionsRoot();
  if (!existsSync(dir)) return;
  try {
    for (const f of readdirSync(dir)) {
      // An exit report explains a session. Its state file outlives the wrapper
      // that wrote it (the crash branch tombstones, it does not delete), so a
      // report with no state file left is one nobody can still be waiting on.
      if (f.startsWith(".exit-")) {
        if (!existsSync(statePath(f.slice(".exit-".length)))) unlinkSync(join(dir, f));
        continue;
      }
      if (!f.startsWith(".renamed-")) continue;
      const target = readFileSync(join(dir, f), "utf-8").trim();
      if (!existsSync(statePath(target))) unlinkSync(join(dir, f));
    }
  } catch { /* best effort */ }
}

/** Resolve a possibly-stale handle to its current name by following the
 *  `.renamed-<old>` breadcrumb chain. A renamed parent process keeps the old
 *  handle in its env (env can't be mutated post-rename), so start capture walks
 *  the breadcrumbs to record the live handle as `parentSession`.
 *
 *  A handle that still has a live state file is returned as-is (it is current,
 *  even if a stale breadcrumb of the same name lingers from a reused name).
 *  Bounded by a visited set so a breadcrumb cycle cannot loop forever. */
export function resolveRenamedHandle(handle: string): string {
  const dir = sessionsRoot();
  let current = handle;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    if (existsSync(statePath(current))) return current;
    const crumb = join(dir, `.renamed-${current}`);
    if (!existsSync(crumb)) break;
    try {
      const next = readFileSync(crumb, "utf-8").trim();
      if (!next || visited.has(next)) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

/** Rename a session's state file and update its contents. */
export function renameState(
  oldHandle: string,
  newHandle: string,
  existingState?: SessionState,
): void {
  const state = existingState ?? readState(oldHandle);
  if (!state) throw new Error(`State file for "${oldHandle}" not found`);

  // Write new state file BEFORE deleting old — prevents race where GC
  // deletes old file between tmux rename and state rename, leaving no file.
  state.handle = newHandle;
  writeState(state);

  // Delete old file (may already be gone if GC raced us — that's fine)
  const oldPath = statePath(oldHandle);
  if (existsSync(oldPath)) unlinkSync(oldPath);

  // Update breadcrumbs so any stale handle resolves to newHandle. Chain-safe:
  // if A→B was renamed and now B→C, A's breadcrumb (target B) must be rewritten
  // to C. This MUST run before deleting/overwriting B's own crumbs — calling a
  // destructive cleanup first would remove the incoming A→B crumb and break the
  // chain, so a child holding YACO_AGENT_HANDLE=A could no longer reach C.
  ensureStateDir();
  const dir = sessionsRoot();
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(".renamed-")) continue;
      // The FROM-crumb for oldHandle is (re)written below; skip it here.
      if (f === `.renamed-${oldHandle}`) continue;
      const target = readFileSync(join(dir, f), "utf-8").trim();
      if (target === oldHandle) writeFileSync(join(dir, f), newHandle);
    }
    // Breadcrumb FROM oldHandle → newHandle. Overwrites any stale FROM-crumb
    // left by a prior session that reused this name.
    writeFileSync(join(dir, `.renamed-${oldHandle}`), newHandle);
  } catch { /* best effort */ }
}

/** Rewrite live child sessions' `parentSession` from oldHandle to newHandle.
 *
 *  Called best-effort after `yaco agent rename` performs the authoritative
 *  state-file/tmux rename: lineage stores parent handles, so a parent rename
 *  must re-point its children. Idempotent — a second run finds no child
 *  pointing at oldHandle. Returns the handles of children that were rewritten. */
export function rewriteChildParentSessions(
  oldHandle: string,
  newHandle: string,
): string[] {
  const rewritten: string[] = [];
  for (const handle of listStateHandles()) {
    const state = readState(handle);
    if (!state || state.parentSession !== oldHandle) continue;
    state.parentSession = newHandle;
    writeState(state);
    rewritten.push(state.handle);
  }
  return rewritten;
}

/** Check if state file's status is stale enough to recheck. */
export function isStale(handle: string): boolean {
  const path = statePath(handle);
  if (!existsSync(path)) return false;
  try {
    const state = readState(handle);
    if (!state) return false;
    const threshold =
      state.status === "starting" ? STALE_THRESHOLD_MS
      : state.status === "processing" || state.status === "blocked" ? PROCESSING_RECHECK_MS
      : null;
    if (threshold === null) return false;
    const mtime = statSync(path).mtimeMs;
    return Date.now() - mtime > threshold;
  } catch {
    return false;
  }
}

/**
 * List all state files in the global sessions directory.
 * Returns handles (filenames without .json extension), ascending by handle.
 *
 * The sort is the CLI's session-order contract: this is the enumeration behind
 * `agent list`, `agent summaries`, and every `listByPath` caller, and a raw
 * directory read has no defined order — it differs between Bun and Node on the
 * same directory. Ordering is by code unit (plain `.sort()`, never
 * `localeCompare`) so the order is a property of the handles alone, not of the
 * runtime or the machine's locale.
 */
export function listStateHandles(): string[] {
  const dir = sessionsRoot();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

/**
 * List sessions whose sessionPath is a descendant of the given path.
 * Path-boundary-safe: /foo/bar must not match /foo/bar-old.
 */
export function listByPath(path: string): SessionState[] {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  const results: SessionState[] = [];
  for (const handle of listStateHandles()) {
    const state = readState(handle);
    if (!state) continue;
    if (state.sessionPath === normalized || state.sessionPath.startsWith(normalized + "/")) {
      results.push(state);
    }
  }
  return results;
}
