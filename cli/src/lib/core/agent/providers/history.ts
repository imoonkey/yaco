/** The one project-history read, shared by `yaco agent history` and the app's
 *  History tab.
 *
 *  Claude and Codex rebuild project session history from their own persisted
 *  files and databases. This module co-locates that parsing, merges the
 *  providers, applies the window, and tags live YACO sessions — so `app/server`
 *  never opens `~/.claude` or `~/.codex` itself and there is one implementation
 *  behind both call mechanisms.
 *
 *  **A project is a subtree, not a path.** A session belongs to this project
 *  when its cwd is the project path or a descendant of it — the predicate the
 *  live session list already applies (`isPathDescendantOrEqual`). Both providers
 *  key their own storage on an exact cwd, so each reader widens it in the terms
 *  its storage offers: Claude by directory (`claudeProjectDirs`), Codex in the
 *  query. Without it an agent running in `<project>/.worktrees/<slug>` is listed
 *  while it runs and gone the moment it is only history.
 *
 *  **Every provider scan is capped at the window.** The merge sorts newest-first
 *  and `--since` filters on the same `updatedAt`, so the rows past any cutoff are
 *  a *prefix* of each provider's own newest-first order: "the newest `cap` rows
 *  of a provider" already is "that provider's window past the cutoff", whatever
 *  the cutoff is. That is what lets the cap ignore `since` entirely — and it only
 *  holds while a provider's cap key is the very key the merge sorts by, which is
 *  the whole reason Claude is read in two phases below.
 *
 *  The cap is `limit + 1` rather than `limit` because `truncated` is
 *  `matching.length > limit`: at `limit` a provider holding `limit + 5` matching
 *  rows would report a full, untruncated window. At `limit + 1`, each of the top
 *  `limit + 1` matching rows has at most `limit` rows above it *within its own
 *  provider*, so all of them survive the cap and the comparison stays exact.
 *
 *  The live sessions are an explicit input: enumerating them is the caller's job
 *  (the CLI reads its state files, the app already holds its own list), which is
 *  what keeps this module clear of `session-state.ts` — a mutation module no
 *  exported closure may reach. Failures come back as `Result`, never as a throw.
 *
 *  The per-session summary *label* is not here: `summary-read.ts` owns it, and
 *  the collapsing rules both go through live in `prompt-label.ts` so the History
 *  tab and the session list cannot drift.
 *
 *  -> See: `doc/main/cli/exports.md` (the six eligibility rules this obeys). */

import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { toErr } from "../../errors.ts";
import { ok, type Result } from "../../result.ts";
import { encodeClaudeCwd } from "../../project/encode.ts";
import { isPathDescendantOrEqual, normalizeProjectPath } from "../projection.ts";
import { readOrigins } from "../origin-read.ts";
import { PENDING_SESSION_ID, type SpawnedBy } from "../model.ts";
import { codexThreadWindow } from "./codex-thread-window.ts";
import { extractUserText, firstMeaningfulMessage } from "./prompt-label.ts";
import { userHome } from "./provider-home.ts";
import type { HistorySession, HistoryWindow } from "./types.ts";

/** Default history row limit after filtering the merged provider rows. */
export const DEFAULT_HISTORY_LIMIT = 200;
/** Bytes read from the head of each Claude JSONL (first user message + start). */
const HEAD_BYTES = 16384;
/** Bytes read from the tail of each Claude JSONL (last custom-title + mtime). */
const TAIL_BYTES = 65536;
/** How many files are opened at once inside one fan-out. Same width as the task
 *  store's and the summary read's chunked readers: wide enough that the reads
 *  overlap, narrow enough that one chunk's synchronous tail stays short. */
const READ_CONCURRENCY = 8;
/** Lines parsed between yields when scanning a whole-file JSONL index. */
const INDEX_LINES_PER_CHUNK = 500;

/** Everything live tagging needs from a session, and nothing else. A
 *  `SessionState` satisfies it, so the CLI passes its state files through
 *  unchanged; the app maps its own session row. Spelling the input this narrowly
 *  is what makes two concurrent calls on different projects structurally unable
 *  to cross. */
