/** Provider history & summary reconstruction.
 *
 *  Claude and Codex rebuild project session history and per-session summary
 *  labels from their own persisted files and databases. This module co-locates
 *  the shared JSONL/SQLite parsing and exposes one `ProviderHistory` per
 *  provider, mirroring the `claudeHooks()` / `codexHooks()` factory pattern in
 *  `hooks.ts`. Keeping provider-home reads here is what lets `app/server`
 *  consume `yaco agent history|summaries --json` instead of parsing
 *  `~/.claude` and `~/.codex` directly. */

import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { encodeClaudeCwd } from "../../project/encode.ts";
import { readOriginForSessionId } from "../origin.ts";
import { PENDING_SESSION_ID, type SessionState } from "../model.ts";
import type { HistorySession, HistoryWindow, ProviderHistory, SummaryResult } from "./types.ts";

/** Default history row limit after filtering the merged provider rows. */
export const DEFAULT_HISTORY_LIMIT = 200;
/** Bytes read from the head of each Claude JSONL (first user message + start). */
const HEAD_BYTES = 16384;
/** Bytes read from the tail of each Claude JSONL (last custom-title + mtime). */
const TAIL_BYTES = 65536;

/** Honor $HOME at call time so provider paths track test home overrides. */
function userHome(): string {
  const env = process.env["HOME"];
  return env && env.length > 0 ? env : homedir();
}

// -- Shared message-text helpers --

/** Flatten a JSONL user message `content` field to plain text. */
function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b: { text?: string }) => b.text ?? "").join(" ");
  }
  return "";
}

/** Extract `<command-args>` content from a `<command-message>` wrapper. */
function extractCommandArgs(text: string): string | null {
  const match = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = match?.[1]?.trim();
  return args ? args : null;
}

/** Extract the command name (e.g. "/design") from a `<command-message>` wrapper. */
function extractCommandName(text: string): string | null {
  const match = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  return match ? match[1]!.trim() || null : null;
}

/** Harness-injected blocks that carry no user intent. */
const NOISE_BLOCKS =
  /<system-reminder>[\s\S]*?<\/system-reminder>|<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi;
/** Slash-command wrapper tags; stripped so only the human-facing args/prose remain. */
const COMMAND_BLOCKS = /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/gi;
/** Session-management commands that carry no task intent — skipped so the real
 *  prompt surfaces instead. */
const META_COMMANDS = new Set(["/rename", "/clear", "/compact"]);

/** Collapse one user message to its display intent, or "" if it is pure noise.
 *  Reminders and command stdout are dropped. Prose typed alongside a command
 *  wins; a slash command is restored to its original `/name args` input; a
 *  session-management command (e.g. `/rename`) collapses to "". */
function collapseUserMessage(raw: string): string {
  const stripped = raw.replace(NOISE_BLOCKS, "");
  const prose = stripped.replace(COMMAND_BLOCKS, "").replace(/\s+/g, " ").trim();
  if (prose) return prose;
  const name = extractCommandName(stripped);
  if (!name) return "";
  if (META_COMMANDS.has(name)) return "";
  const args = extractCommandArgs(stripped);
  return (args ? `${name} ${args}` : name).replace(/\s+/g, " ").trim();
}

/** First user message that carries real intent, collapsed for display. Skips
 *  noise (reminders, stdout, session-management commands) and, when a handle is
 *  given, messages that merely echo it (e.g. an auto-assigned title). */
