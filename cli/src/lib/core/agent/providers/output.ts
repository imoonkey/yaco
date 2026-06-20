/** Provider output cursor resolution, line classification, and the shared
 *  output follower.
 *
 *  Claude and Codex persist a structured per-turn JSONL log. This module
 *  co-locates each provider's cursor resolution and line classification (the
 *  `ProviderOutput` capability, mirroring `claudeHistory()` / `codexHistory()`
 *  in `history.ts`) and the provider-agnostic `followOutput()` tailer that the
 *  `output-follow` CLI surface drives.
 *
 *  The follower owns `stat`, byte-range reads, partial-line buffering, and
 *  offset advancement; providers only resolve the cursor and classify complete
 *  lines. Keeping the log location and parsing here is what lets `app/server`
 *  consume `yaco agent output-cursor|output-follow` instead of opening
 *  `~/.claude` / `~/.codex` itself. */

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
    // The tail may begin mid-record. Drop the first (partial) line UNLESS `from`
    // already sits on a record boundary — i.e. the byte just before it is a
    // newline — so a final answer that starts exactly at the tail boundary is
    // not silently discarded.
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
  let last: string | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = classify(trimmed);
    if (event?.kind === "final") last = event.text;
  }
  return last;
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
          const files = await readdir(dayDir);
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

// -- Shared output follower --

/** Why a follow stream stopped. `timeout` is intentionally NOT a value here:
 *  it is never a provider classification event, and the defensive lifetime cap
 *  surfaces as `max-lifetime`, not `timeout`. */
export type FollowEndReason = "final" | "max-lifetime" | "error";

/** One NDJSON frame written by the follower. `nextOffset` is the absolute byte
 *  offset just past the last fully-consumed line, safe to pass back as the next
 *  `--offset` to resume without reprocessing. */
export type FollowFrame =
  | { type: "event"; event: AgentOutputEvent; nextOffset: number }
  | { type: "end"; reason: FollowEndReason; nextOffset: number };

export interface FollowParams {
  /** Resolved provider log path (the opaque cursor token). */
  sourcePath: string;
  /** Byte offset to begin reading from. */
  startOffset: number;
  /** Provider line classifier — at most one event per complete line. */
  classify: (line: string) => AgentOutputEvent | null;
  /** Sink for each NDJSON frame. */
  emit: (frame: FollowFrame) => void;
  /** Poll interval while the log is quiet (default 250ms). */
  pollMs?: number;
  /** Defensive cap to reap orphan tailers (default 30m). */
  maxLifetimeMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Cooperative cancel — caller termination flips `aborted`. */
  signal?: { aborted: boolean };
  /** Flush a complete-but-unterminated trailing record on the terminal `end`.
   *  Off for the streaming `output-follow` surface (a partial line may still be
   *  growing). On for the completion-wait drain, where a session that died after
   *  writing its final record but before the closing newline must still surface
   *  that final rather than read as "ended without a final". */
  flushPendingOnEnd?: boolean;
}

export const DEFAULT_POLL_MS = 250;
export const DEFAULT_MAX_LIFETIME_MS = 30 * 60_000;

const NEWLINE = 0x0a;

/** Read bytes `[from, to)` from a file as a Buffer; short reads (file shrank
 *  mid-read) return only the bytes actually read. */
async function readRange(path: string, from: number, to: number): Promise<Buffer> {
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

/** Tail a provider log from `startOffset`, classifying each complete line into
 *  `event` frames and ending with one `end` frame. Buffers partial lines across
 *  reads in byte space (a UTF-8 multibyte char never contains a newline byte),
 *  so `nextOffset` is always byte-accurate. Terminates on the first `final`
 *  event, on the defensive lifetime cap, on caller abort, or on a read error. */
export async function followOutput(p: FollowParams): Promise<void> {
  const pollMs = p.pollMs ?? DEFAULT_POLL_MS;
  const maxLifetimeMs = p.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
  const now = p.now ?? (() => Date.now());
  const sleep = p.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();

  // Defensive: a non-finite or negative startOffset would corrupt nextOffset
  // accounting. Callers validate `--offset` before this point, but clamp here
  // so the follower can never emit nextOffset:null.
  let readPos =
    Number.isFinite(p.startOffset) && p.startOffset > 0 ? Math.floor(p.startOffset) : 0;
  let lineOffset = readPos; // byte offset just past the last consumed line
  let pending: Buffer = Buffer.alloc(0); // unconsumed bytes of the current partial line

  const end = (reason: FollowEndReason) => {
    // A complete record written without its closing newline (e.g. a final the
    // session flushed just before dying) is still sitting in `pending`, never
    // classified by the newline loop. On an opt-in terminal end, classify it
    // once. An incomplete record parses to null, so this is safe even mid-write.
    if (p.flushPendingOnEnd && pending.length > 0) {
      const line = pending.toString("utf-8").replace(/\r$/, "").trim();
      if (line) {
        const event = p.classify(line);
        if (event) p.emit({ type: "event", event, nextOffset: lineOffset + pending.length });
      }
    }
    p.emit({ type: "end", reason, nextOffset: lineOffset });
  };

  while (true) {
    if (p.signal?.aborted) return end("max-lifetime");
    if (now() - start >= maxLifetimeMs) return end("max-lifetime");

    let size: number;
    try {
      size = (await stat(p.sourcePath)).size;
    } catch {
      return end("error");
    }

    if (size < readPos) {
      // File truncated/rotated under us — restart from the new head.
      readPos = 0;
      lineOffset = 0;
      pending = Buffer.alloc(0);
    }
    if (size <= readPos) {
      await sleep(pollMs);
      continue;
    }

    let chunk: Buffer;
    try {
      chunk = await readRange(p.sourcePath, readPos, size);
    } catch {
      // open/read can fail after a successful stat (rotation, permissions).
      // Surface it as an end frame, never as a bubbled exception that would
      // corrupt the NDJSON stream once frames have started.
      return end("error");
    }
    readPos += chunk.length;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

    let nl: number;
    while ((nl = pending.indexOf(NEWLINE)) >= 0) {
      const lineBuf = pending.subarray(0, nl);
      lineOffset += nl + 1; // line bytes + the newline
      pending = pending.subarray(nl + 1);
      const line = lineBuf.toString("utf-8").replace(/\r$/, "").trim();
      if (!line) continue;
      // At most one event per complete line keeps nextOffset unambiguous.
      const event = p.classify(line);
      if (!event) continue;
      p.emit({ type: "event", event, nextOffset: lineOffset });
      if (event.kind === "final") return end("final");
    }
  }
}