export interface HistoryLiveSession {
  handle: string;
  sessionId: string;
  resumedFrom?: string | null;
  spawnedBy?: SpawnedBy | null;
  parentSession?: string | null;
}

/** A provider's newest `cap` rows for a project, newest-first by `updatedAt`. */
type ProviderHistoryReader = (projectPath: string, cap: number) => Promise<HistorySession[]>;

/** Run `worker` over `items` `READ_CONCURRENCY` at a time, yielding the loop
 *  between chunks so an already-queued timer or socket is served. A loop of
 *  awaits is what rule 5 asks a chunked reader to be — it is not a polling
 *  loop. */
async function chunked<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += READ_CONCURRENCY) {
    out.push(...await Promise.all(items.slice(i, i + READ_CONCURRENCY).map(worker)));
    if (i + READ_CONCURRENCY < items.length) await yieldLoop();
  }
  return out;
}

function yieldLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Read `length` bytes of `path` at `position`, or "" when unreadable. */
async function readSlice(path: string, position: number, length: number): Promise<string> {
  if (length <= 0) return "";
  let file;
  try {
    file = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    return buffer.toString("utf-8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    await file.close();
  }
}

// -- Claude JSONL parsing --

/** Iterate a chunk of JSONL text backwards, newest record first. A partial line
 *  at a read boundary just fails to parse and is skipped. */
function* linesFromEnd(text: string): Generator<string> {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line) yield line;
  }
}

/** The last custom-title in a chunk of JSONL text.
 *
 *  Scanning backwards and stopping at the first hit returns the same title a
 *  forward scan's last hit would, and parses one record instead of every
 *  titled one — which is what makes a 64 KB tail cost a parse rather than a
 *  scan. `parseLastTimestamp` and `parseLastClaudeTokens` are the same shape. */
function parseLastTitle(text: string): string | null {
  for (const line of linesFromEnd(text)) {
    if (!line.includes("custom-title")) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "custom-title" && entry.customTitle) return entry.customTitle;
    } catch { /* partial line at a read boundary — skip */ }
  }
  return null;
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
  for (const line of linesFromEnd(text)) {
    const ts = parseEntryTimestamp(line);
    if (ts) return ts;
  }
  return null;
}

/** The first meaningful user message in the head of a Claude JSONL file.
 *  Slash commands are restored to `/command args`; reminders and stdout are
 *  skipped. `firstMeaningfulMessage` judges each text independently of the ones
 *  around it, so stopping at the first that qualifies returns the same label a
 *  whole-head scan would. */
function parseFirstUserMessage(head: string): string | null {
  for (const line of head.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user" || !entry.message?.content) continue;
      const label = firstMeaningfulMessage([extractUserText(entry.message.content)]);
      if (label) return label;
    } catch { continue; }
  }
  return null;
}

// -- Token usage (last-turn "session size" signal) --

/** Last assistant turn's total tokens from a Claude JSONL slice: input plus the
 *  cache_creation/cache_read context (Claude reports cached tokens in separate
 *  fields disjoint from `input_tokens`, so all are summed) plus output. */
function parseLastClaudeTokens(text: string): number | null {
  for (const line of linesFromEnd(text)) {
    if (!line.includes('"usage"')) continue;
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
  for (const line of linesFromEnd(text)) {
    if (!line.includes("last_token_usage")) continue;
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
  let size: number;
  try {
    size = (await stat(rolloutPath)).size;
  } catch { return null; }
  if (size === 0) return null;
  const length = Math.min(size, TAIL_BYTES);
  return parseLastCodexTokens(await readSlice(rolloutPath, size - length, length));
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

function claudeProjectsRoot(): string {
  return join(userHome(), ".claude", "projects");
}

/** A normalized project path with exactly one trailing separator — the literal
 *  string every descendant cwd starts with. The filesystem root already carries
 *  its separator, and appending a second would match nothing. */
function descendantPrefix(projectPath: string): string {
  return projectPath.endsWith(sep) ? projectPath : projectPath + sep;
}

function claudeProjectDir(projectPath: string): string {
  // Claude Code keys ~/.claude/projects/<encoded-cwd>/ with the same lossy
  // encoder used for project-move directory renames (non-alphanumerics → "-"),
  // so a path like `/repo/.worktrees/x` resolves to `-repo--worktrees-x`.
  return join(claudeProjectsRoot(), encodeClaudeCwd(projectPath));
}

/** The literal `cwd` a Claude log records, from a slice of it. */
function parseCwd(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.cwd === "string" && entry.cwd) return entry.cwd;
    } catch { /* partial line at a read boundary — skip */ }
  }
  return null;
}

