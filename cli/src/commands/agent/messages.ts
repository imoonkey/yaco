/** `yaco agent messages <name>` — structured navigation of a session's full
 *  message history, read from the provider's JSONL log (never PTY capture).
 *
 *  Two modes: `--meta` (default) lists token-cheap rows `{index, role, types,
 *  chars}` with optional `--preview`/`--ts`; `--index <i>` returns one full
 *  message. Indices are stable absolute ordinals in the kept-row sequence;
 *  filters (`--role`/`--type`/`--range`) change which rows are shown, never an
 *  index. Text rendering is compact (single-letter role, human-readable chars,
 *  first-absolute-then-relative timestamps) while `--json` stays exact. */

import { readFile } from "node:fs/promises";
import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { getProvider, hasProvider } from "../../lib/core/agent/providers/index.ts";
import { validateName, type SessionState } from "../../lib/core/agent/model.ts";
import { readState } from "../../lib/core/agent/session-state.ts";
import type {
  MessageFull,
  MessageMeta,
  MessageRole,
  ParsedMessage,
  ProviderMessages,
} from "../../lib/core/agent/providers/types.ts";

export const MESSAGES_USAGE =
  "yaco agent messages <name> [--meta] [--role user|assistant] [--type <t>] " +
  "[--range a..b] [--preview[=N]] [--ts] [--json]\n" +
  "  or: yaco agent messages <name> --index <i>   (i may be negative; -1 = last)";

const PREVIEW_DEFAULT = 100;
const PREVIEW_MAX = 1000;

export interface MessagesRange {
  from: number | null;
  to: number | null;
}

export type MessagesMode =
  | { kind: "meta"; role?: MessageRole; type?: string; range?: MessagesRange; preview?: number; ts: boolean }
  | { kind: "index"; index: number };

export interface MessagesArgs {
  handle: string;
  mode: MessagesMode;
}

function usage(detail: string): CliError {
  return new CliError(ErrCode.USAGE, `${MESSAGES_USAGE} (${detail})`);
}

/** A value that must be present and not flag-like (role/type/preview). */
function requireValue(label: string, v: string | undefined): string {
  if (v === undefined || v === "" || v.startsWith("-")) throw usage(`${label} requires a value`);
  return v;
}

/** `--index <i>` / `--range a..b` values legitimately start with `-`, so these
 *  consume the next token unconditionally and validate by shape. */
function parseIndexValue(v: string | undefined): number {
  if (v === undefined || !/^-?\d+$/.test(v)) throw usage(`--index requires an integer (got: ${v ?? "<missing>"})`);
  const n = Number.parseInt(v, 10);
  if (!Number.isSafeInteger(n)) throw usage(`--index out of range: ${v}`);
  return n;
}

function parseRangeValue(v: string | undefined): MessagesRange {
  if (v === undefined || !/^(-?\d+)?\.\.(-?\d+)?$/.test(v)) {
    throw usage(`--range must be a..b (got: ${v ?? "<missing>"})`);
  }
  const [a, b] = v.split("..");
  return { from: a ? Number.parseInt(a, 10) : null, to: b ? Number.parseInt(b, 10) : null };
}

function parseRoleValue(v: string): MessageRole {
  if (v !== "user" && v !== "assistant") throw usage(`--role must be user|assistant (got: ${v})`);
  return v;
}

function parsePreviewValue(v: string): number {
  if (!/^\d+$/.test(v)) throw usage(`--preview must be a positive integer`);
  const n = Number.parseInt(v, 10);
  if (n < 1 || n > PREVIEW_MAX) throw usage(`--preview must be in 1..${PREVIEW_MAX}`);
  return n;
}

/** Strict allowlist parser. Exactly one handle plus only the documented flags;
 *  any other flag-like token or extra positional is USAGE. */
