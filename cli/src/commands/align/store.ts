/** Alignment coordination — filesystem side of the protocol.
 *
 *  Owns everything the pure `protocol.ts` cannot: where the bundle lives, the
 *  atomic single-writer status file, the recursive `final/` fingerprint that
 *  drives vote inference, the per-turn snapshot under `discussion/.align/`, and
 *  the blocking wait loop. Callers cross this through the verb handlers; they
 *  never touch `status.txt` or `.align/` directly.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { CliError, ErrCode } from "../../lib/core/errors.ts";
import {
  formatStatus,
  parseStatus,
  type Role,
  type Status,
} from "./protocol.ts";

export interface OpenTurn {
  turnSeq: number;
  role: Role;
  baseHash: string;
}

export type WaitStatus = "YOUR_TURN" | "DONE" | "TIMEOUT" | "ERROR";

export interface WaitOutcome {
  status: WaitStatus;
  parsed?: Status;
  message?: string;
}

export interface WaitOptions {
  bundle: string;
  role: Role;
  intervalMs: number;
  /** 0 means wait indefinitely. */
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  silent?: boolean;
}

// ─── Path helpers ───────────────────────────────────────────────────────────

const discussionDir = (bundle: string) => join(bundle, "discussion");
export const finalDir = (bundle: string) => join(bundle, "final");
export const statusPath = (bundle: string) => join(discussionDir(bundle), "status.txt");
const alignDir = (bundle: string) => join(discussionDir(bundle), ".align");
const turnPath = (bundle: string) => join(alignDir(bundle), "turn.json");

export function turnFilePath(bundle: string, turnSeq: number, role: Role): string {
  return join(discussionDir(bundle), `${pad(turnSeq)}_${role}.md`);
}

/** A turn is only closeable once the agent has written non-empty notes into its
 *  reserved discussion file. */
export function turnFileFilled(bundle: string, turnSeq: number, role: Role): boolean {
  const path = turnFilePath(bundle, turnSeq, role);
  return existsSync(path) && readFileSync(path, "utf-8").trim() !== "";
}

const pad = (n: number) => String(n).padStart(4, "0");

// ─── Bundle resolution ──────────────────────────────────────────────────────

/** Resolve the directory `init` should create the bundle in. Rejects a path
 *  that points at a file (e.g. a raw `status.txt`); defaults to cwd. */
export function initTarget(dirArg: string | undefined): string {
  return rejectFilePath(resolve(dirArg ?? process.cwd()));
}

/** Resolve an existing bundle for wait/handoff/status. Explicit `<dir>` must
 *  hold `discussion/status.txt`; when omitted, walk up from cwd to the nearest
 *  bundle. */
export function resolveBundle(dirArg: string | undefined): string {
  if (dirArg !== undefined) {
    const dir = rejectFilePath(resolve(dirArg));
    if (!existsSync(statusPath(dir))) {
      throw new CliError(
        ErrCode.NOT_FOUND,
        `not an alignment bundle (no discussion/status.txt under ${dir}); run 'yaco align init' first`,
      );
    }
    return dir;
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(statusPath(dir))) return dir;
    if (dir === dirname(dir)) break;
  }
  throw new CliError(
    ErrCode.NOT_FOUND,
    "not inside an alignment bundle (no discussion/status.txt found walking up from cwd)",
  );
}

function rejectFilePath(path: string): string {
  if (basename(path) === "status.txt" || (existsSync(path) && statSync(path).isFile())) {
    throw new CliError(
      ErrCode.USAGE,
      `pass the bundle directory, not a file path (got ${path})`,
    );
  }
  return path;
}

/** Resolve the bundle for `wait` without requiring it to exist yet: an explicit
 *  `<dir>` is taken as-is, and an omitted one walks up to the nearest bundle or
 *  falls back to cwd. A missing/uninitialized status then surfaces as the loop's
 *  `ERROR` outcome (exit 2), not a dispatcher `NOT_FOUND` — the waiter keeps the
 *  poll-era contract that an absent bundle is an alignment ERROR. */
export function resolveWaitBundle(dirArg: string | undefined): string {
  if (dirArg !== undefined) return rejectFilePath(resolve(dirArg));
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(statusPath(dir))) return dir;
    if (dir === dirname(dir)) return process.cwd();
  }
}

// ─── status.txt (single writer, atomic) ─────────────────────────────────────

export function readStatus(bundle: string): Status {
  const path = statusPath(bundle);
  if (!existsSync(path)) {
    throw new CliError(ErrCode.NOT_FOUND, `no alignment status at ${path}`);
  }
  const line = readFileSync(path, "utf-8").split(/\r?\n/, 1)[0] ?? "";
  const parsed = parseStatus(line);
  if (!parsed) {
    throw new CliError(ErrCode.INVALID, `malformed alignment status line: ${line}`);
  }
  return parsed;
}

export function writeStatus(bundle: string, status: Status): void {
  const path = statusPath(bundle);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, formatStatus(status) + "\n", "utf-8");
  renameSync(tmp, path);
}

export function initBundle(dir: string, first: Role): Status {
  if (existsSync(statusPath(dir))) {
    throw new CliError(
      ErrCode.CONFLICT,
      `alignment already initialized at ${statusPath(dir)}`,
    );
  }
  mkdirSync(discussionDir(dir), { recursive: true });
  mkdirSync(finalDir(dir), { recursive: true });
  const status: Status = { seq: 0, next: first, codex: "PENDING", claude: "PENDING" };
  writeStatus(dir, status);
  return status;
}

