/** Tasks-file lock — `<tasks-file>.lock.d` directory + owner metadata.
 *
 *  Atomic `mkdir` is the primitive. Owner metadata recorded inside the
 *  lock directory lets `yaco task validate` flag stale cross-host locks
 *  and lets local stale locks (same hostname, dead PID) be reclaimed
 *  silently on retry. Cross-host locks are NEVER auto-broken — manual
 *  `rm -rf <tasks-file>.lock.d` is the escape hatch.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { CliError, ErrCode } from "../errors.ts";

/** Default ms to wait for the tasks-file lock before raising LOCK.
 *  Exported so out-of-process callers (e.g. app/server's task route
 *  spawn timeouts) can stay strictly above this and let the CLI emit
 *  its structured LOCK envelope on contention. Override per-call with
 *  AcquireOptions.timeoutMs or via the YACO_TASK_LOCK_TIMEOUT_MS env. */
export const DEFAULT_TASK_LOCK_TIMEOUT_MS = 10_000;

export interface LockOwner {
  pid: number;
  hostname: string;
  startedAt: string;
  command: string;
}

export interface AcquireOptions {
  timeoutMs?: number;
  pollMs?: number;
  command?: string;
  /** Override hostname for testing — defaults to os.hostname(). */
  hostname?: string;
  /** Override pid for testing — defaults to process.pid. */
  pid?: number;
}

export interface LockHandle {
  release: () => void;
  path: string;
  owner: LockOwner;
}

/** Acquire the lock for `tasksPath`. Resolves once the lock dir is owned
 *  by this process; rejects with CliError(LOCK, ...) if the timeout
 *  expires while another live owner holds it. */
export async function acquireLock(
  tasksPath: string,
  opts: AcquireOptions = {},
): Promise<LockHandle> {
  const lockPath = lockPathFor(tasksPath);
  // The tasks-file dir is also the lock-file dir — make sure it exists so
  // the very first mutation on a fresh repo can succeed.
  mkdirSync(dirname(lockPath), { recursive: true });
  const timeoutMs = opts.timeoutMs ?? envTimeoutMs() ?? DEFAULT_TASK_LOCK_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? 50;
  const owner: LockOwner = {
    pid: opts.pid ?? process.pid,
    hostname: opts.hostname ?? hostname(),
    startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    command: opts.command ?? "yaco task",
  };
  const deadline = Date.now() + timeoutMs;

  // First attempt is immediate; subsequent attempts back off by pollMs.
  while (true) {
    if (tryMkdir(lockPath)) {
      writeOwner(lockPath, owner);
      return makeHandle(lockPath, owner);
    }
    // Already locked — inspect owner metadata.
    const existing = readOwnerSafe(lockPath);
    if (existing && canReclaim(existing, owner.hostname)) {
      // Same-host dead-PID lock — best-effort rm and retry immediately.
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // Lost the race with another reclaimer; just loop and retry.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      const details: Record<string, unknown> = { lockPath };
      if (existing) details["owner"] = existing;
      throw new CliError(
        ErrCode.LOCK,
        `failed to acquire ${lockPath} within ${timeoutMs}ms`,
        details,
      );
    }
    await sleep(pollMs);
  }
}

/** Sync-friendly release: rm -rf the lock dir. Safe to call twice. */
function makeHandle(lockPath: string, owner: LockOwner): LockHandle {
  let released = false;
  return {
    path: lockPath,
    owner,
    release: () => {
      if (released) return;
      released = true;
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // Best-effort — manual cleanup remains the escape hatch.
      }
    },
  };
}

/** Run `fn` while holding the lock; release in `finally`. */
export async function withLock<T>(
  tasksPath: string,
  fn: () => T | Promise<T>,
  opts: AcquireOptions = {},
): Promise<T> {
  const handle = await acquireLock(tasksPath, opts);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

export function lockPathFor(tasksPath: string): string {
  return `${tasksPath}.lock.d`;
}

/** Inspect the lock dir without taking it. Returns null if no lock,
 *  or a description used by `yaco task validate` for stale-lock surfacing. */
export interface LockStatus {
  held: boolean;
  owner?: LockOwner;
  ageMs?: number;
  sameHost?: boolean;
  pidAlive?: boolean;
  reclaimable?: boolean;
  notes?: string[];
}

export function describeLock(
  tasksPath: string,
  hostOverride?: string,
): LockStatus {
  const lockPath = lockPathFor(tasksPath);
  if (!existsSync(lockPath)) return { held: false };

  const host = hostOverride ?? hostname();
  const owner = readOwnerSafe(lockPath);
  let ageMs: number | undefined;
  try {
    const st = statSync(lockPath);
    ageMs = Date.now() - st.mtimeMs;
  } catch {
    ageMs = undefined;
  }
  if (!owner) {
    return {
      held: true,
      ageMs,
      notes: ["owner metadata missing or unreadable"],
    };
  }
  const sameHost = owner.hostname === host;
  const aliveResult = sameHost ? isPidAlive(owner.pid) : undefined;
  const pidAlive: boolean | undefined =
    aliveResult === null ? undefined : aliveResult;
  const reclaimable = sameHost && pidAlive === false;
  const notes: string[] = [];
  if (!sameHost) {
    notes.push(
      `cross-host lock from ${owner.hostname} (pid ${owner.pid}) — not auto-reclaimed`,
    );
  } else if (pidAlive === false) {
    notes.push(`local stale lock (pid ${owner.pid} dead) — would be reclaimed on next acquire`);
  }
  return { held: true, owner, ageMs, sameHost, pidAlive, reclaimable, notes };
}

// ----- internals --------------------------------------------------------

function tryMkdir(path: string): boolean {
  try {
    mkdirSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw new CliError(
      ErrCode.LOCK,
      `failed to create lock ${path}: ${(err as Error).message}`,
    );
  }
}

function writeOwner(lockPath: string, owner: LockOwner): void {
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner) + "\n", "utf-8");
}

function readOwnerSafe(lockPath: string): LockOwner | null {
  try {
    const raw = readFileSync(join(lockPath, "owner.json"), "utf-8");
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.command === "string"
    ) {
      return parsed as LockOwner;
    }
    return null;
  } catch {
    return null;
  }
}

function canReclaim(owner: LockOwner, currentHost: string): boolean {
  if (owner.hostname !== currentHost) return false;
  return isPidAlive(owner.pid) === false;
}

/** True if pid exists, false if known-dead, null if unknown (permission). */
function isPidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // can't signal, but it does exist
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test/debug override: YACO_TASK_LOCK_TIMEOUT_MS lets integration tests
 *  exercise the LOCK exit path without waiting the full 10s default. */
function envTimeoutMs(): number | undefined {
  const raw = process.env["YACO_TASK_LOCK_TIMEOUT_MS"];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
