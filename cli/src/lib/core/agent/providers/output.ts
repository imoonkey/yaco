/** Provider output cursor resolution and line classification.
 *
 *  Claude and Codex persist a structured per-turn JSONL log. This module
 *  co-locates each provider's log location, cursor resolution and line
 *  classification (the `ProviderOutput` capability, mirroring `claudeHistory()`
 *  / `codexHistory()` in `history.ts`), so one place knows where a provider
 *  writes and how to read a line of it.
 *
 *  It is the read half only: the polling tailer that drives `output-follow`
 *  lives in `follow.ts`, because a polling loop is banned from every closure
 *  `package.json#exports` publishes and this module is reached from the
 *  exported message read (`message-read.ts`). -> See:
 *  `doc/main/cli/exports.md`. */

import { open, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeClaudeCwd } from "../../project/encode.ts";
import { PENDING_SESSION_ID, type SessionState } from "../model.ts";
import type { AgentOutputEvent, OutputCursor, ProviderOutput } from "./types.ts";

/** Honor $HOME at call time so provider paths track test home overrides. */
function userHome(): string {
  const env = process.env["HOME"];
  return env && env.length > 0 ? env : homedir();
}

function hasResolvedId(session: SessionState): boolean {
  return Boolean(session.sessionId) && session.sessionId !== PENDING_SESSION_ID;
}

// -- Opaque cursor token --
//
// The token round-trips through app/server, which must treat it as opaque and
// never derive a path from it. Only CLI/provider code encodes/decodes it. A
// token binds {provider, sessionId, path}; `output-follow` re-resolves the read
// path from the session's own provider and validates the token's
// provider+sessionId, so a caller can never aim the follower at an arbitrary
// file via `--cursor`.

const CURSOR_TOKEN_PREFIX = "oc1_";

export interface CursorTokenData {
  provider: string;
  sessionId: string;
  path: string;
}

export function encodeCursorToken(data: CursorTokenData): string {
  const json = JSON.stringify({ provider: data.provider, sessionId: data.sessionId, path: data.path });
  return CURSOR_TOKEN_PREFIX + Buffer.from(json, "utf-8").toString("base64url");
}

export function decodeCursorToken(token: string): CursorTokenData | null {
  if (!token.startsWith(CURSOR_TOKEN_PREFIX)) return null;
  try {
    const json = Buffer.from(token.slice(CURSOR_TOKEN_PREFIX.length), "base64url").toString("utf-8");
    const data = JSON.parse(json) as Partial<CursorTokenData>;
    if (
      typeof data?.provider === "string" &&
      typeof data.sessionId === "string" &&
      typeof data.path === "string"
    ) {
      return { provider: data.provider, sessionId: data.sessionId, path: data.path };
    }
  } catch {
    /* malformed token */
  }
  return null;
}

/** Stat a resolved log path into an opaque cursor bound to its session. */
async function cursorForPath(
  provider: string,
  sessionId: string,
  path: string,
): Promise<OutputCursor | null> {
  try {
    const st = await stat(path);
    return {
      token: encodeCursorToken({ provider, sessionId, path }),
      offset: st.size,
      sourceMtimeMs: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

// -- Claude output --

function claudeLogPath(session: SessionState): string {
  return join(
    userHome(),
    ".claude",
    "projects",
    encodeClaudeCwd(session.sessionPath),
    `${session.sessionId}.jsonl`,
  );
}

interface ClaudeMessage {
  stop_reason?: string;
  content?: unknown;
}

interface ClaudeBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: { questions?: ClaudeQuestion[] };
}

interface ClaudeQuestion {
  question?: string;
  header?: string;
  options?: { label?: string; description?: string }[];
}

/** Render an AskUserQuestion tool input as the `question` event text. */
function formatQuestion(questions: ClaudeQuestion[]): string {
  const blocks = questions.map((q) => {
    const head = q.question?.trim() || q.header?.trim() || "(no question text)";
    const opts = (q.options ?? [])
      .map((o, i) => {
        const label = o.label?.trim() || `option ${i + 1}`;
        const desc = o.description?.trim();
        return desc ? `${i + 1}) ${label} — ${desc}` : `${i + 1}) ${label}`;
      })
      .join("\n");
    return opts ? `🤔 Agent asks: ${head}\n\n${opts}` : `🤔 Agent asks: ${head}`;
  });
  return blocks.join("\n\n");
}

function classifyClaude(line: string): AgentOutputEvent | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const e = entry as { type?: string; message?: ClaudeMessage };
  if (e.type !== "assistant") return null;
  const msg = e.message;
  if (!msg || !Array.isArray(msg.content)) return null;
  const blocks = msg.content as ClaudeBlock[];

  const textParts: string[] = [];
  const questions: ClaudeQuestion[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    } else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
      const qs = b.input?.questions;
      if (Array.isArray(qs)) questions.push(...qs);
    }
    // skip thinking, other tool_use, tool_result
  }

  const text = textParts.join("\n").trim();
  if (questions.length > 0) {
    // One event per complete line: fold any preceding text into the question.
    const q = formatQuestion(questions);
    return { kind: "question", text: text ? `${text}\n\n${q}` : q };
  }

  if (!text) return null;
  return msg.stop_reason === "end_turn" ? { kind: "final", text } : { kind: "interim", text };
}