// ─── final/ fingerprint (recursive, mtime-independent) ──────────────────────

/** Content hash of every file under `final/`, recursive and order-stable. Only
 *  bytes and relative paths feed the digest, so mtime/permission changes don't
 *  count as edits — exactly what vote inference needs. Absent `final/` hashes
 *  to a stable empty digest. */
export function hashFinal(bundle: string): string {
  const root = finalDir(bundle);
  const files: string[] = [];
  walk(root, root, files);
  files.sort();
  const top = createHash("sha256");
  for (const rel of files) {
    const fileHash = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
    top.update(rel).update("\0").update(fileHash).update("\n");
  }
  return top.digest("hex");
}

function walk(root: string, dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, abs, out);
    else if (entry.isFile()) out.push(abs.slice(root.length + 1));
    else if (entry.isSymbolicLink()) {
      // Follow one level: hash a symlink that resolves to a regular file so a
      // symlinked design doc still counts toward vote inference. Dir symlinks
      // are skipped (cycle-safe); broken links have no content to hash.
      try {
        if (statSync(abs).isFile()) out.push(abs.slice(root.length + 1));
      } catch {
        // broken symlink — ignore
      }
    }
  }
}

// ─── Open-turn snapshot (discussion/.align/turn.json) ───────────────────────

/** Open (or resume) the turn `turnSeq` for `role`: snapshot the pre-turn
 *  `final/` hash so handoff can detect edits. Re-opening an already-open turn
 *  keeps the original baseline — re-running `wait` before a handoff is safe. */
export function openTurn(bundle: string, role: Role, turnSeq: number): OpenTurn {
  const existing = readOpenTurn(bundle);
  if (existing && existing.turnSeq === turnSeq && existing.role === role) {
    return existing;
  }
  const turn: OpenTurn = { turnSeq, role, baseHash: hashFinal(bundle) };
  mkdirSync(alignDir(bundle), { recursive: true });
  const tmp = `${turnPath(bundle)}.tmp`;
  writeFileSync(tmp, JSON.stringify(turn), "utf-8");
  renameSync(tmp, turnPath(bundle));
  return turn;
}

export function readOpenTurn(bundle: string): OpenTurn | null {
  const path = turnPath(bundle);
  if (!existsSync(path)) return null;
  try {
    const t = JSON.parse(readFileSync(path, "utf-8")) as OpenTurn;
    if (
      typeof t.turnSeq === "number" &&
      (t.role === "CODEX" || t.role === "CLAUDE") &&
      typeof t.baseHash === "string"
    ) {
      return t;
    }
  } catch {
    // fall through — a corrupt snapshot is treated as no open turn
  }
  return null;
}

export function clearOpenTurn(bundle: string): void {
  rmSync(turnPath(bundle), { force: true });
}

// ─── Blocking wait loop ─────────────────────────────────────────────────────

/** Block until NEXT is the caller's role (YOUR_TURN) or DONE. Mirrors the old
 *  poll loop: a missing/malformed status returns ERROR immediately (the CLI is
 *  the sole writer, so that means an uninitialized/corrupt bundle, not a torn
 *  line). Side-effect free beyond the best-effort wait.log. */
export async function waitForTurn(opts: WaitOptions): Promise<WaitOutcome> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  const log = makeLogger(opts.bundle, opts.silent === true);
  log(`wait start: role=${opts.role} interval=${opts.intervalMs}ms timeout=${opts.timeoutMs}ms`);

  let prev = "";
  while (true) {
    if (opts.timeoutMs > 0 && now() - start >= opts.timeoutMs) {
      log(`wait timeout after ${now() - start}ms`);
      return { status: "TIMEOUT", message: `no turn for ${opts.role} within ${opts.timeoutMs}ms` };
    }

    const parsed = readStatusOrNull(opts.bundle);
    if (!parsed) {
      log(`ERROR: cannot read/parse status at ${statusPath(opts.bundle)}`);
      return { status: "ERROR", message: `cannot read alignment status at ${statusPath(opts.bundle)}` };
    }

    const line = formatStatus(parsed);
    if (line !== prev) {
      log(line);
      prev = line;
    }
    if (parsed.next === "DONE") return { status: "DONE", parsed };
    if (parsed.next === opts.role) return { status: "YOUR_TURN", parsed };

    await sleep(opts.intervalMs);
  }
}

function readStatusOrNull(bundle: string): Status | null {
  const path = statusPath(bundle);
  if (!existsSync(path)) return null;
  try {
    return parseStatus(readFileSync(path, "utf-8").split(/\r?\n/, 1)[0] ?? "");
  } catch {
    return null;
  }
}

function makeLogger(bundle: string, silent: boolean): (msg: string) => void {
  if (silent) return () => {};
  const logPath = join(discussionDir(bundle), "wait.log");
  let initialized = false;
  return (msg: string) => {
    try {
      if (!initialized) {
        mkdirSync(dirname(logPath), { recursive: true });
        initialized = true;
      }
      appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
    } catch {
      // best-effort; never block the wait loop on a log write
    }
  };
}
