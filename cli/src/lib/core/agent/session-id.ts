import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Database } from "bun:sqlite";

// Re-export from model.ts (single source of truth) so callers can keep
// importing PENDING_SESSION_ID from this module without breaking.
export { PENDING_SESSION_ID } from "./model.ts";

interface ClaudeSessionFile {
  pid: number;
  sessionId: string;
}

/** Scan ~/.claude/sessions/*.json for a file whose pid matches */
function scanClaudeSessions(pid: number): string {
  const dir = join(homedir(), ".claude", "sessions");
  if (!existsSync(dir)) return "";

  // The filename is <pid>.json — check directly first
  const directPath = join(dir, `${pid}.json`);
  if (existsSync(directPath)) {
    try {
      const data: ClaudeSessionFile = JSON.parse(readFileSync(directPath, "utf-8"));
      if (data.sessionId) return data.sessionId;
    } catch {
      // fall through to scan
    }
  }

  // Fallback: scan all files (PID might differ from filename in edge cases)
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data: ClaudeSessionFile = JSON.parse(readFileSync(join(dir, file), "utf-8"));
        if (data.pid === pid && data.sessionId) return data.sessionId;
      } catch {
        continue;
      }
    }
  } catch {
    // dir read failed
  }
  return "";
}

const MAX_THREAD_STARTUP_SEC = 60; // match MAX_ROLLOUT_DELAY_MS window

/** Query ~/.codex/state_5.sqlite 'threads' table for the latest thread matching a cwd.
 *  When sessionCreatedMs is provided, constrain to a [start-1s, start+60s] window
 *  so concurrent sessions in the same cwd don't steal each other's thread. */
function queryCodexThreadId(cwd: string, sessionCreatedMs?: number): string {
  const dbPath = join(homedir(), ".codex", "state_5.sqlite");
  if (!existsSync(dbPath)) return "";

  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      if (sessionCreatedMs) {
        // created_at is epoch seconds; convert sessionCreatedMs to seconds
        const lowerBound = Math.floor((sessionCreatedMs - 1000) / 1000);
        const upperBound = Math.ceil(sessionCreatedMs / 1000) + MAX_THREAD_STARTUP_SEC;
        const row = db
          .query<{ id: string }, [string, number, number]>(
            `SELECT id FROM threads
             WHERE cwd = ? AND created_at > ? AND created_at < ?
             ORDER BY created_at ASC LIMIT 1`,
          )
          .get(cwd, lowerBound, upperBound);
        return row?.id ?? "";
      }
      // No time-bound — return latest thread for this cwd
      const row = db
        .query<{ id: string }, [string]>(
          `SELECT id FROM threads WHERE cwd = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(cwd);
      return row?.id ?? "";
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T[\w-]+-([0-9a-f-]{36})\.jsonl$/;
const MAX_ROLLOUT_DELAY_MS = 60_000;
const MAX_ROLLOUT_CLOCK_SKEW_MS = 1_000;

export interface RolloutMatch {
  threadId: string;
  summary: string;
}

/** Extract first user message from a Codex rollout JSONL file (first 30 lines). */
function readRolloutSummary(path: string): string {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n").slice(0, 30)) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
          const msg = entry.payload.message;
          if (typeof msg === "string" && msg.trim()) return msg.replace(/\s+/g, " ").trim();
        }
      } catch { continue; }
    }
  } catch { /* ignore */ }
  return "";
}

/** Scan ~/.codex/sessions/ rollout files to find a thread_id by file birthtime.
 *  Used when DB query fails (e.g., no matching thread in SQLite).
 *  Matches the first rollout created for this session after startup. */
function scanCodexRollouts(sessionCreatedMs: number): RolloutMatch | null {
  const sessionsRoot = join(homedir(), ".codex", "sessions");
  if (!existsSync(sessionsRoot)) return null;

  const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

  let bestPath = "";
  let bestId = "";
  let bestDelay = MAX_ROLLOUT_DELAY_MS + 1;

  try {
    for (const year of readdirSync(sessionsRoot).filter(f => isDir(join(sessionsRoot, f))).sort().slice(-1)) {
      const yearDir = join(sessionsRoot, year);
      for (const month of readdirSync(yearDir).filter(f => isDir(join(yearDir, f))).sort().slice(-1)) {
        const monthDir = join(yearDir, month);
        for (const day of readdirSync(monthDir).filter(f => isDir(join(monthDir, f))).sort().slice(-7)) {
          const dayDir = join(monthDir, day);
          for (const file of readdirSync(dayDir)) {
            const m = file.match(ROLLOUT_RE);
            if (!m) continue;
            try {
              const filePath = join(dayDir, file);
              const birthtimeMs = statSync(filePath).birthtimeMs;
              const delayMs = birthtimeMs - sessionCreatedMs;
              if (delayMs < -MAX_ROLLOUT_CLOCK_SKEW_MS || delayMs > MAX_ROLLOUT_DELAY_MS) {
                continue;
              }
              if (delayMs < bestDelay) {
                bestDelay = delayMs;
                bestId = m[1];
                bestPath = filePath;
              }
            } catch { continue; }
          }
        }
      }
    }
  } catch { /* ignore */ }

  if (!bestId) return null;
  return { threadId: bestId, summary: readRolloutSummary(bestPath) };
}

export interface SessionIdResult {
  sessionId: string;
  summary?: string;
}

/**
 * Resolve agent session ID from local files.
 * Claude: PID-based scan. Codex: rollout scan (ms precision) → DB fallback.
 */
export function resolveSessionId(pid: number, provider: string, sessionCreatedMs?: number, sessionPath?: string): SessionIdResult | null {
  if (provider === "claude") {
    if (pid <= 0) return null;
    const id = scanClaudeSessions(pid);
    return id ? { sessionId: id } : null;
  }
  if (provider === "codex") {
    // Primary: rollout file birthtime (ms precision — safe under concurrency)
    if (sessionCreatedMs) {
      const match = scanCodexRollouts(sessionCreatedMs);
      if (match) return { sessionId: match.threadId, summary: match.summary };
    }
    // Fallback: DB query (second precision, wider window)
    if (sessionPath) {
      const id = queryCodexThreadId(sessionPath, sessionCreatedMs);
      if (id) return { sessionId: id };
    }
  }
  return null;
}