export function claudeOutput(): ProviderOutput {
  return {
    async resolveCursor(session) {
      if (!hasResolvedId(session)) return null;
      return cursorForPath("claude", session.sessionId, claudeLogPath(session));
    },
    async logExists(session) {
      // Existence at the session's current log path is the signal — the
      // resolved-id guard that resolveCursor applies is intentionally skipped,
      // so a pending session that already wrote a log is still detected.
      return existsSync(claudeLogPath(session));
    },
    classifyLine: classifyClaude,
  };
}

export interface TranscriptTurnState {
  status: "idle" | "processing";
  idleReason?: "interrupted";
}

async function tailLines(path: string, tailBytes = 256 * 1024): Promise<string[] | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }

  const from = size > tailBytes ? size - tailBytes : 0;
  let text: string;
  try {
    text = (await readRange(path, from, size)).toString("utf-8");
  } catch {
    return null;
  }

  if (from > 0) {
    let boundaryClean = false;
    try {
      boundaryClean = (await readRange(path, from - 1, from))[0] === NEWLINE;
    } catch {
      /* unreadable preceding byte — treat as mid-record */
    }
    if (!boundaryClean) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
  }

  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Read the tail of a provider transcript and return the text of its LAST `final`
 *  event, or null when there is none / the file is unreadable. Used by the hook
 *  handler to fill the idle ("Your turn") notice from the agent's closing
 *  message. Reads only the trailing `tailBytes` (a final answer sits at the end
 *  of the turn), dropping a possibly-partial first line so a mid-record cut never
 *  misclassifies. Provider-agnostic: the caller passes the line classifier (e.g.
 *  `claudeOutput().classifyLine`); NO directory walk — the path is the Stop
 *  hook's own `transcript_path`. */
export async function lastFinalFromTranscript(
  path: string,
  classify: (line: string) => AgentOutputEvent | null,
  tailBytes = 256 * 1024,
): Promise<string | null> {
  const lines = await tailLines(path, tailBytes);
  if (!lines) return null;
  let last: string | null = null;
  for (const line of lines) {
    const event = classify(line);
    if (event?.kind === "final") last = event.text;
  }
  return last;
}

function claudeUserInterrupt(content: unknown): boolean {
  if (typeof content === "string") return content.startsWith("[Request interrupted by user");
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const b = block as { type?: unknown; text?: unknown };
    return b.type === "text" && typeof b.text === "string" && b.text.startsWith("[Request interrupted by user");
  });
}

function parseClaudeTurnLine(line: string): TranscriptTurnState | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const e = entry as {
    type?: unknown;
    isSidechain?: unknown;
    isMeta?: unknown;
    message?: { stop_reason?: unknown; content?: unknown };
  };
  if (e.isSidechain === true || e.isMeta === true) return null;
  if (e.type === "assistant") {
    if (e.message?.stop_reason === "end_turn") return { status: "idle" };
    if (e.message?.stop_reason === "tool_use") return { status: "processing" };
    return null;
  }
  if (e.type === "user") {
    return claudeUserInterrupt(e.message?.content)
      ? { status: "idle", idleReason: "interrupted" }
      : { status: "processing" };
  }
  return null;
}

async function claudeTurnStateFromTranscript(session: SessionState): Promise<TranscriptTurnState | null> {
  const lines = await tailLines(claudeLogPath(session));
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const state = parseClaudeTurnLine(lines[i]!);
    if (state) return state;
  }
  return null;
}

// -- Codex output --

function codexSessionsRoot(): string {
  return join(userHome(), ".codex", "sessions");
}

/** Walk ~/.codex/sessions/YYYY/MM/DD newest-first for the rollout file whose
 *  name embeds this session id. */