export function parseMessagesArgs(args: string[]): MessagesArgs {
  let handle: string | undefined;
  let metaSeen = false;
  let index: number | undefined;
  let role: MessageRole | undefined;
  let type: string | undefined;
  let range: MessagesRange | undefined;
  let preview: number | undefined;
  let ts = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") continue; // envelope mode is the dispatcher's concern
    if (arg === "--meta") { metaSeen = true; continue; }
    if (arg === "--ts") { ts = true; continue; }
    if (arg === "--index") { index = parseIndexValue(args[++i]); continue; }
    if (arg.startsWith("--index=")) { index = parseIndexValue(arg.slice("--index=".length)); continue; }
    if (arg === "--range") { range = parseRangeValue(args[++i]); continue; }
    if (arg.startsWith("--range=")) { range = parseRangeValue(arg.slice("--range=".length)); continue; }
    if (arg === "--role") { role = parseRoleValue(requireValue("--role", args[++i])); continue; }
    if (arg.startsWith("--role=")) { role = parseRoleValue(requireValue("--role", arg.slice("--role=".length))); continue; }
    if (arg === "--type") { type = requireValue("--type", args[++i]); continue; }
    if (arg.startsWith("--type=")) { type = requireValue("--type", arg.slice("--type=".length)); continue; }
    if (arg === "--preview") { preview = PREVIEW_DEFAULT; continue; }
    if (arg.startsWith("--preview=")) { preview = parsePreviewValue(arg.slice("--preview=".length)); continue; }
    if (arg.startsWith("-")) throw usage(`unknown flag: ${arg}`);
    if (handle === undefined) { handle = arg; continue; }
    throw usage(`unexpected argument: ${arg}`);
  }

  if (handle === undefined) throw new CliError(ErrCode.USAGE, MESSAGES_USAGE);

  if (index !== undefined) {
    if (metaSeen || role !== undefined || type !== undefined || range !== undefined || preview !== undefined || ts) {
      throw usage("--index cannot be combined with meta filters");
    }
    return { handle, mode: { kind: "index", index } };
  }
  return { handle, mode: { kind: "meta", role, type, range, preview, ts } };
}

/** Resolve a live session's message-capable provider, mirroring resolveOutput.
 *  validateName runs first (typed USAGE) so a traversal handle never reaches
 *  readState. */
export function resolveMessages(handle: string): { state: SessionState; messages: ProviderMessages } {
  validateName(handle);
  const state = readState(handle);
  if (!state) throw new CliError(ErrCode.NOT_FOUND, `no live session named "${handle}"`);
  if (!hasProvider(state.provider)) {
    throw new CliError(ErrCode.INVALID, `provider "${state.provider}" has no registered adapter`);
  }
  const messages = getProvider(state.provider).messages;
  if (!messages) {
    throw new CliError(ErrCode.INVALID, `provider "${state.provider}" does not support message inspection`);
  }
  return { state, messages };
}

