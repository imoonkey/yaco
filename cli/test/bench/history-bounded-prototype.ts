/** The best in-process history read this cutover could ship — as a prototype,
 *  so the stall verdict is not reached against a straw implementation.
 *
 *  The shipped reader (`src/lib/core/agent/providers/history.ts`) fans out over
 *  *every* row a provider holds for the project and reads them all at once. The
 *  cutover's acceptance asks for **bounded provider scans**, so this prototype
 *  is what "bounded" would mean, applied everywhere it can be:
 *
 *  - the Codex query takes `LIMIT n`, so the rollout tail-reads are capped at
 *    the history window instead of every thread in the project (587 → 200 on
 *    the reference machine, 5,870 → 200 at ten times the size). The merged
 *    top-`n` is a subset of the union of the per-provider top-`n`, so capping
 *    each provider at the window cannot change the result;
 *  - Claude sorts by `mtime` first and reads only the newest `n` logs;
 *  - every fan-out runs in chunks of 8 with a macrotask yield between chunks,
 *    so a queued request is never behind more than one chunk of parsing;
 *  - the origin side index is read with `fs/promises` in the same chunks, not
 *    with the synchronous per-row `readFileSync` the shipped merge uses.
 *
 *  It is a prototype and not a shipped path: it exists to establish an upper
 *  bound on how well the in-process route can behave. If this loses to the
 *  subprocess route, no simpler in-process form wins. */

import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeClaudeCwd } from "../../src/lib/core/project/encode.ts";
import { originPathForSessionId } from "../../src/lib/core/agent/origin.ts";
import type { HistorySession } from "../../src/lib/core/agent/providers/types.ts";

/** Files read at once before the loop is handed back. Eight keeps a chunk's
 *  parsing near a millisecond while still overlapping the reads. */
const CHUNK = 8;
const HEAD_BYTES = 16384;
const TAIL_BYTES = 65536;

function userHome(): string {
  const env = process.env["HOME"];
  return env && env.length > 0 ? env : homedir();
}

/** Run `worker` over `items` `CHUNK` at a time, yielding the loop between
 *  chunks so an already-queued timer or socket is served. */
async function chunked<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(...await Promise.all(items.slice(i, i + CHUNK).map(worker)));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return out;
}

// -- Codex --

interface CodexRow {
  id: string;
  title: string | null;
  first_user_message: string | null;
  created_at: number;
  updated_at: number;
  git_branch: string | null;
  rollout_path: string | null;
}

function epochToISO(epoch: number): string {
  return new Date(epoch < 1e12 ? epoch * 1000 : epoch).toISOString();
}

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

async function tailTokens(path: string | null): Promise<number | null> {
  if (!path) return null;
  try {
    const st = await stat(path);
    if (st.size === 0) return null;
    const len = Math.min(st.size, TAIL_BYTES);
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(len);
      const res = await fh.read(buf, 0, len, st.size - len);
      return parseLastCodexTokens(buf.toString("utf-8", 0, res.bytesRead));
    } finally {
      await fh.close();
    }
  } catch { return null; }
}

export async function boundedCodexList(projectPath: string, limit: number): Promise<HistorySession[]> {
  const cwd = projectPath.replace(/\/+$/, "");
  const dbPath = join(userHome(), ".codex", "state_5.sqlite");
  let rows: CodexRow[];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = db.prepare(
        `SELECT id, title, first_user_message, created_at, updated_at, git_branch, rollout_path
           FROM threads WHERE cwd = ? AND archived = 0
           ORDER BY updated_at DESC, id ASC LIMIT ?`,
      ).all(cwd, limit) as unknown as CodexRow[];
    } finally {
      db.close();
    }
  } catch { return []; }

  return chunked(rows, async (row) => ({
    sessionId: row.id,
    provider: "codex",
    title: null,
    summary: row.first_user_message || "(no prompt)",
    created: epochToISO(row.created_at),
    updatedAt: epochToISO(row.updated_at),
    tokens: await tailTokens(row.rollout_path),
    gitBranch: row.git_branch ?? null,
  }));
}