function firstMeaningfulMessage(rawTexts: Iterable<string>, handle?: string): string | null {
  for (const raw of rawTexts) {
    const label = collapseUserMessage(raw);
    if (!label) continue;
    if (handle && handle.startsWith(label)) continue;
    return label;
  }
  return null;
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

  let files: string[];
  try {
    files = (await readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
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

/** Resolve a Claude session's label from the first meaningful user message in
 *  its project JSONL, skipping reminders, command stdout, and `/rename` echoes. */
async function claudeSummarize(session: SessionState): Promise<SummaryResult | null> {
  if (!session.sessionPath) return null;
  const jsonlPath = join(claudeProjectDir(session.sessionPath), `${session.sessionId}.jsonl`);

  let content: string;
  try {
    content = await readFile(jsonlPath, "utf-8");
  } catch { return null; }

  const texts: string[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user" && entry.message?.content) {
        texts.push(extractUserText(entry.message.content));
      }
    } catch { continue; }
  }

  const label = firstMeaningfulMessage(texts, session.handle);
  return label ? { sessionId: session.sessionId, label } : null;
}

export function claudeHistory(): ProviderHistory {
  return { list: (projectPath) => claudeList(projectPath), summarize: claudeSummarize };
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

function codexDbPath(): string {
  return join(userHome(), ".codex", "state_5.sqlite");
}

function codexSessionsDir(): string {
  return join(userHome(), ".codex", "sessions");
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
    const db = new Database(codexDbPath(), { readonly: true });
    try {
      rows = db
        .query<CodexThreadRow, [string]>(
          `SELECT id, title, first_user_message, created_at, updated_at, git_branch, rollout_path
           FROM threads WHERE cwd = ? AND archived = 0
           ORDER BY updated_at DESC`,
        )
        .all(cwd);
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

/** Find a Codex session's rollout JSONL (today and 7 days back) and return the
 *  first real user message, skipping system/AGENTS.md context blocks. */
async function codexRolloutSummary(sessionId: string, handle?: string): Promise<string | null> {
  const now = new Date();
  for (let daysBack = 0; daysBack <= 7; daysBack++) {
    const d = new Date(now.getTime() - daysBack * 86400000);
    const dayDir = join(
      codexSessionsDir(),
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );

    let files: string[];
    try {
      files = await readdir(dayDir);
    } catch { continue; }

    const match = files.find((f) => f.includes(sessionId) && f.endsWith(".jsonl"));
    if (!match) continue;

    let content: string;
    try {
      content = await readFile(join(dayDir, match), "utf-8");
    } catch { continue; }

    const texts: string[] = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "response_item" || entry.payload?.role !== "user") continue;
        for (const block of entry.payload.content ?? []) {
          if (
            block.type === "input_text" && block.text &&
            !block.text.startsWith("#") && !block.text.startsWith("<")
          ) {
            texts.push(block.text);
          }
        }
      } catch { continue; }
    }
    const label = firstMeaningfulMessage(texts, handle);
    if (label) return label;
  }
  return null;
}

/** Resolve a Codex session's label. Codex auto-renames the thread `title` to the
 *  YACO handle on start, so the real signal is `first_user_message`; the rollout
 *  file is the fallback, and `title` only when it is not a handle echo. */
async function codexSummarize(session: SessionState): Promise<SummaryResult | null> {
  const sessionId = session.sessionId;
  const handle = session.handle;

  let title: string | null = null;
  if (existsSync(codexDbPath())) {
    try {
      const db = new Database(codexDbPath(), { readonly: true });
      try {
        const row = db
          .query<{ title: string | null; first_user_message: string | null }, [string]>(
            "SELECT title, first_user_message FROM threads WHERE id = ?",
          )
          .get(sessionId);
        title = row?.title ?? null;
        const first = firstMeaningfulMessage([row?.first_user_message ?? ""], handle);
        if (first) return { sessionId, label: first };
      } finally {
        db.close();
      }
    } catch { /* fall back to rollout scan */ }
  }

  const rollout = await codexRolloutSummary(sessionId, handle);
  if (rollout) return { sessionId, label: rollout };

  const titleLabel = firstMeaningfulMessage([title ?? ""], handle);
  return titleLabel ? { sessionId, label: titleLabel } : null;
}

export function codexHistory(): ProviderHistory {
  return { list: (projectPath) => codexList(projectPath), summarize: codexSummarize };
}

// -- Generic merge + live tagging --

/** Sort merged provider rows newest-first, cap them, and tag rows whose
 *  sessionId matches a live YACO session. Live tagging is provider-agnostic and
 *  keyed by YACO `sessionId`. */
export function finalizeHistory(
  rows: HistorySession[],
  liveSessions: readonly SessionState[],
  options: { limit?: number; since?: Date } = {},
): HistoryWindow {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  const cutoff = options.since?.getTime();
  const sorted = [...rows].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
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