interface IndexedMessage {
  index: number;
  msg: ParsedMessage;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function toMeta(row: IndexedMessage, preview: number | undefined, ts: boolean): MessageMeta {
  const meta: MessageMeta = { index: row.index, role: row.msg.role, types: row.msg.types, chars: row.msg.text.length };
  if (ts && row.msg.ts !== null) meta.ts = row.msg.ts;
  if (preview !== undefined) meta.preview = collapse(row.msg.text).slice(0, preview);
  return meta;
}

function toFull(row: IndexedMessage): MessageFull {
  return {
    index: row.index,
    role: row.msg.role,
    types: row.msg.types,
    chars: row.msg.text.length,
    ts: row.msg.ts,
    text: row.msg.text,
  };
}

/** Inclusive absolute-index window; null bounds are open, negatives count from
 *  the end, and the result is clamped to [0,n). An empty window yields []. */
function applyRange(rows: IndexedMessage[], range: MessagesRange, n: number): IndexedMessage[] {
  let from = range.from ?? 0;
  let to = range.to ?? n - 1;
  if (from < 0) from += n;
  if (to < 0) to += n;
  from = Math.max(0, from);
  to = Math.min(n - 1, to);
  return rows.filter((r) => r.index >= from && r.index <= to);
}

function matchesType(types: string[], t: string): boolean {
  return types.some((x) => x === t || x.startsWith(`${t}:`));
}

export async function runMessages(args: MessagesArgs): Promise<MessageMeta[] | MessageFull> {
  const { state, messages } = resolveMessages(args.handle);
  const path = await messages.resolveLogPath(state);
  if (!path) throw new CliError(ErrCode.NOT_FOUND, `no message log yet for "${args.handle}"`);

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new CliError(ErrCode.NOT_FOUND, `message log for "${args.handle}" not found`);
    }
    throw new CliError(ErrCode.IO, `failed to read message log for "${args.handle}"`);
  }

  const rows: IndexedMessage[] = [];
  for (const line of content.split("\n")) {
    const msg = messages.parseLine(line);
    if (msg) rows.push({ index: rows.length, msg });
  }

  if (args.mode.kind === "index") {
    const n = rows.length;
    const i = args.mode.index < 0 ? args.mode.index + n : args.mode.index;
    const row = rows[i];
    if (i < 0 || !row) {
      throw new CliError(ErrCode.NOT_FOUND, `index ${args.mode.index} out of range (${n} message${n === 1 ? "" : "s"})`);
    }
    return toFull(row);
  }

  const m = args.mode;
  let selected = m.range ? applyRange(rows, m.range, rows.length) : rows;
  if (m.role) selected = selected.filter((r) => r.msg.role === m.role);
  if (m.type) selected = selected.filter((r) => matchesType(r.msg.types, m.type!));
  return selected.map((r) => toMeta(r, m.preview, m.ts));
}

// -- Text rendering (compact; --json stays exact) --

/** Largest 1–2 units of a millisecond gap: `5s`, `2m`, `2m5s`, `1h3m`, `3d4h`. */
function formatDelta(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

/** One ts cell per row: first timestamped row absolute (HH:MM:SS, date-prefixed
 *  only when the shown rows span more than one calendar day), later rows a `+Δ`
 *  from the previous timestamped row; null/unparseable → `-`. */
function tsColumn(rows: MessageMeta[]): string[] {
  const days = new Set<string>();
  for (const r of rows) {
    if (r.ts === undefined) continue;
    const t = Date.parse(r.ts);
    if (!Number.isNaN(t)) days.add(new Date(t).toISOString().slice(0, 10));
  }
  const spansDays = days.size > 1;

  let prev: number | null = null;
  return rows.map((r) => {
    if (r.ts === undefined) return "-";
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) return "-";
    let cell: string;
    if (prev === null) {
      const iso = new Date(t).toISOString();
      cell = spansDays ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(11, 19);
    } else {
      cell = `+${formatDelta(t - prev)}`;
    }
    prev = t;
    return cell;
  });
}

function humanChars(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function renderMetaTable(rows: MessageMeta[], opts: { ts: boolean; preview: boolean }): string {
  if (rows.length === 0) return "(no messages)\n";
  const idxW = Math.max(...rows.map((r) => String(r.index).length));
  const charCells = rows.map((r) => humanChars(r.chars));
  const charW = Math.max(...charCells.map((c) => c.length));
  const tsCells = opts.ts ? tsColumn(rows) : null;
  const tsW = tsCells ? Math.max(...tsCells.map((c) => c.length)) : 0;

  const lines = rows.map((r, i) => {
    const idx = String(r.index).padStart(idxW);
    const role = r.role === "assistant" ? "A" : "U";
    const ts = tsCells ? `  ${tsCells[i]!.padEnd(tsW)}` : "";
    const chars = charCells[i]!.padStart(charW);
    const types = r.types.join(",");
    const preview = opts.preview && r.preview ? `  ${r.preview}` : "";
    return `${idx}  ${role}${ts}  ${chars}  ${types}${preview}`;
  });
  return `${lines.join("\n")}\n`;
}

/** Render either mode's result for text output. */
export function renderMessages(args: MessagesArgs, result: MessageMeta[] | MessageFull): string {
  if (args.mode.kind === "index") return (result as MessageFull).text;
  return renderMetaTable(result as MessageMeta[], {
    ts: args.mode.ts,
    preview: args.mode.preview !== undefined,
  });
}
