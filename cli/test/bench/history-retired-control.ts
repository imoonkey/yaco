/** The retired history reader, verbatim — the control that makes this harness
 *  falsifiable.
 *
 *  This is `src/lib/core/agent/providers/history.ts` as it stood at commit
 *  725c46f3, the last commit before the read moved into the server. It is kept
 *  as source rather than described, for the same reason `summary-stall.ts`
 *  carries its `whole-file` route: a harness whose routes all measure alike is
 *  measuring nothing, and only a route with the *previous* shape can show that
 *  it does not.
 *
 *  Three things separate it from what ships, and the benchmark reports the sum:
 *  every row a provider holds is read before the window is applied, the whole
 *  fan-out runs as one `Promise.all` with no yield inside it, and the window's
 *  origin records are read with `readFileSync`, one per row.
 *
 *  Three mechanical edits were needed to keep it compiling beside its successor,
 *  and none changes what it does: the origin lookup and its `isSpawnedBy`
 *  predicate are inlined here (the module they used to live in is now a chunked
 *  asynchronous reader), `ProviderHistory` is declared locally (the shared read
 *  retired that capability from `TuiProvider`), and the imports are repointed at
 *  `src/`. Anything else that drifts from the commit above makes this control a
 *  fiction — review caught two such drifts on the first version of this file,
 *  a loosened `spawnedBy` check and a bypassed factory seam.
 *
 *  Check it rather than trust it:
 *
 *      git show 725c46f3:cli/src/lib/core/agent/providers/history.ts \
 *        | diff - cli/test/bench/history-retired-control.ts
 *
 *  It is not a committed test, because a test bound to a commit sha stops
 *  meaning anything the moment the branch is squashed or rebased — the same
 *  lesson the rollback matrix in `doc/main/cli/read-path.md` records.
 *
 *  Nothing imports it but the benchmark, and it is in no export closure. */

import { existsSync, readFileSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeClaudeCwd } from "../../src/lib/core/project/encode.ts";
import { originPathForSessionId, type OriginRecord } from "../../src/lib/core/agent/origin-read.ts";
import { PENDING_SESSION_ID, type SessionState } from "../../src/lib/core/agent/model.ts";
import { extractUserText, firstMeaningfulMessage } from "../../src/lib/core/agent/providers/prompt-label.ts";
import { codexDbPath, userHome } from "../../src/lib/core/agent/providers/provider-home.ts";
import type { HistorySession, HistoryWindow } from "../../src/lib/core/agent/providers/types.ts";

/** `ProviderHistory` as it stood at 725c46f3, before the shared read retired the
 *  capability from `TuiProvider`. */
interface RetiredProviderHistory {
  list(projectPath: string, liveSessions?: readonly SessionState[]): Promise<HistorySession[]>;
}

/** Default history row limit after filtering the merged provider rows. */
export const DEFAULT_HISTORY_LIMIT = 200;
/** Bytes read from the head of each Claude JSONL (first user message + start). */
const HEAD_BYTES = 16384;
/** Bytes read from the tail of each Claude JSONL (last custom-title + mtime). */
const TAIL_BYTES = 65536;

/** The retired `origin.ts#isSpawnedBy`. Copied rather than loosened to a string
 *  check: the old reader dropped a record whose `spawnedBy` was not one of these
 *  three, and a control that keeps it is answering a different question. */
function isSpawnedBy(value: unknown): value is OriginRecord["spawnedBy"] {
  return value === "user:web" || value === "user:terminal" || value === "agent";
}

/** The retired `origin.ts#readOriginForSessionId`: `existsSync` plus
 *  `readFileSync`, once per window row. */
function readOriginForSessionId(sessionId: string): OriginRecord | null {
  const path = originPathForSessionId(sessionId);
  if (!path || !existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<OriginRecord>;
    if (data.sessionId !== sessionId || !isSpawnedBy(data.spawnedBy)) return null;
    return {
      sessionId,
      spawnedBy: data.spawnedBy,
      parentSession: typeof data.parentSession === "string" ? data.parentSession : null,
      firstHandle: typeof data.firstHandle === "string" ? data.firstHandle : "",
      createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    };
  } catch {
    return null;
  }
}

// -- Claude JSONL parsing --

