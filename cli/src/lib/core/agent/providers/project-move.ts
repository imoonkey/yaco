/** Provider project-move adapters.
 *
 *  Each provider owns the cwd-keyed rewrites in its own private storage so the
 *  generic mover (`core/project/move.ts`) never learns a provider's on-disk
 *  schema. A provider returns an opaque, serializable `ProviderMovePlan`; the
 *  generic mover persists it (dry-run JSON), renders it back through
 *  `renderText`, and applies it back through `apply` — without inspecting the
 *  payload.
 *
 *  Claude owns `~/.claude/projects/<encoded-cwd>/`: the encoded directory
 *  rename plus the per-file JSONL `cwd` rewrite. The rewrite preserves each
 *  file's mtime because the web app sorts the history list by mtime, so a naive
 *  write-temp + rename would float every migrated session to the top of the UI.
 *
 *  Codex owns three stores, none of them directory-keyed by cwd:
 *   - `~/.codex/sessions/<date>/rollout-<id>.jsonl` — `cwd` in `session_meta`
 *   - `~/.codex/config.toml`        — `[projects."<path>"]` section rename
 *   - `~/.codex/state_5.sqlite`     — `threads.cwd` (+ `threads.agent_path`);
 *     the web app queries `WHERE cwd = ?` so codex history is invisible without
 *     this step.
 *
 *  Plans are side-effect-free; `apply` performs the mutations. All operations
 *  are idempotent: re-planning a tree that was already rekeyed yields no items.
 */

import { DatabaseSync } from "node:sqlite";
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
import { dirname, join } from "node:path";

import { encodeClaudeCwd } from "../../project/encode.ts";
import { normalizePath, translatePath } from "../../project/match.ts";
import type {
  ProjectMoveInputs,
  ProviderMoveCounts,
  ProviderMovePlan,
  ProviderProjectMove,
} from "./types.ts";

// --- payload item shapes (serializable; opaque to the generic mover) -------

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

export interface ClaudeMovePayload {
  items: ClaudeProjectPlanItem[];
}

export interface CodexMovePayload {
  sessions: CodexSessionPlanItem[];
  config: CodexConfigPlanItem[];
  threads: CodexThreadsPlanItem[];
}

// --- home resolution (honor $HOME at call time for test overrides) ---------

function userHome(): string {
  const env = process.env["HOME"];
  return env && env.length > 0 ? env : homedir();
}

function providerHome(inputs: ProjectMoveInputs, id: string, dir: string): string {
  return inputs.providerHomeOverrides?.[id] ?? join(userHome(), dir);
}

// --- shared fs helpers -----------------------------------------------------

function safeReaddir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
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

function jsonEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
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

// --- Claude adapter --------------------------------------------------------

function planClaudeProjects(inputs: ProjectMoveInputs): ClaudeProjectPlanItem[] {
  const root = join(providerHome(inputs, "claude", ".claude"), "projects");
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

    const nextCwd = translatePath(cwd, inputs.oldPath, inputs.newPath, inputs.mode);
    if (nextCwd === null || nextCwd === cwd) continue;

    const newDirName = encodeClaudeCwd(nextCwd);
    const newDir = join(root, newDirName);
    const merge = existsSync(newDir);

    items.push({ oldDir: dir, newDir, oldCwd: cwd, newCwd: nextCwd, files, merge });
  }
  return items;
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

export function claudeProjectMove(): ProviderProjectMove {
  return {
    countRows: [{ key: "claudeProjects", label: "~/.claude/projects" }],

    plan(inputs: ProjectMoveInputs): ProviderMovePlan | null {
      const items = planClaudeProjects(inputs);
      if (items.length === 0) return null;
      return {
        provider: "claude",
        label: "Claude",
        counts: { claudeProjects: items.length },
        payload: { items } satisfies ClaudeMovePayload,
      };
    },

    apply(plan: ProviderMovePlan): ProviderMoveCounts {
      const { items } = plan.payload as ClaudeMovePayload;
      for (const item of items) moveClaudeProjectDir(item);
      return { claudeProjects: items.length };
    },

    renderText(plan: ProviderMovePlan): readonly string[] {
      const { items } = plan.payload as ClaudeMovePayload;
      if (items.length === 0) return [];
      const lines = ["~/.claude/projects:"];
      for (const c of items) {
        const tag = c.merge ? " (merge into existing target)" : "";
        lines.push(`  ${c.oldDir}`);
        lines.push(`    -> ${c.newDir}${tag}`);
        lines.push(`       cwd ${c.oldCwd} -> ${c.newCwd}  [${c.files.length} jsonl file(s)]`);
      }
      lines.push("");
      return lines;
    },
  };
}

// --- Codex adapter ---------------------------------------------------------

function planCodexSessions(inputs: ProjectMoveInputs): CodexSessionPlanItem[] {
  const root = join(providerHome(inputs, "codex", ".codex"), "sessions");
  if (!existsSync(root)) return [];
  const items: CodexSessionPlanItem[] = [];
  walkRolloutFiles(root, (file) => {
    const cwd = readFirstCwd(file);
    if (cwd === null) return;
    const next = translatePath(cwd, inputs.oldPath, inputs.newPath, inputs.mode);
    if (next === null || next === cwd) return;
    items.push({ file, oldCwd: cwd, newCwd: next });
  });
  return items;
}

