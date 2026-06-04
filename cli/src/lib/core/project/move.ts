/** Project-move rekey core.
 *
 *  Rewrites cwd-keyed metadata in six storage backends so a project that
 *  moved on disk from `<old>` to `<new>` continues to find its history:
 *
 *   1. `${YACO_HOME}/sessions/*.json` — `sessionPath` field
 *   2. `${YACO_HOME}/projects.json`   — `{id, path}` entries
 *   3. `~/.claude/projects/<encoded>/` — directory rename + JSONL `cwd` rewrite
 *      (preserves per-file mtime — the web app sorts the history list by mtime,
 *      so a naive write-temp + rename would float every migrated session to
 *      the top of the UI)
 *   4. `~/.codex/sessions/<date>/rollout-<id>.jsonl` — `cwd` in `session_meta`
 *   5. `~/.codex/state_5.sqlite`      — `threads.cwd` (+ `threads.agent_path`)
 *      column rewrite; the web app queries `WHERE cwd = ?` against this table
 *      so codex history is invisible in the UI without this step
 *   6. `~/.codex/config.toml`         — `[projects."<path>"]` section rename
 *
 *  The rekey is plan-then-apply: planMove() returns a serializable plan
 *  that lists every file/dir/registry-entry that would change. applyPlan()
 *  performs the mutations. Dry-run is "return the plan without applying".
 *
 *  Matching modes:
 *   - exact (default): rewrite paths equal to `oldPath` after trailing-slash
 *     normalization.
 *   - prefix (`--prefix`): also rewrite paths beginning with `oldPath + "/"`,
 *     mapping each suffix into `newPath + suffix`. A path-boundary check
 *     prevents `/foo/bar` from matching `/foo/barn`.
 *
 *  All operations are idempotent: re-running planMove() against a tree
 *  that has already been rekeyed returns an empty plan.
 */

import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  readProjects,
  writeProjects,
  type Project,
} from "../paths/index.ts";
import { stateDir } from "../agent/session-state.ts";
import { encodeClaudeCwd } from "./encode.ts";

export type MatchMode = "exact" | "prefix";

export interface MoveInputs {
  oldPath: string;
  newPath: string;
  mode: MatchMode;
  /** Override `~/.claude` root (test seam). */
  claudeHome?: string;
  /** Override `~/.codex` root (test seam). */
  codexHome?: string;
}

export interface SessionPlanItem {
  /** Absolute path to the JSON state file. */
  file: string;
  /** Handle (filename without `.json`). */
  handle: string;
  oldSessionPath: string;
  newSessionPath: string;
}

export interface RegistryPlanItem {
  id: string;
  oldPath: string;
  newPath: string;
}

export interface ClaudeProjectPlanItem {
  /** Absolute path to the encoded directory under `~/.claude/projects/`. */
  oldDir: string;
  newDir: string;
  /** Old absolute cwd that lives inside each `.jsonl` line's `cwd` field. */
  oldCwd: string;
  newCwd: string;
  /** JSONL files inside the directory (relative to oldDir). */
  files: string[];
  /** When `merge` is true, `newDir` already exists and `oldDir`'s files will
   *  be moved file-by-file into it (collision check on file basenames). */
  merge: boolean;
}

export interface CodexSessionPlanItem {
  /** Absolute path to a `rollout-*.jsonl`. */
  file: string;
  oldCwd: string;
  newCwd: string;
}

export interface CodexConfigPlanItem {
  /** Absolute path to `~/.codex/config.toml`. */
  file: string;
  oldHeader: string;
  newHeader: string;
}

export interface CodexThreadsPlanItem {
  /** Absolute path to `~/.codex/state_5.sqlite`. */
  dbPath: string;
  /** Thread row ids whose `cwd` (or `agent_path`) matches `oldCwd` (exact or
   *  subtree under `oldCwd + "/"` in prefix mode). */
  ids: string[];
  oldCwd: string;
  newCwd: string;
}