/** Parse the last custom-title from a chunk of JSONL text. */
function parseLastTitle(text: string): string | null {
  let title: string | null = null;
  for (const line of text.split("\n")) {
    if (!line || !line.includes("custom-title")) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "custom-title" && entry.customTitle) title = entry.customTitle;
    } catch { /* partial line at a read boundary — skip */ }
  }
  return title;
}

function parseEntryTimestamp(line: string): string | null {
  if (!line.includes('"timestamp"')) return null;
  try {
    const entry = JSON.parse(line);
    return typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp))
      ? entry.timestamp
      : null;
  } catch { return null; }
}

function parseFirstTimestamp(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line) continue;
    const ts = parseEntryTimestamp(line);
    if (ts) return ts;
  }
  return null;
}

function parseLastTimestamp(text: string): string | null {
  let ts: string | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    ts = parseEntryTimestamp(line) ?? ts;
  }
  return ts;
}

/** Parse the first meaningful user message from the head of a Claude JSONL file.
 *  Slash commands are restored to `/command args`; reminders and stdout are skipped. */
function parseFirstUserMessage(head: string): string | null {
  const texts: string[] = [];
  for (const line of head.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user" || !entry.message?.content) continue;
      texts.push(extractUserText(entry.message.content));
    } catch { continue; }
  }
  return firstMeaningfulMessage(texts);
}

// -- Token usage (last-turn "session size" signal) --

/** Last assistant turn's total tokens from a Claude JSONL slice: input plus the
 *  cache_creation/cache_read context (Claude reports cached tokens in separate
 *  fields disjoint from `input_tokens`, so all are summed) plus output. Scans
 *  backward for the last line carrying a usage record; a partial leading line
 *  from a tail read just fails to parse and is skipped. */
function parseLastClaudeTokens(text: string): number | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"usage"')) continue;
    try {
      const o = JSON.parse(line) as { message?: { usage?: Record<string, unknown> }; usage?: Record<string, unknown> };
      const u = o.message?.usage ?? o.usage;
      if (!u || typeof u["output_tokens"] !== "number") continue;
      const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
      const total =
        n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") + n("output_tokens");
      return total > 0 ? total : null;
    } catch { continue; }
  }
  return null;
}

/** Last turn's total tokens from a Codex rollout JSONL slice. Codex folds the
 *  cached context into `input_tokens` and reports `total_tokens` (= input +
 *  output) directly, so the provided value is used as-is. */
function parseLastCodexTokens(text: string): number | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes("last_token_usage")) continue;
    try {
      const o = JSON.parse(line) as { payload?: { info?: { last_token_usage?: { total_tokens?: unknown } } } };
      const t = o.payload?.info?.last_token_usage?.total_tokens;
      if (typeof t === "number") return t > 0 ? t : null;
    } catch { continue; }
  }
  return null;
}

/** Tail-read a Codex rollout file (path from the threads table) for its last
 *  token-usage record — a bounded read mirroring the Claude JSONL tail. */
async function codexRolloutTokens(rolloutPath: string | null): Promise<number | null> {
  if (!rolloutPath) return null;
  try {
    const st = await stat(rolloutPath);
    if (st.size === 0) return null;
    const readLen = Math.min(st.size, TAIL_BYTES);
    const fh = await open(rolloutPath, "r");
    try {
      const buf = Buffer.alloc(readLen);
      const res = await fh.read(buf, 0, readLen, st.size - readLen);
      return parseLastCodexTokens(buf.toString("utf-8", 0, res.bytesRead));
    } finally {
      await fh.close();
    }
  } catch { return null; }
}

// -- Claude provider history --

interface ClaudeIndexEntry {
  sessionId: string;
  summary?: string;
  gitBranch?: string;
  created?: string;
  modified?: string;
  isSidechain?: boolean;
}

function claudeProjectDir(projectPath: string): string {
  // Claude Code keys ~/.claude/projects/<encoded-cwd>/ with the same lossy
  // encoder used for project-move directory renames (non-alphanumerics → "-"),
  // so a path like `/repo/.worktrees/x` resolves to `-repo--worktrees-x`.
  return join(userHome(), ".claude", "projects", encodeClaudeCwd(projectPath));
}

/** Load sessions-index.json as optional per-session enrichment. */
async function loadClaudeIndex(projectDir: string): Promise<Map<string, ClaudeIndexEntry>> {
  const map = new Map<string, ClaudeIndexEntry>();
  let raw: string;
  try {
    raw = await readFile(join(projectDir, "sessions-index.json"), "utf-8");
  } catch { return map; }
  try {
    const data = JSON.parse(raw);
    const entries = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
    for (const entry of entries) {
      if (entry.sessionId) map.set(entry.sessionId, entry);
    }
  } catch { /* index is best-effort enrichment */ }
  return map;
}

