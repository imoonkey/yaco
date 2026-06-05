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
import { PENDING_SESSION_ID, type SessionState } from "../model.ts";
import type { HistorySession, ProviderHistory, SummaryResult } from "./types.ts";

/** History row cap after merging every provider. */
const HISTORY_CAP = 200;
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

function isCommandMessage(text: string): boolean {
  return text.includes("<command-message>");
}

/** Extract `<command-args>` content from a `<command-message>` wrapper. */
function extractCommandArgs(text: string): string | null {
  if (!isCommandMessage(text)) return null;
  const match = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = match?.[1]?.trim();
  return args ? args : null;
}

/** Extract the command name (e.g. "/design") from a `<command-message>` wrapper. */
function extractCommandName(text: string): string | null {
  const match = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  return match ? match[1]!.trim() || null : null;
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

/** Parse the first user message from the head of a Claude JSONL file. Slash
 *  commands collapse to their args, falling back to the command name. */
function parseFirstUserMessage(head: string): string | null {
  let commandName: string | null = null;
  for (const line of head.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user" || !entry.message?.content) continue;
      const raw = extractUserText(entry.message.content).replace(/\s+/g, " ").trim();
      if (!raw) continue;
      if (isCommandMessage(raw)) {
        const args = extractCommandArgs(raw);
        if (args) return args.replace(/\s+/g, " ").trim();
        if (!commandName) commandName = extractCommandName(raw);
      } else {
        return raw;
      }
    } catch { continue; }
  }
  return commandName;
}

// -- Claude provider history --

interface ClaudeIndexEntry {
  sessionId: string;
  summary?: string;
  messageCount?: number;
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
    try {
      const fh = await open(filePath, "r");
      try {
        const headBuf = Buffer.alloc(HEAD_BYTES);
        const headRes = await fh.read(headBuf, 0, Math.min(HEAD_BYTES, size), 0);
        const head = headBuf.toString("utf-8", 0, headRes.bytesRead);
        summary = parseFirstUserMessage(head);
        createdFromLog = parseFirstTimestamp(head);
        modifiedFromLog = parseLastTimestamp(head);

        if (size > TAIL_BYTES) {
          const tailBuf = Buffer.alloc(TAIL_BYTES);
          const tailRes = await fh.read(tailBuf, 0, TAIL_BYTES, size - TAIL_BYTES);
          const tail = tailBuf.toString("utf-8", 0, tailRes.bytesRead);
          title = parseLastTitle(tail);
          modifiedFromLog = parseLastTimestamp(tail) ?? modifiedFromLog;
        }
        if (!title) title = parseLastTitle(head);
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
      messageCount: entry?.messageCount ?? null,
      gitBranch: entry?.gitBranch ?? null,
    };
  }));

  return rows.filter((r): r is HistorySession => r !== null);
}

/** Resolve a Claude session's label from the first real user message in its
 *  project JSONL. Unlike history, the raw message is used verbatim. */
async function claudeSummarize(session: SessionState): Promise<SummaryResult | null> {
  if (!session.sessionPath) return null;
  const jsonlPath = join(claudeProjectDir(session.sessionPath), `${session.sessionId}.jsonl`);

  let content: string;
  try {
    content = await readFile(jsonlPath, "utf-8");
  } catch { return null; }

  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user" && entry.message?.content) {
        const label = extractUserText(entry.message.content).replace(/\s+/g, " ").trim();
        if (label) return { sessionId: session.sessionId, label };
      }
    } catch { continue; }
  }
  return null;
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
          `SELECT id, title, first_user_message, created_at, updated_at, git_branch
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

  return rows.map((row) => ({
    sessionId: row.id,
    provider: "codex",
    title: threadNames.get(row.id) ?? null,
    summary: row.first_user_message || "(no prompt)",
    created: epochToISO(row.created_at),
    updatedAt: epochToISO(row.updated_at),
    messageCount: null,
    gitBranch: row.git_branch ?? null,
  }));
}

/** Find a Codex session's rollout JSONL (today and 7 days back) and return the
 *  last real user message, skipping system/AGENTS.md context blocks. */
async function codexRolloutSummary(sessionId: string): Promise<string | null> {
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

    let lastUserText = "";
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
            lastUserText = block.text;
          }
        }
      } catch { continue; }
    }
    if (lastUserText) return lastUserText.replace(/\s+/g, " ").trim();
  }
  return null;
}

/** Resolve a Codex session's label: threads table title/first message, then a
 *  rollout-file fallback. */
async function codexSummarize(session: SessionState): Promise<SummaryResult | null> {
  const sessionId = session.sessionId;

  if (existsSync(codexDbPath())) {
    try {
      const db = new Database(codexDbPath(), { readonly: true });
      try {
        const row = db
          .query<{ title: string | null; first_user_message: string | null }, [string]>(
            "SELECT title, first_user_message FROM threads WHERE id = ?",
          )
          .get(sessionId);
        const label = row?.title || row?.first_user_message || "";
        if (label) return { sessionId, label };
      } finally {
        db.close();
      }
    } catch { /* fall back to rollout scan */ }
  }

  const label = await codexRolloutSummary(sessionId);
  return label ? { sessionId, label } : null;
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
): HistorySession[] {
  const sorted = [...rows].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const capped = sorted.slice(0, HISTORY_CAP);

  const liveBySessionId = new Map<string, string>();
  for (const s of liveSessions) {
    if (s.sessionId && s.sessionId !== PENDING_SESSION_ID) liveBySessionId.set(s.sessionId, s.handle);
  }

  return capped.map((row) => {
    const handle = liveBySessionId.get(row.sessionId) ?? null;
    return { ...row, live: handle !== null, liveSessionName: handle };
  });
}
