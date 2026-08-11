/** Synthetic provider home for the session-summary stall benchmark.
 *
 *  What the summary read pays for is not the number of sessions in a provider
 *  home — it is the *size of the logs belonging to the live ones*. So this
 *  fixture is shaped on the size distribution of a real Claude corpus rather
 *  than on row counts: 1,211 logs, p50 19 KB, p90 1.7 MB, p99 5.0 MB, max
 *  36.6 MB (reference machine, 2026-08-11). A fixture of uniformly small logs
 *  measures a reader that never has to be bounded.
 *
 *  Every log puts its first meaningful user message in the first record, the
 *  way a real session does. That is deliberately the *favourable* case for the
 *  reader under test: it is what makes the whole-file control's cost visible as
 *  pure waste rather than as work the bounded reader also has to do. */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeClaudeCwd } from "../../src/lib/core/project/encode.ts";
import type { SessionState } from "../../src/lib/core/agent/model.ts";

/** Project the fixture's live sessions belong to. */
export const FIXTURE_PROJECT = "/home/bench/workspace/yaco";

export interface FixtureScale {
  /** Live Claude sessions under the project — each with its own log. */
  claudeSessions: number;
  /** Live Codex sessions under the project — each with a thread row + rollout. */
  codexSessions: number;
  /** Rows in the `threads` table overall, so the point query has a real index
   *  to search rather than a handful of rows. */
  codexThreads: number;
}

export const SCALES: Record<string, FixtureScale> = {
  "1": { claudeSessions: 6, codexSessions: 4, codexThreads: 2296 },
  "10": { claudeSessions: 60, codexSessions: 40, codexThreads: 22960 },
};

/** Log sizes in bytes, cycled over the live sessions: the real distribution's
 *  p50/p75/p90/p99/max, so a run of any length includes both the cheap common
 *  case and the log that decides whether the reader is bounded. */
const LOG_SIZES = [19 * 1024, 220 * 1024, 1.7 * 1024 * 1024, 5 * 1024 * 1024, 36.6 * 1024 * 1024]
  .map(Math.round);

/** Deterministic pseudo-random source — a fixture that changes between runs
 *  cannot support a before/after comparison. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A UUID-shaped id, unique in `kind` and `n`: the counter occupies the whole
 *  final group, so no two ids can differ only in a digit the shape truncates. */
function fixtureId(kind: number, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `019d${hex.slice(0, 4)}-${hex.slice(4, 8)}-7101-9b6${kind}-${hex}`;
}

function lorem(bytes: number, next: () => number): string {
  const words = ["refactor", "session", "summary", "provider", "measure", "stall", "label", "commit"];
  let out = "";
  while (out.length < bytes) out += words[Math.floor(next() * words.length)] + " ";
  return out.slice(0, bytes);
}

/** A Claude JSONL of about `bytes`, whose first record is the prompt. */
function claudeLog(bytes: number, label: string, next: () => number): string {
  const lines = [JSON.stringify({ type: "user", message: { content: label } })];
  let size = lines[0]!.length;
  while (size < bytes) {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: lorem(4000, next) }] },
    });
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n") + "\n";
}