/** Read Claude session history for a project: only the head (summary) and tail
 *  (title) of each JSONL is read so large logs stay cheap. */
async function claudeList(projectPath: string): Promise<HistorySession[]> {
  const projectDir = claudeProjectDir(projectPath);

  // Sorted: the row order a raw directory read produces is undefined, and it
  // survives into the output as the tie order of the newest-first history sort.
  let files: string[];
  try {
    files = (await readdir(projectDir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch { return []; }
  if (files.length === 0) return [];

  const index = await loadClaudeIndex(projectDir);

  const rows = await Promise.all(files.map(async (file): Promise<HistorySession | null> => {
    const sessionId = file.replace(/\.jsonl$/, "");
    const entry = index.get(sessionId);
    if (entry?.isSidechain) return null;

    const filePath = join(projectDir, file);
    let created: string;
    let modified: string;
    let size: number;
    try {
      const st = await stat(filePath);
      created = (st.birthtime ?? st.ctime).toISOString();
      modified = st.mtime.toISOString();
      size = st.size;
    } catch { return null; }

    let title: string | null = null;
    let summary: string | null = null;
    let createdFromLog: string | null = null;
    let modifiedFromLog: string | null = null;
    let tokens: number | null = null;
    try {
      const fh = await open(filePath, "r");
      try {
        const headBuf = Buffer.alloc(HEAD_BYTES);
        const headRes = await fh.read(headBuf, 0, Math.min(HEAD_BYTES, size), 0);
        const head = headBuf.toString("utf-8", 0, headRes.bytesRead);
        summary = parseFirstUserMessage(head);
        createdFromLog = parseFirstTimestamp(head);
        modifiedFromLog = parseLastTimestamp(head);

        // End slice: the last TAIL_BYTES (or the whole file when smaller) so the
        // last title / timestamp / usage record is always reachable.
        let endText = head;
        if (size > HEAD_BYTES) {
          const readLen = Math.min(size, TAIL_BYTES);
          const tailBuf = Buffer.alloc(readLen);
          const tailRes = await fh.read(tailBuf, 0, readLen, size - readLen);
          endText = tailBuf.toString("utf-8", 0, tailRes.bytesRead);
        }
        title = parseLastTitle(endText) ?? parseLastTitle(head);
        modifiedFromLog = parseLastTimestamp(endText) ?? modifiedFromLog;
        tokens = parseLastClaudeTokens(endText);
      } finally {
        await fh.close();
      }
    } catch { /* skip unreadable files */ }

    return {
      sessionId,
      provider: "claude",
      title,
      summary: entry?.summary || summary || "(no prompt)",
      created: entry?.created || createdFromLog || created,
      updatedAt: entry?.modified || modifiedFromLog || modified,
      tokens,
      gitBranch: entry?.gitBranch ?? null,
    };
  }));

  return rows.filter((r): r is HistorySession => r !== null);
}

/** The `ProviderHistory` factories the retired module exported. Kept because
 *  the timed route called `claudeHistory().list(path)`, and a control that skips
 *  two wrapper calls and two object constructions per invocation is not the
 *  route it claims to reproduce — however little that is worth in milliseconds,
 *  "verbatim" has to survive being checked. */
export function claudeHistory(): RetiredProviderHistory {
  return { list: (projectPath) => claudeList(projectPath) };
}

// -- Codex provider history --

interface CodexThreadRow {
  id: string;
  title: string | null;
  first_user_message: string | null;
  created_at: number;
  updated_at: number;
  git_branch: string | null;
  rollout_path: string | null;
}

/** Convert a Codex unix epoch (seconds or milliseconds) to ISO 8601. */
function epochToISO(epoch: number): string {
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  return new Date(ms).toISOString();
}

/** Last-entry-wins map of Codex thread id → user-assigned thread name. */
async function loadCodexThreadNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let content: string;
  try {
    content = await readFile(join(userHome(), ".codex", "session_index.jsonl"), "utf-8");
  } catch { return map; }
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id && entry.thread_name) map.set(entry.id, entry.thread_name);
    } catch { continue; }
  }
  return map;
}