async function codexLogPath(sessionId: string): Promise<string | null> {
  const root = codexSessionsRoot();
  if (!existsSync(root)) return null;
  try {
    const years = (await readdir(root)).filter((s) => /^\d{4}$/.test(s)).sort().reverse();
    for (const year of years) {
      const yearDir = join(root, year);
      const months = (await readdir(yearDir)).filter((s) => /^\d{2}$/.test(s)).sort().reverse();
      for (const month of months) {
        const monthDir = join(yearDir, month);
        const days = (await readdir(monthDir)).filter((s) => /^\d{2}$/.test(s)).sort().reverse();
        for (const day of days) {
          const dayDir = join(monthDir, day);
          // Sorted like the year/month/day walk above, so "the first file naming
          // this session" is a defined choice when a day holds more than one.
          const files = (await readdir(dayDir)).sort();
          const hit = files.find((f) => f.includes(sessionId) && f.endsWith(".jsonl"));
          if (hit) return join(dayDir, hit);
        }
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

function classifyCodex(line: string): AgentOutputEvent | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const e = entry as { type?: string; payload?: { type?: string; phase?: string; message?: unknown } };
  if (e.type !== "event_msg") return null;
  const p = e.payload;
  if (p?.type !== "agent_message" || typeof p.message !== "string") return null;
  const text = p.message.trim();
  if (!text) return null;
  if (p.phase === "final_answer") return { kind: "final", text };
  if (p.phase === "commentary") return { kind: "interim", text };
  return null;
}

export function codexOutput(): ProviderOutput {
  return {
    async resolveCursor(session) {
      if (!hasResolvedId(session)) return null;
      const path = await codexLogPath(session.sessionId);
      return path ? cursorForPath("codex", session.sessionId, path) : null;
    },
    async logExists(session) {
      // A rollout file is only created once the first prompt is sent; a pending
      // (awaiting-first-prompt) session genuinely has none yet.
      if (!session.sessionId || session.sessionId === PENDING_SESSION_ID) return false;
      return (await codexLogPath(session.sessionId)) !== null;
    },
    classifyLine: classifyCodex,
  };
}

// -- Message-log path resolution (shared with `yaco agent messages`) --

/** Resolve the Claude message-log path for a session, or null until its id
 *  resolves. The same file the output cursor reads — exposed so the message
 *  inventory reader reuses one provider-path source and the pending guard. */
export function resolveClaudeLogPath(session: SessionState): string | null {
  return hasResolvedId(session) ? claudeLogPath(session) : null;
}

/** Resolve the Codex rollout path for a session, or null until its id resolves
 *  and a rollout file exists. */
export async function resolveCodexLogPath(session: SessionState): Promise<string | null> {
  return hasResolvedId(session) ? codexLogPath(session.sessionId) : null;
}

function parseCodexTurnLine(line: string): TranscriptTurnState | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const e = entry as { type?: unknown; payload?: { type?: unknown; reason?: unknown } };
  if (e.type !== "event_msg") return null;
  if (e.payload?.type === "turn_aborted") {
    return e.payload.reason === "interrupted"
      ? { status: "idle", idleReason: "interrupted" }
      : { status: "idle" };
  }
  if (e.payload?.type === "task_complete") return { status: "idle" };
  if (e.payload?.type === "task_started") return { status: "processing" };
  return null;
}

async function codexTurnStateFromTranscript(session: SessionState): Promise<TranscriptTurnState | null> {
  const path = await resolveCodexLogPath(session);
  if (!path) return null;
  const lines = await tailLines(path);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const state = parseCodexTurnLine(lines[i]!);
    if (state) return state;
  }
  return null;
}

export async function turnStateFromTranscript(session: SessionState): Promise<TranscriptTurnState | null> {
  if (!hasResolvedId(session)) return null;
  if (session.provider === "claude") return claudeTurnStateFromTranscript(session);
  if (session.provider === "codex") return codexTurnStateFromTranscript(session);
  return null;
}

// -- Byte-range reads (shared with the follower in follow.ts) --

export const NEWLINE = 0x0a;

/** Read bytes `[from, to)` from a file as a Buffer; short reads (file shrank
 *  mid-read) return only the bytes actually read. */
export async function readRange(path: string, from: number, to: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const len = to - from;
    const buf = Buffer.alloc(len);
    const res = await fh.read(buf, 0, len, from);
    return res.bytesRead === len ? buf : buf.subarray(0, res.bytesRead);
  } finally {
    await fh.close();
  }
}