/** Load sessions-index.json as optional per-session enrichment. One file per
 *  project, and one `JSON.parse` of it: no chunking divides a single parse, the
 *  same limit the app's task store reaches on a single-file graph. */
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

/** What the tail of a Claude log settles: the row's ordering key, its title and
 *  its token count. Everything the *window* then needs comes from the head. */
interface ClaudeTail {
  sessionId: string;
  path: string;
  size: number;
  entry: ClaudeIndexEntry | undefined;
  birthtime: string;
  mtime: string;
  updatedAt: string;
  title: string | null;
  tokens: number | null;
  /** The literal cwd this log records — what decides whether it is this
   *  project's. Null when the log records none anywhere it was read. */
  cwd: string | null;
}

/** Phase 1 for one Claude log: `stat` plus a single tail read, which is all the
 *  ordering key needs.
 *
 *  The key cannot come from `stat` alone. `updatedAt` is the index's `modified`,
 *  else the log's own last timestamp, and only then the file's mtime — so a cap
 *  taken on mtime would order rows by a key the merge does not use. The golden
 *  fixture writes literal in-log timestamps precisely so `stat` never reaches
 *  the output, and the bench fixture's logs are all written within one second of
 *  each other; on both, an mtime cap picks a different window than the merge
 *  would. Hence: read the tail of every log, and the head of only the window.
 *
 *  When the file is no larger than `TAIL_BYTES` the tail *is* the whole file, so
 *  it already covers the head. Only a larger log missing its timestamp or its
 *  cwd in the last 64 KB falls back to its head, and only that log pays a second
 *  read here.
 *
 *  The cwd is taken from the same slice, which is what makes per-log attribution
 *  free: every log the union reaches is tail-read anyway. */
async function claudeTail(
  dir: string,
  file: string,
  index: Map<string, ClaudeIndexEntry>,
): Promise<ClaudeTail | null> {
  const sessionId = file.replace(/\.jsonl$/, "");
  const entry = index.get(sessionId);
  if (entry?.isSidechain) return null;

  const path = join(dir, file);
  let birthtime: string;
  let mtime: string;
  let size: number;
  try {
    const st = await stat(path);
    birthtime = (st.birthtime ?? st.ctime).toISOString();
    mtime = st.mtime.toISOString();
    size = st.size;
  } catch { return null; }

  const tailLength = Math.min(size, TAIL_BYTES);
  const tail = await readSlice(path, size - tailLength, tailLength);
  let fromLog = parseLastTimestamp(tail);
  let cwd = parseCwd(tail);
  if ((fromLog === null || cwd === null) && size > TAIL_BYTES) {
    const head = await readSlice(path, 0, HEAD_BYTES);
    fromLog ??= parseLastTimestamp(head);
    cwd ??= parseCwd(head);
  }

  return {
    sessionId,
    path,
    size,
    entry,
    birthtime,
    mtime,
    updatedAt: entry?.modified || fromLog || mtime,
    title: parseLastTitle(tail),
    tokens: parseLastClaudeTokens(tail),
    cwd,
  };
}

/** Phase 2 for one Claude log in the window: the head read that carries the
 *  summary and the start timestamp, plus the title fallback for a log whose
 *  tail did not reach its head. */
async function claudeRow(tail: ClaudeTail): Promise<HistorySession> {
  const head = await readSlice(tail.path, 0, Math.min(HEAD_BYTES, tail.size));
  return {
    sessionId: tail.sessionId,
    provider: "claude",
    title: tail.title ?? parseLastTitle(head),
    summary: tail.entry?.summary || parseFirstUserMessage(head) || "(no prompt)",
    created: tail.entry?.created || parseFirstTimestamp(head) || tail.birthtime,
    updatedAt: tail.updatedAt,
    tokens: tail.tokens,
    gitBranch: tail.entry?.gitBranch ?? null,
  };
}

