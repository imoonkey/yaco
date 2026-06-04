/** Project-move rekey core.
 *
 *  Rewrites cwd-keyed metadata in five storage backends so a project that
 *  moved on disk from `<old>` to `<new>` continues to find its history:
 *
 *   1. `${YACO_HOME}/sessions/*.json` — `sessionPath` field
 *   2. `${YACO_HOME}/projects.json`   — `{id, path}` entries
 *   3. `~/.claude/projects/<encoded>/` — directory rename + JSONL `cwd` rewrite
 *   4. `~/.codex/sessions/<date>/rollout-<id>.jsonl` — `cwd` in `session_meta`
 *   5. `~/.codex/config.toml`         — `[projects."<path>"]` section rename
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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
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

export interface MovePlan {
  oldPath: string;
  newPath: string;
  mode: MatchMode;
  sessions: SessionPlanItem[];
  registry: RegistryPlanItem[];
  claudeProjects: ClaudeProjectPlanItem[];
  codexSessions: CodexSessionPlanItem[];
  codexConfig: CodexConfigPlanItem[];
}

export interface MoveCounts {
  sessions: number;
  registry: number;
  claudeProjects: number;
  codexSessions: number;
  codexConfig: number;
}

export function emptyCounts(): MoveCounts {
  return {
    sessions: 0,
    registry: 0,
    claudeProjects: 0,
    codexSessions: 0,
    codexConfig: 0,
  };
}

export function countsFor(plan: MovePlan): MoveCounts {
  return {
    sessions: plan.sessions.length,
    registry: plan.registry.length,
    claudeProjects: plan.claudeProjects.length,
    codexSessions: plan.codexSessions.length,
    codexConfig: plan.codexConfig.length,
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
  // Use split/join for a literal string replace (no regex DoS surface).
  const next = raw.split(oldLit).join(newLit);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, file);
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