/** Read Codex session history for a project from the threads table. */
async function codexList(projectPath: string): Promise<HistorySession[]> {
  const cwd = projectPath.replace(/\/+$/, "");
  if (!existsSync(codexDbPath())) return [];

  let rows: CodexThreadRow[];
  try {
    const db = new DatabaseSync(codexDbPath(), { readOnly: true });
    try {
      rows = db
        .prepare(
          // `id` breaks the updated_at tie: SQLite leaves the order of tied rows
          // to the query plan, so without it the row order is undefined.
          `SELECT id, title, first_user_message, created_at, updated_at, git_branch, rollout_path
           FROM threads WHERE cwd = ? AND archived = 0
           ORDER BY updated_at DESC, id ASC`,
        )
        // `node:sqlite` types every column as `SQLOutputValue`, so the row shape
        // is the SELECT's to declare — through `unknown`, because a 7-column row
        // and an open record do not overlap enough for a direct assertion.
        .all(cwd) as unknown as CodexThreadRow[];
    } finally {
      db.close();
    }
  } catch { return []; }
  if (rows.length === 0) return [];

  const threadNames = await loadCodexThreadNames();

  return Promise.all(rows.map(async (row) => ({
    sessionId: row.id,
    provider: "codex",
    title: threadNames.get(row.id) ?? null,
    summary: row.first_user_message || "(no prompt)",
    created: epochToISO(row.created_at),
    updatedAt: epochToISO(row.updated_at),
    tokens: await codexRolloutTokens(row.rollout_path),
    gitBranch: row.git_branch ?? null,
  })));
}

export function codexHistory(): RetiredProviderHistory {
  return { list: (projectPath) => codexList(projectPath) };
}

// -- Generic merge + live tagging --

/** Sort rank for an `updatedAt`: its epoch time, or −∞ when it does not parse so
 *  it ranks after every real timestamp. Never NaN — a NaN rank compares unequal
 *  to itself, which would make the history comparator intransitive and hand the
 *  order back to the sort's internals. */
function updatedAtRank(updatedAt: string): number {
  const t = new Date(updatedAt).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** Sort merged provider rows newest-first, cap them, and tag rows whose
 *  sessionId matches a live YACO session. Live tagging is provider-agnostic and
 *  keyed by YACO `sessionId`.
 *
 *  Rows sharing an `updatedAt` — routine once two providers' clocks are merged —
 *  are ordered by ascending `sessionId`. Without that the tie falls through to
 *  the merge order, which is a directory read, so the window boundary at `limit`
 *  could include a different row on each call. An `updatedAt` that does not parse
 *  ranks after every real timestamp rather than comparing as NaN, which would
 *  make the comparator intransitive and hand the order back to the sort's
 *  internals. */
export function retiredFinalizeHistory(
  rows: HistorySession[],
  liveSessions: readonly SessionState[],
  options: { limit?: number; since?: Date } = {},
): HistoryWindow {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  const cutoff = options.since?.getTime();
  const sorted = [...rows].sort((a, b) => {
    const at = updatedAtRank(a.updatedAt);
    const bt = updatedAtRank(b.updatedAt);
    if (at !== bt) return bt - at;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
  const matching = cutoff === undefined
    ? sorted
    : sorted.filter((row) => new Date(row.updatedAt).getTime() >= cutoff);
  const windowRows = matching.slice(0, limit);

  const liveBySessionId = new Map<string, SessionState>();
  for (const s of liveSessions) {
    if (s.sessionId && s.sessionId !== PENDING_SESSION_ID) liveBySessionId.set(s.sessionId, s);
  }

  const enriched = windowRows.map((row) => {
    const live = liveBySessionId.get(row.sessionId);
    const handle = live?.handle ?? null;
    const liveOrigin = live && !live.resumedFrom && live.spawnedBy
      ? { spawnedBy: live.spawnedBy, parentSession: live.parentSession ?? null }
      : null;
    const durableOrigin = liveOrigin ? null : readOriginForSessionId(row.sessionId);
    const origin = liveOrigin ?? durableOrigin;
    return {
      ...row,
      live: handle !== null,
      liveSessionName: handle,
      spawnedBy: origin?.spawnedBy ?? null,
      parentSession: origin?.parentSession ?? null,
    };
  });

  return {
    rows: enriched,
    returned: enriched.length,
    truncated: matching.length > limit,
    oldestUpdatedAt: enriched.at(-1)?.updatedAt ?? null,
  };
}