// -- Claude --

function parseLastTitle(text: string): string | null {
  let title: string | null = null;
  for (const line of text.split("\n")) {
    if (!line || !line.includes("custom-title")) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "custom-title" && entry.customTitle) title = entry.customTitle;
    } catch { /* partial line at a read boundary */ }
  }
  return title;
}

function parseLastClaudeTokens(text: string): number | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"usage"')) continue;
    try {
      const o = JSON.parse(line) as { message?: { usage?: Record<string, unknown> } };
      const u = o.message?.usage;
      if (!u || typeof u["output_tokens"] !== "number") continue;
      const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
      const total = n("input_tokens") + n("cache_creation_input_tokens") +
        n("cache_read_input_tokens") + n("output_tokens");
      return total > 0 ? total : null;
    } catch { continue; }
  }
  return null;
}

export async function boundedClaudeList(projectPath: string, limit: number): Promise<HistorySession[]> {
  const dir = join(userHome(), ".claude", "projects", encodeClaudeCwd(projectPath));
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch { return []; }

  // `stat` is cheap and carries no parsing, so the window can be chosen before
  // any log is opened — that is what caps the expensive work at `limit`.
  const stats = await chunked(files, async (file) => {
    try {
      const st = await stat(join(dir, file));
      return { file, mtime: st.mtime.getTime(), size: st.size, birth: (st.birthtime ?? st.ctime).toISOString() };
    } catch { return null; }
  });
  const window = stats
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : 1))
    .slice(0, limit);

  return chunked(window, async (entry) => {
    const sessionId = entry.file.replace(/\.jsonl$/, "");
    let title: string | null = null;
    let tokens: number | null = null;
    try {
      const fh = await open(join(dir, entry.file), "r");
      try {
        const headBuf = Buffer.alloc(HEAD_BYTES);
        const headRes = await fh.read(headBuf, 0, Math.min(HEAD_BYTES, entry.size), 0);
        const head = headBuf.toString("utf-8", 0, headRes.bytesRead);
        let endText = head;
        if (entry.size > HEAD_BYTES) {
          const len = Math.min(entry.size, TAIL_BYTES);
          const tailBuf = Buffer.alloc(len);
          const tailRes = await fh.read(tailBuf, 0, len, entry.size - len);
          endText = tailBuf.toString("utf-8", 0, tailRes.bytesRead);
        }
        title = parseLastTitle(endText) ?? parseLastTitle(head);
        tokens = parseLastClaudeTokens(endText);
      } finally {
        await fh.close();
      }
    } catch { /* unreadable log */ }
    return {
      sessionId,
      provider: "claude",
      title,
      summary: "(no prompt)",
      created: entry.birth,
      updatedAt: new Date(entry.mtime).toISOString(),
      tokens,
      gitBranch: null,
    } satisfies HistorySession;
  });
}

// -- merge --

/** Origin lookup for the window, asynchronous and chunked — the shipped merge
 *  does this with `existsSync` + `readFileSync` once per row. */
async function readOrigins(sessionIds: readonly string[]): Promise<Map<string, unknown>> {
  const found = new Map<string, unknown>();
  await chunked(sessionIds, async (sessionId) => {
    const path = originPathForSessionId(sessionId);
    if (!path) return;
    try {
      found.set(sessionId, JSON.parse(await readFile(path, "utf-8")));
    } catch { /* no origin record */ }
  });
  return found;
}

export async function boundedHistory(projectPath: string, limit: number): Promise<HistorySession[]> {
  const perProvider = await Promise.all([
    boundedClaudeList(projectPath, limit),
    boundedCodexList(projectPath, limit),
  ]);
  const sorted = perProvider.flat().sort((a, b) => {
    const at = new Date(a.updatedAt).getTime();
    const bt = new Date(b.updatedAt).getTime();
    if (at !== bt) return bt - at;
    return a.sessionId < b.sessionId ? -1 : 1;
  }).slice(0, limit);
  await readOrigins(sorted.map((r) => r.sessionId));
  return sorted;
}