/** One Claude directory that belongs to the project, read once: its logs and
 *  its index. */
interface ClaudeLogDir {
  dir: string;
  files: string[];
  index: Map<string, ClaudeIndexEntry>;
}

/** Read one directory's logs and index, or null when it holds no logs. */
async function claudeLogDir(dir: string): Promise<ClaudeLogDir | null> {
  // The order a raw directory read produces is undefined; it does not reach the
  // output, because `byUpdatedAtThenSessionId` decides the window and
  // `newestPerSession` has already made the session id unique across the
  // directories, so no pair of rows can tie under it.
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch { return null; }
  if (files.length === 0) return null;
  return { dir, files, index: await loadClaudeIndex(dir) };
}

/** Every Claude directory that *may* hold sessions of `projectPath` — its own,
 *  and every name that could encode a descendant cwd.
 *
 *  A session is this project's when its cwd is the project path or below it,
 *  which is the predicate the live session list already applies
 *  (`listByPath`, `resolveProjectForPath`). History used to read one exact
 *  directory instead, so an agent working in `<project>/.worktrees/<slug>` was
 *  listed while it ran and vanished the moment it was only history.
 *
 *  This is deliberately a *superset*: the name cannot decide membership, because
 *  `encodeClaudeCwd` maps every non-alphanumeric to `-` and has no inverse, so
 *  the sibling `<project>-backups` shares the prefix with
 *  `<project>/.worktrees/x` and two distinct cwds can even collide onto one
 *  directory. What decides is the cwd each log records (`claudeList`); this only
 *  narrows how many logs have to be read. Nor could the filesystem decide it: a
 *  worktree's directory is deleted when it merges, long before its history stops
 *  mattering — which is the history this scan exists to find.
 *
 *  A project at the filesystem root has no separator to append, and every
 *  absolute path encodes with the leading `-` its own encoding is: at root the
 *  prefix is that `-` and the superset is every directory, which is what a
 *  project containing everything means. */
async function claudeProjectDirs(projectPath: string): Promise<string[]> {
  const own = claudeProjectDir(projectPath);
  let names: string[];
  try {
    names = await readdir(claudeProjectsRoot());
  } catch { return [own]; }

  // A Set because at the root the project's own encoded name is `-`, which is
  // also the prefix every descendant carries: without it the root directory
  // would be read twice.
  const prefix = encodeClaudeCwd(descendantPrefix(projectPath));
  return [...new Set([own, ...names.filter((n) => n.startsWith(prefix)).map((n) => join(claudeProjectsRoot(), n))])];
}

/** One tail per session id. A thread resumed under a second cwd is logged under
 *  both, and the union — unlike the single directory this replaced — sees both.
 *  The newest wins; the path breaks a tie, so the surviving row never depends on
 *  the order the directories happened to be read in. */
function newestPerSession(tails: ClaudeTail[]): ClaudeTail[] {
  const best = new Map<string, ClaudeTail>();
  for (const tail of tails) {
    const prev = best.get(tail.sessionId);
    if (!prev) {
      best.set(tail.sessionId, tail);
      continue;
    }
    const rank = updatedAtRank(tail.updatedAt);
    const prevRank = updatedAtRank(prev.updatedAt);
    if (rank > prevRank || (rank === prevRank && tail.path < prev.path)) best.set(tail.sessionId, tail);
  }
  return [...best.values()];
}

/** Whether one log belongs to the project.
 *
 *  Per log, never per directory: a directory is a *lossy* key, so one that holds
 *  a descendant's logs can hold an unrelated cwd's too, and letting the first
 *  log read decide for its neighbours would both admit and drop history
 *  according to `readdir` order. Each log records the cwd that settles it.
 *
 *  A log that records none anywhere it was read is **out**, wherever it sits.
 *  The directory it was filed under is not the evidence to fall back to — it is
 *  the same lossy encoding, `/repo/demo` and `/repo:demo` being one name — so
 *  falling back there would keep exactly the leak per-log attribution removes.
 *  Nothing real is lost by failing closed: a Claude log records its cwd on every
 *  user and assistant record, so the only logs this drops are ones that never
 *  reached a turn (0 of 1 051 logs on the reference home lack one). */
