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

const STALE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

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

/** Remove any breadcrumb pointing to or from this handle. */
function cleanupBreadcrumbs(handle: string): void {
  const dir = sessionsRoot();
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
      if (!f.startsWith(".renamed-")) continue;
      const target = readFileSync(join(dir, f), "utf-8").trim();
      if (!existsSync(statePath(target))) unlinkSync(join(dir, f));
    }
  } catch { /* best effort */ }
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
  cleanupBreadcrumbs(oldHandle);

  // Write breadcrumb so wrapper EXIT trap can find the new name after kill-session.
  // Chain-safe: if A→B was renamed and now B→C, update A's breadcrumb to point to C.
  ensureStateDir();
  const dir = sessionsRoot();
  try {
    const files = readdirSync(dir);
    let updated = false;
    for (const f of files) {
      if (!f.startsWith(".renamed-")) continue;
      const target = readFileSync(join(dir, f), "utf-8").trim();
      if (target === oldHandle) {
        writeFileSync(join(dir, f), newHandle);
        updated = true;
        break;
      }
    }
    if (!updated) {
      writeFileSync(join(dir, `.renamed-${oldHandle}`), newHandle);
    }
  } catch { /* best effort */ }
}

/** Check if state file's status is stale (mtime too old for "processing" or "starting") */
export function isStale(handle: string): boolean {
  const path = statePath(handle);
  if (!existsSync(path)) return false;
  try {
    const state = readState(handle);
    if (!state || (state.status !== "processing" && state.status !== "starting")) return false;
    const mtime = statSync(path).mtimeMs;
    return Date.now() - mtime > STALE_THRESHOLD_MS;
  } catch {
    return false;
  }
}

/**
 * List all state files in the global sessions directory.
 * Returns handles (filenames without .json extension).
 */
export function listStateHandles(): string[] {
  const dir = sessionsRoot();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => f.slice(0, -5));
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