export interface MovePlan {
  oldPath: string;
  newPath: string;
  mode: MatchMode;
  sessions: SessionPlanItem[];
  registry: RegistryPlanItem[];
  claudeProjects: ClaudeProjectPlanItem[];
  codexSessions: CodexSessionPlanItem[];
  codexConfig: CodexConfigPlanItem[];
  codexThreads: CodexThreadsPlanItem[];
}

export interface MoveCounts {
  sessions: number;
  registry: number;
  claudeProjects: number;
  codexSessions: number;
  codexConfig: number;
  codexThreads: number;
}

export function emptyCounts(): MoveCounts {
  return {
    sessions: 0,
    registry: 0,
    claudeProjects: 0,
    codexSessions: 0,
    codexConfig: 0,
    codexThreads: 0,
  };
}

export function countsFor(plan: MovePlan): MoveCounts {
  return {
    sessions: plan.sessions.length,
    registry: plan.registry.length,
    claudeProjects: plan.claudeProjects.length,
    codexSessions: plan.codexSessions.length,
    codexConfig: plan.codexConfig.length,
    codexThreads: plan.codexThreads.reduce((n, t) => n + t.ids.length, 0),
  };
}

/** Trim trailing slashes (preserving the root `/`). */
export function normalizePath(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

/** Resolve a path argument to an absolute, slash-normalized form. */
export function resolveMoveArg(p: string): string {
  return normalizePath(isAbsolute(p) ? p : resolve(p));
}

/** True iff `candidate` is `prefix` or lives under `prefix + "/"`. */
export function isPathOrChild(candidate: string, prefix: string): boolean {
  if (candidate === prefix) return true;
  return candidate.startsWith(prefix + "/");
}

/** Translate one path under the move. Returns null when no rewrite applies. */
export function translatePath(
  candidate: string,
  inputs: MoveInputs,
): string | null {
  const c = normalizePath(candidate);
  const o = normalizePath(inputs.oldPath);
  const n = normalizePath(inputs.newPath);
  if (c === o) return n;
  if (inputs.mode === "prefix" && c.startsWith(o + "/")) {
    return n + c.slice(o.length);
  }
  return null;
}

function claudeHomeRoot(inputs: MoveInputs): string {
  return inputs.claudeHome ?? join(homedir(), ".claude");
}

function codexHomeRoot(inputs: MoveInputs): string {
  return inputs.codexHome ?? join(homedir(), ".codex");
}

function safeReaddir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// --- planners (pure: no fs writes) ---------------------------------------

function planSessions(inputs: MoveInputs): SessionPlanItem[] {
  const dir = stateDir();
  const items: SessionPlanItem[] = [];
  for (const file of safeReaddir(dir)) {
    if (!file.endsWith(".json")) continue;
    const abs = join(dir, file);
    let parsed: { sessionPath?: unknown };
    try {
      parsed = JSON.parse(readFileSync(abs, "utf-8"));
    } catch {
      continue;
    }
    const sp = parsed.sessionPath;
    if (typeof sp !== "string") continue;
    const next = translatePath(sp, inputs);
    if (next === null || next === sp) continue;
    items.push({
      file: abs,
      handle: file.slice(0, -5),
      oldSessionPath: sp,
      newSessionPath: next,
    });
  }
  return items;
}

function planRegistry(inputs: MoveInputs): RegistryPlanItem[] {
  let projects: Project[];
  try {
    projects = readProjects();
  } catch {
    // Malformed registry — surface as zero rewrites; the caller is responsible
    // for surfacing/repairing the corrupt file via `yaco install`'s ENV check.
    return [];
  }
  const items: RegistryPlanItem[] = [];
  for (const p of projects) {
    const next = translatePath(p.path, inputs);
    if (next === null || next === p.path) continue;
    items.push({ id: p.name, oldPath: p.path, newPath: next });
  }
  return items;
}

function planClaudeProjects(inputs: MoveInputs): ClaudeProjectPlanItem[] {
  const root = join(claudeHomeRoot(inputs), "projects");
  if (!existsSync(root)) return [];
  const oldNorm = normalizePath(inputs.oldPath);
  const items: ClaudeProjectPlanItem[] = [];

  // We compute, for the exact-old cwd and (in prefix mode) every existing
  // directory whose decoded cwd would map to a child of old, the target
  // encoded directory name. Because Claude's encoding is lossy we can't
  // reliably decode arbitrary subpaths; instead we iterate over `.jsonl`
  // files within each candidate directory and read the literal `cwd` from
  // the first line that carries one.
  const encodedOld = encodeClaudeCwd(oldNorm);

  for (const entry of safeReaddir(root)) {
    if (inputs.mode === "exact" && entry !== encodedOld) continue;
    if (inputs.mode === "prefix" && !entry.startsWith(encodedOld)) continue;

    const dir = join(root, entry);
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { /* skip */ }
    if (!isDir) continue;

    // Read the cwd literal from the first JSONL line that carries one. We
    // never trust the encoded directory name — the encoding is lossy, so
    // two distinct cwds can collide on the same directory name.
    const files = safeReaddir(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) continue;
    const cwd = readFirstCwd(join(dir, files[0]!));
    if (cwd === null) continue;

    const nextCwd = translatePath(cwd, inputs);
    if (nextCwd === null || nextCwd === cwd) continue;

    const newDirName = encodeClaudeCwd(nextCwd);
    const newDir = join(root, newDirName);
    const merge = existsSync(newDir);

    items.push({
      oldDir: dir,
      newDir,
      oldCwd: cwd,
      newCwd: nextCwd,
      files,
      merge,
    });
  }
  return items;
}

function planCodexSessions(inputs: MoveInputs): CodexSessionPlanItem[] {
  const root = join(codexHomeRoot(inputs), "sessions");
  if (!existsSync(root)) return [];
  const items: CodexSessionPlanItem[] = [];
  walkRolloutFiles(root, (file) => {
    const cwd = readFirstCwd(file);
    if (cwd === null) return;
    const next = translatePath(cwd, inputs);
    if (next === null || next === cwd) return;
    items.push({ file, oldCwd: cwd, newCwd: next });
  });
  return items;
}

function planCodexConfig(inputs: MoveInputs): CodexConfigPlanItem[] {
  const file = join(codexHomeRoot(inputs), "config.toml");
  if (!existsSync(file)) return [];
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch { return []; }

  const items: CodexConfigPlanItem[] = [];
  const seen = new Set<string>();
  // [projects."<path>"] — quoted-key table header.
  const re = /^\[projects\."([^"]+)"\]/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const candidate = match[1]!;
    const next = translatePath(candidate, inputs);
    if (next === null || next === candidate) continue;
    const oldHeader = `[projects."${candidate}"]`;
    const newHeader = `[projects."${next}"]`;
    const key = `${oldHeader} ${newHeader}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ file, oldHeader, newHeader });
  }
  return items;
}

function planCodexThreads(inputs: MoveInputs): CodexThreadsPlanItem[] {
  const dbPath = join(codexHomeRoot(inputs), "state_5.sqlite");
  if (!existsSync(dbPath)) return [];

  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    // Unreadable DB — silent no-op rather than aborting the whole move.
    return [];
  }

  try {
    // Older codex installs may have a different shape; skip silently if the
    // expected `threads` table isn't present.
    if (!hasThreadsTable(db)) return [];

    const oldNorm = normalizePath(inputs.oldPath);
    const newNorm = normalizePath(inputs.newPath);

    // Group hits by (oldCwd, newCwd) so apply can UPDATE one bucket per
    // transaction. In exact mode there is at most one cwd bucket; in prefix
    // mode each distinct subtree path becomes its own bucket.
    const buckets = new Map<string, { oldCwd: string; newCwd: string; ids: string[] }>();
    const pushHit = (id: string, oldCwd: string, newCwd: string): void => {
      const key = `${oldCwd} ${newCwd}`;
      const bucket = buckets.get(key) ?? { oldCwd, newCwd, ids: [] };
      bucket.ids.push(id);
      buckets.set(key, bucket);
    };

    // cwd column — the one the web app filters on.
    const cwdRows = inputs.mode === "exact"
      ? db.prepare("SELECT id, cwd FROM threads WHERE cwd = ?").all(oldNorm) as Array<{ id: string; cwd: string }>
      : db.prepare("SELECT id, cwd FROM threads WHERE cwd = ? OR cwd LIKE ?")
          .all(oldNorm, `${oldNorm}/%`) as Array<{ id: string; cwd: string }>;
    for (const row of cwdRows) {
      const next = translatePath(row.cwd, inputs);
      if (next === null || next === row.cwd) continue;
      pushHit(row.id, row.cwd, next);
    }

    // agent_path column — exists in the schema but typically empty. Rewrite if
    // populated. Column may be absent on older state files, so probe first.
    if (hasColumn(db, "threads", "agent_path")) {
      const apRows = inputs.mode === "exact"
        ? db.prepare("SELECT id, agent_path FROM threads WHERE agent_path = ?").all(oldNorm) as Array<{ id: string; agent_path: string | null }>
        : db.prepare("SELECT id, agent_path FROM threads WHERE agent_path = ? OR agent_path LIKE ?")
            .all(oldNorm, `${oldNorm}/%`) as Array<{ id: string; agent_path: string | null }>;
      for (const row of apRows) {
        if (typeof row.agent_path !== "string") continue;
        const next = translatePath(row.agent_path, inputs);
        if (next === null || next === row.agent_path) continue;
        // agent_path lives in the same row; we use the exact oldNorm/newNorm
        // bucket so apply rewrites both columns in lockstep for the row.
        pushHit(row.id, oldNorm, newNorm);
      }
    }

    const items: CodexThreadsPlanItem[] = [];
    for (const bucket of buckets.values()) {
      // Dedupe ids — a row can match via both cwd and agent_path.
      const ids = [...new Set(bucket.ids)];
      items.push({ dbPath, ids, oldCwd: bucket.oldCwd, newCwd: bucket.newCwd });
    }
    return items;
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

function hasThreadsTable(db: Database): boolean {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
    ).get();
    return row !== null;
  } catch {
    return false;
  }
}

function hasColumn(db: Database, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

/** Read the first `"cwd":"..."` literal from a JSONL file (best-effort, line by
 *  line, stops at the first match). Returns null on any error. */
function readFirstCwd(file: string): string | null {
  try {
    const raw = readFileSync(file, "utf-8");
    // Scan line by line to avoid pathologically large single-line files
    // exploding memory through a regex scan of the entire buffer.
    let start = 0;
    while (start < raw.length) {
      const nl = raw.indexOf("\n", start);
      const end = nl === -1 ? raw.length : nl;
      const line = raw.slice(start, end);
      // Claude: `"cwd":"…"` at message top-level.
      // Codex: `…"payload":{ …"cwd":"…", …}` inside session_meta.
      const m = /"cwd":"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(line);
      if (m) {
        // Unescape JSON string escapes that may have survived the regex.
        try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]!; }
      }
      if (nl === -1) break;
      start = nl + 1;
    }
  } catch { /* fall through */ }
  return null;
}

function walkRolloutFiles(root: string, visit: (file: string) => void): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of safeReaddir(dir)) {
      const abs = join(dir, entry);
      let stats: ReturnType<typeof statSync>;
      try { stats = statSync(abs); } catch { continue; }
      if (stats.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        visit(abs);
      }
    }
  }
}

// --- planMove + applyPlan -----------------------------------------------

export function planMove(inputs: MoveInputs): MovePlan {
  return {
    oldPath: normalizePath(inputs.oldPath),
    newPath: normalizePath(inputs.newPath),
    mode: inputs.mode,
    sessions: planSessions(inputs),
    registry: planRegistry(inputs),
    claudeProjects: planClaudeProjects(inputs),
    codexSessions: planCodexSessions(inputs),
    codexConfig: planCodexConfig(inputs),
    codexThreads: planCodexThreads(inputs),
  };
}

export function applyPlan(plan: MovePlan): MoveCounts {
  const counts = emptyCounts();
  for (const item of plan.sessions) {
    rewriteJsonField(item.file, "sessionPath", item.oldSessionPath, item.newSessionPath);
    counts.sessions += 1;
  }
  if (plan.registry.length > 0) {
    const projects = readProjects();
    let changed = false;
    for (const p of projects) {
      const hit = plan.registry.find((r) => r.id === p.name && r.oldPath === p.path);
      if (hit) {
        p.path = hit.newPath;
        changed = true;
      }
    }
    if (changed) writeProjects(projects);
    counts.registry = plan.registry.length;
  }
  for (const item of plan.claudeProjects) {
    moveClaudeProjectDir(item);
    counts.claudeProjects += 1;
  }
  for (const item of plan.codexSessions) {
    rewriteCwdInJsonl(item.file, item.oldCwd, item.newCwd);
    counts.codexSessions += 1;
  }
  // Group codex config items by file so we read+write each file once.
  const byFile = new Map<string, CodexConfigPlanItem[]>();
  for (const item of plan.codexConfig) {
    const arr = byFile.get(item.file) ?? [];
    arr.push(item);
    byFile.set(item.file, arr);
  }
  for (const [file, items] of byFile) {
    rewriteCodexConfig(file, items);
    counts.codexConfig += items.length;
  }
  // Group codex threads by db path; each DB gets one open + one transaction
  // covering every bucket (we never have more than one DB in practice, but
  // grouping keeps the structure honest).
  const threadsByDb = new Map<string, CodexThreadsPlanItem[]>();
  for (const item of plan.codexThreads) {
    const arr = threadsByDb.get(item.dbPath) ?? [];
    arr.push(item);
    threadsByDb.set(item.dbPath, arr);
  }
  for (const [dbPath, items] of threadsByDb) {
    counts.codexThreads += applyCodexThreads(dbPath, items);
  }
  return counts;
}

function rewriteJsonField(
  file: string,
  field: string,
  oldValue: string,
  newValue: string,
): void {
  const raw = readFileSync(file, "utf-8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (data[field] !== oldValue) {
    // Concurrent edit raced us — bail out silently rather than overwriting
    // unrelated state. The next `yaco project move` invocation will pick it
    // up if it still matches.
    return;
  }
  data[field] = newValue;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function moveClaudeProjectDir(item: ClaudeProjectPlanItem): void {
  if (!item.merge) {
    // Simple case: rename the directory wholesale, then rewrite `cwd` inside
    // each JSONL. The rename is atomic; the rewrite is per-file best-effort.
    // rename(2) preserves per-file mtimes; the rewrite step preserves them
    // again. Together: web app's "modified DESC" sort stays accurate.
    if (!existsSync(dirname(item.newDir))) mkdirSync(dirname(item.newDir), { recursive: true });
    renameSync(item.oldDir, item.newDir);
    for (const f of item.files) {
      const abs = join(item.newDir, f);
      rewriteCwdInJsonl(abs, item.oldCwd, item.newCwd);
    }
    return;
  }
  // Merge case: target dir already exists (encoded collision). Move files one
  // at a time; refuse to clobber existing files. Leftovers (collisions) stay
  // in oldDir for manual resolution.
  for (const f of item.files) {
    const src = join(item.oldDir, f);
    const dst = join(item.newDir, f);
    if (existsSync(dst)) continue; // refuse to clobber
    renameSync(src, dst);
    rewriteCwdInJsonl(dst, item.oldCwd, item.newCwd);
  }
}

function rewriteCwdInJsonl(file: string, oldCwd: string, newCwd: string): void {
  const raw = readFileSync(file, "utf-8");
  const oldLit = `"cwd":"${jsonEscape(oldCwd)}"`;
  const newLit = `"cwd":"${jsonEscape(newCwd)}"`;
  if (!raw.includes(oldLit)) return;
  // preserve mtime — web app sorts by it
  const targetMtime = chooseJsonlMtime(file, raw);
  // Use split/join for a literal string replace (no regex DoS surface).
  const next = raw.split(oldLit).join(newLit);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, file);
  if (targetMtime !== null) {
    try { utimesSync(file, targetMtime, targetMtime); } catch { /* best-effort */ }
  }
}

/** Pick the mtime to restore on a rewritten JSONL.
 *  1. The pre-rewrite file mtime is the natural choice — it's the actual
 *     wall-clock when the session was last touched on disk.
 *  2. As a fallback (and a sanity floor), scan the JSONL for the latest
 *     `"timestamp"` field on a message line and use that instead if it's
 *     fresher than the file mtime. This covers the case where the file mtime
 *     was already incorrect going in (e.g. the file went through a `cp`/
 *     `rsync` that landed today, while the messages inside it are days old).
 *  Returns null if neither source yields a usable time. */
function chooseJsonlMtime(file: string, raw: string): Date | null {
  let mtime: Date | null = null;
  try { mtime = statSync(file).mtime; } catch { /* no fs mtime */ }
  const internal = maxJsonlTimestamp(raw);
  if (internal !== null && (mtime === null || internal < mtime)) {
    // Internal timestamp is older — trust it (file mtime is suspect).
    return internal;
  }
  return mtime;
}

/** Walk a JSONL buffer line by line, return the max top-level `timestamp`
 *  field as a Date. Returns null when no parseable timestamp is found.
 *  Uses a substring guard to skip non-message metadata lines cheaply. */
function maxJsonlTimestamp(raw: string): Date | null {
  let best: number | null = null;
  let start = 0;
  while (start < raw.length) {
    const nl = raw.indexOf("\n", start);
    const end = nl === -1 ? raw.length : nl;
    const line = raw.slice(start, end);
    start = nl === -1 ? raw.length : nl + 1;
    if (!line.includes('"timestamp"')) continue;
    const m = /"timestamp"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]!);
    if (Number.isNaN(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best === null ? null : new Date(best);
}

function jsonEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function rewriteCodexConfig(file: string, items: CodexConfigPlanItem[]): void {
  let raw = readFileSync(file, "utf-8");
  for (const item of items) {
    raw = raw.split(item.oldHeader).join(item.newHeader);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, raw);
  renameSync(tmp, file);
}

/** Apply codex threads-table rewrites. Each plan item carries a bucket of row
 *  ids that share the same (oldCwd, newCwd) translation. Wraps every db's
 *  worth of updates in BEGIN/COMMIT for atomicity. Returns the total number
 *  of rows updated. */
function applyCodexThreads(
  dbPath: string,
  items: CodexThreadsPlanItem[],
): number {
  if (!existsSync(dbPath)) return 0;
  let db: Database;
  try {
    db = new Database(dbPath); // read-write
  } catch {
    return 0;
  }
  let updated = 0;
  try {
    const hasAgentPath = hasColumn(db, "threads", "agent_path");
    db.run("BEGIN");
    try {
      const updateCwd = db.prepare(
        "UPDATE threads SET cwd = ? WHERE id = ? AND cwd = ?",
      );
      const updateAgentPath = hasAgentPath
        ? db.prepare(
            "UPDATE threads SET agent_path = ? WHERE id = ? AND agent_path = ?",
          )
        : null;
      for (const item of items) {
        for (const id of item.ids) {
          const r1 = updateCwd.run(item.newCwd, id, item.oldCwd);
          if ((r1.changes ?? 0) > 0) updated += 1;
          if (updateAgentPath) {
            // Same oldCwd → newCwd applies to agent_path when it matches.
            updateAgentPath.run(item.newCwd, id, item.oldCwd);
          }
        }
      }
      db.run("COMMIT");
    } catch (e) {
      try { db.run("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
  return updated;
}