function belongsToProject(tail: ClaudeTail, projectPath: string): boolean {
  return tail.cwd !== null && isPathDescendantOrEqual(tail.cwd, projectPath);
}

async function claudeList(rawProjectPath: string, cap: number): Promise<HistorySession[]> {
  const projectPath = normalizeProjectPath(rawProjectPath);
  const dirs = (await chunked(await claudeProjectDirs(projectPath), claudeLogDir))
    .filter((d): d is ClaudeLogDir => d !== null);

  // One fan-out over every log of every directory, so the width stays
  // `READ_CONCURRENCY` however many directories the project spans — and so the
  // cap is taken once, over the union. A per-directory cap would let one busy
  // worktree crowd the project's own sessions out of the window, and the window
  // would stop being a prefix of the merged newest-first order.
  const logs = dirs.flatMap((d) => d.files.map((file) => ({ d, file })));
  const tails = await chunked(logs, ({ d, file }) => claudeTail(d.dir, file, d.index));
  const window = newestPerSession(
    tails.filter((t): t is ClaudeTail => t !== null && belongsToProject(t, projectPath)),
  )
    .sort(byUpdatedAtThenSessionId)
    .slice(0, cap);

  return chunked(window, claudeRow);
}

// -- Codex provider history --

/** Convert a Codex unix epoch (seconds or milliseconds) to ISO 8601. */
function epochToISO(epoch: number): string {
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  return new Date(ms).toISOString();
}

/** Last-entry-wins map of Codex thread id → user-assigned thread name.
 *
 *  One whole-file JSONL scan, so the parse is chunked with a yield between
 *  chunks the same way a file fan-out is: the file is a quarter of a megabyte
 *  and two thousand records on the reference home and it only grows. */
async function loadCodexThreadNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let content: string;
  try {
    content = await readFile(join(userHome(), ".codex", "session_index.jsonl"), "utf-8");
  } catch { return map; }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += INDEX_LINES_PER_CHUNK) {
    for (const line of lines.slice(i, i + INDEX_LINES_PER_CHUNK)) {
      if (!line.includes("thread_name")) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.id && entry.thread_name) map.set(entry.id, entry.thread_name);
      } catch { continue; }
    }
    if (i + INDEX_LINES_PER_CHUNK < lines.length) await yieldLoop();
  }
  return map;
}

/** Read Codex session history for a project from the threads table.
 *
 *  The query's `LIMIT` is the exact cap: its ORDER BY key is the very column
 *  `epochToISO` turns into the row's `updatedAt`. That holds while a table keeps
 *  one epoch unit, which is what Codex writes; `epochToISO`'s seconds-or-ms
 *  guard is for reading a value, not for ordering a mixed table. */
async function codexList(projectPath: string, cap: number): Promise<HistorySession[]> {
  const rows = codexThreadWindow(normalizeProjectPath(projectPath), cap);
  if (rows.length === 0) return [];

  const threadNames = await loadCodexThreadNames();

  return chunked(rows, async (row) => ({
    sessionId: row.id,
    provider: "codex",
    title: threadNames.get(row.id) ?? null,
    summary: row.first_user_message || "(no prompt)",
    created: epochToISO(row.created_at),
    updatedAt: epochToISO(row.updated_at),
    tokens: await codexRolloutTokens(row.rollout_path),
    gitBranch: row.git_branch ?? null,
  }));
}

// -- The provider registry --

/** Providers whose sessions appear in project history — the single answer to
 *  "which history reader does this provider use", for the CLI and the app alike.
 *
 *  Deliberately not a `TuiProvider` capability: the TUI registry reaches tmux,
 *  hook installation and the session lifecycle, which no exported closure may.
 *  `test/history.test.ts` fails closed if a registered provider has no entry
 *  here. A Map keeps membership to listed ids only — a plain object would
 *  resolve inherited keys like "toString" or "constructor". */