/** A Codex rollout of about `bytes`, whose first user block is the prompt. */
function codexRollout(bytes: number, label: string, next: () => number): string {
  const lines = [JSON.stringify({
    type: "response_item",
    payload: { role: "user", content: [{ type: "input_text", text: label }] },
  })];
  let size = lines[0]!.length;
  while (size < bytes) {
    const line = JSON.stringify({
      type: "response_item",
      payload: { role: "assistant", content: [{ type: "output_text", text: lorem(4000, next) }] },
    });
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n") + "\n";
}

/** Codex's own schema and indexes, so the point query's plan matches production. */
const CODEX_SCHEMA = `CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  rollout_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  sandbox_policy TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  has_user_event INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  git_sha TEXT,
  git_branch TEXT,
  git_origin_url TEXT,
  cli_version TEXT NOT NULL DEFAULT '',
  first_user_message TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  recency_at INTEGER NOT NULL DEFAULT 0
)`;

const CODEX_INDEXES = [
  "CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC, id DESC)",
  "CREATE INDEX idx_threads_archived ON threads(archived)",
  "CREATE INDEX idx_threads_archived_cwd_updated_at_ms ON threads(archived, cwd, updated_at DESC, id DESC)",
];

export interface Fixture {
  home: string;
  yacoHome: string;
  projectPath: string;
  /** The live sessions, as the CLI's own state files describe them. */
  sessions: SessionState[];
  bytes: number;
}

/** Build the fixture under `root`, replacing anything already there. */
export function buildFixture(root: string, scale: FixtureScale, seed = 20260811): Fixture {
  rmSync(root, { recursive: true, force: true });
  const home = join(root, "home");
  const yacoHome = join(root, "yaco-home");
  const next = rng(seed);
  const sessions: SessionState[] = [];
  let bytes = 0;

  const state = (handle: string, provider: string, sessionId: string): SessionState => ({
    handle, provider, sessionPath: FIXTURE_PROJECT, pid: 1000 + sessions.length,
    sessionId, status: "idle", createdAt: "2026-08-11T00:00:00.000Z",
  });

  // -- Claude: one log per live session --
  const claudeDir = join(home, ".claude", "projects", encodeClaudeCwd(FIXTURE_PROJECT));
  mkdirSync(claudeDir, { recursive: true });
  for (let i = 0; i < scale.claudeSessions; i++) {
    const id = fixtureId(1, i);
    const content = claudeLog(LOG_SIZES[i % LOG_SIZES.length]!, `claude prompt ${i}`, next);
    writeFileSync(join(claudeDir, `${id}.jsonl`), content);
    bytes += content.length;
    sessions.push(state(`bench-claude-${i}`, "claude", id));
  }

  // -- Codex: a threads table, and a rollout per live session --
  const rolloutDir = join(home, ".codex", "sessions", "2026", "08", "10");
  mkdirSync(rolloutDir, { recursive: true });
  const db = new DatabaseSync(join(home, ".codex", "state_5.sqlite"));
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(CODEX_SCHEMA);
    for (const sql of CODEX_INDEXES) db.exec(sql);
    const insert = db.prepare(
      `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd,
        title, sandbox_policy, approval_mode, first_user_message)
       VALUES (?, ?, ?, ?, 'main', 'openai', ?, ?, 'workspace-write', 'on-request', ?)`,
    );
    db.exec("BEGIN");
    const base = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);
    for (let i = 0; i < scale.codexThreads; i++) {
      const live = i < scale.codexSessions;
      const id = live ? fixtureId(2, i) : fixtureId(3, i);
      const path = join(rolloutDir, `rollout-2026-08-10T00-00-00-${id}.jsonl`);
      // The live rows carry the auto-renamed handle as `title` and an empty
      // `first_user_message` — the real shape on the reference machine, and the
      // one that makes the read fall through to the rollout log.
      insert.run(
        id, path, base + i, base + i,
        live ? FIXTURE_PROJECT : `/home/bench/workspace/other-${i % 40}`,
        live ? `bench-codex-${i}` : `thread ${i}`,
        live ? "" : lorem(120, next),
      );
      if (!live) continue;
      const content = codexRollout(LOG_SIZES[i % LOG_SIZES.length]!, `codex prompt ${i}`, next);
      writeFileSync(path, content);
      bytes += content.length;
      sessions.push(state(`bench-codex-${i}`, "codex", id));
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }

  // -- YACO state files, so the subprocess route enumerates the same sessions --
  const sessionsDir = join(yacoHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  for (const s of sessions) {
    writeFileSync(join(sessionsDir, `${s.handle}.json`), JSON.stringify(s));
  }

  return { home, yacoHome, projectPath: FIXTURE_PROJECT, sessions, bytes };
}