function planCodexConfig(inputs: ProjectMoveInputs): CodexConfigPlanItem[] {
  const file = join(providerHome(inputs, "codex", ".codex"), "config.toml");
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
    const next = translatePath(candidate, inputs.oldPath, inputs.newPath, inputs.mode);
    if (next === null || next === candidate) continue;
    const oldHeader = `[projects."${candidate}"]`;
    const newHeader = `[projects."${next}"]`;
    const key = `${oldHeader} ${newHeader}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ file, oldHeader, newHeader });
  }
  return items;
}

function planCodexThreads(inputs: ProjectMoveInputs): CodexThreadsPlanItem[] {
  const dbPath = join(providerHome(inputs, "codex", ".codex"), "state_5.sqlite");
  if (!existsSync(dbPath)) return [];

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
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
      const key = `${oldCwd} ${newCwd}`;
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
      const next = translatePath(row.cwd, inputs.oldPath, inputs.newPath, inputs.mode);
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
        const next = translatePath(row.agent_path, inputs.oldPath, inputs.newPath, inputs.mode);
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

function hasThreadsTable(db: DatabaseSync): boolean {
  try {
    // A miss is `undefined`, not `null` — `node:sqlite` and `bun:sqlite` differ
    // here, and a `!== null` test would call every table-less database a hit.
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
    ).get();
    return row !== undefined;
  } catch {
    return false;
  }
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
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
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath); // read-write
  } catch {
    return 0;
  }
  let updated = 0;
  try {
    const hasAgentPath = hasColumn(db, "threads", "agent_path");
    db.exec("BEGIN");
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
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
  return updated;
}

export function codexProjectMove(): ProviderProjectMove {
  return {
    countRows: [
      { key: "codexSessions", label: "~/.codex/sessions" },
      { key: "codexConfig", label: "~/.codex/config" },
      { key: "codexThreads", label: "~/.codex/state_5" },
    ],

    plan(inputs: ProjectMoveInputs): ProviderMovePlan | null {
      const sessions = planCodexSessions(inputs);
      const config = planCodexConfig(inputs);
      const threads = planCodexThreads(inputs);
      if (sessions.length === 0 && config.length === 0 && threads.length === 0) {
        return null;
      }
      return {
        provider: "codex",
        label: "Codex",
        counts: {
          codexSessions: sessions.length,
          codexConfig: config.length,
          codexThreads: threads.reduce((n, t) => n + t.ids.length, 0),
        },
        payload: { sessions, config, threads } satisfies CodexMovePayload,
      };
    },

    apply(plan: ProviderMovePlan): ProviderMoveCounts {
      const { sessions, config, threads } = plan.payload as CodexMovePayload;

      for (const item of sessions) {
        rewriteCwdInJsonl(item.file, item.oldCwd, item.newCwd);
      }

      // Group codex config items by file so we read+write each file once.
      const configByFile = new Map<string, CodexConfigPlanItem[]>();
      for (const item of config) {
        const arr = configByFile.get(item.file) ?? [];
        arr.push(item);
        configByFile.set(item.file, arr);
      }
      let codexConfig = 0;
      for (const [file, items] of configByFile) {
        rewriteCodexConfig(file, items);
        codexConfig += items.length;
      }

      // Group codex threads by db path; each DB gets one open + one transaction
      // covering every bucket (we never have more than one DB in practice, but
      // grouping keeps the structure honest).
      const threadsByDb = new Map<string, CodexThreadsPlanItem[]>();
      for (const item of threads) {
        const arr = threadsByDb.get(item.dbPath) ?? [];
        arr.push(item);
        threadsByDb.set(item.dbPath, arr);
      }
      let codexThreads = 0;
      for (const [dbPath, items] of threadsByDb) {
        codexThreads += applyCodexThreads(dbPath, items);
      }

      return { codexSessions: sessions.length, codexConfig, codexThreads };
    },

    renderText(plan: ProviderMovePlan): readonly string[] {
      const { sessions, config, threads } = plan.payload as CodexMovePayload;
      const lines: string[] = [];
      if (sessions.length > 0) {
        lines.push("~/.codex/sessions:");
        for (const c of sessions) {
          lines.push(`  ${c.file}`);
          lines.push(`       cwd ${c.oldCwd} -> ${c.newCwd}`);
        }
        lines.push("");
      }
      if (config.length > 0) {
        lines.push("~/.codex/config.toml:");
        for (const c of config) {
          lines.push(`  ${c.oldHeader} -> ${c.newHeader}`);
        }
        lines.push("");
      }
      if (threads.length > 0) {
        lines.push("~/.codex/state_5.sqlite (threads):");
        for (const t of threads) {
          lines.push(`  ${t.dbPath}`);
          lines.push(`       cwd ${t.oldCwd} -> ${t.newCwd}  [${t.ids.length} thread(s)]`);
        }
        lines.push("");
      }
      return lines;
    },
  };
}