const HISTORY_PROVIDERS = new Map<string, ProviderHistoryReader>([
  ["claude", claudeList],
  ["codex", codexList],
]);

export function historyReaderForProvider(provider: string): ProviderHistoryReader | null {
  return HISTORY_PROVIDERS.get(provider) ?? null;
}

// -- Merge + live tagging --

/** Sort rank for an `updatedAt`: its epoch time, or −∞ when it does not parse so
 *  it ranks after every real timestamp. Never NaN — a NaN rank compares unequal
 *  to itself, which would make the history comparator intransitive and hand the
 *  order back to the sort's internals. */
function updatedAtRank(updatedAt: string): number {
  const t = new Date(updatedAt).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** Newest-first, ties broken by ascending `sessionId`.
 *
 *  Rows sharing an `updatedAt` — routine once two providers' clocks are merged —
 *  would otherwise fall through to the merge order, which is a directory read,
 *  so the window boundary at `limit` could include a different row on each call.
 *  Each provider caps its own scan with this same comparator, which is what
 *  makes a per-provider cap a prefix of what the merge would have chosen. */
function byUpdatedAtThenSessionId(
  a: { updatedAt: string; sessionId: string },
  b: { updatedAt: string; sessionId: string },
): number {
  const at = updatedAtRank(a.updatedAt);
  const bt = updatedAtRank(b.updatedAt);
  if (at !== bt) return bt - at;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** Sort merged provider rows newest-first, filter by `since`, cap them at
 *  `limit`, and tag the window's rows with their live session and durable
 *  origin.
 *
 *  `since` is applied *after* the merge and *before* the limit, so a cutoff can
 *  never cost the caller rows it would otherwise have seen — and the durable
 *  origin index is read only for the rows that survive, at most `limit` small
 *  files, asynchronously. */
export async function finalizeHistory(
  rows: HistorySession[],
  liveSessions: readonly HistoryLiveSession[],
  options: { limit?: number; since?: Date } = {},
): Promise<HistoryWindow> {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  const cutoff = options.since?.getTime();
  const sorted = [...rows].sort(byUpdatedAtThenSessionId);
  const matching = cutoff === undefined
    ? sorted
    : sorted.filter((row) => new Date(row.updatedAt).getTime() >= cutoff);
  const windowRows = matching.slice(0, limit);

  const liveBySessionId = new Map<string, HistoryLiveSession>();
  for (const s of liveSessions) {
    if (s.sessionId && s.sessionId !== PENDING_SESSION_ID) liveBySessionId.set(s.sessionId, s);
  }

  const durable = await readOrigins(
    windowRows
      .filter((row) => {
        const live = liveBySessionId.get(row.sessionId);
        return !(live && !live.resumedFrom && live.spawnedBy);
      })
      .map((row) => row.sessionId),
  );

  const enriched = windowRows.map((row) => {
    const live = liveBySessionId.get(row.sessionId);
    const handle = live?.handle ?? null;
    const liveOrigin = live && !live.resumedFrom && live.spawnedBy
      ? { spawnedBy: live.spawnedBy, parentSession: live.parentSession ?? null }
      : null;
    const origin = liveOrigin ?? durable.get(row.sessionId) ?? null;
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

/** Merged, windowed project history with live sessions tagged.
 *
 *  Every provider is asked for `limit + 1` rows — see this module's header for
 *  why that cap is exact under `--since` and under `truncated` alike. */
export async function readProjectHistory(
  projectPath: string,
  liveSessions: readonly HistoryLiveSession[],
  options: { limit?: number; since?: Date } = {},
): Promise<Result<HistoryWindow>> {
  try {
    const cap = (options.limit ?? DEFAULT_HISTORY_LIMIT) + 1;
    const perProvider = await Promise.all(
      [...HISTORY_PROVIDERS.values()].map((read) => read(projectPath, cap)),
    );
    return ok(await finalizeHistory(perProvider.flat(), liveSessions, options));
  } catch (e) {
    return toErr(e);
  }
}
