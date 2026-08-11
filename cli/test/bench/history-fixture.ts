/** Synthetic provider-home fixture for the history stall benchmark.
 *
 *  Builds a `$HOME` whose `.codex` and `.claude` trees are shaped like a real
 *  heavy user's: the row counts, the SQLite schema, the `first_user_message`
 *  length distribution and the rollout tail size are all taken from a real
 *  heavy provider home, so the benchmark reads the same number of bytes through
 *  the same code path it would read in production. `history-stall.ts` can be
 *  pointed at that real home with `--home` to check the fixture still tracks it.
 *
 *  Scale 1 reproduces that machine. Scale 10 is the ten-times tree the design's
 *  concurrency section requires alongside it — a graph is input-controlled, so
 *  no single sample bounds it. */

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeClaudeCwd } from "../../src/lib/core/project/encode.ts";

/** Project the fixture's sessions belong to. Absolute so the Claude directory
 *  encoder and the Codex `cwd` column behave as they do in production. */
export const FIXTURE_PROJECT = "/home/bench/workspace/yaco";

/** Shape of one fixture size, in the units the read path actually pays for. */
export interface FixtureScale {
  /** Rows in the Codex `threads` table across every `cwd`. */
  codexThreads: number;
  /** Of those, the rows whose `cwd` is `FIXTURE_PROJECT`. */
  codexThreadsForProject: number;
  /** Claude JSONL files in the project's `~/.claude/projects/<encoded>` dir. */
  claudeSessions: number;
  /** Files in `$YACO_HOME/agent/origins` — the durable origin side index. */
  originFiles: number;
  /** Records in `~/.codex/session_index.jsonl`.
   *
   *  Its own dimension because the reader splits and scans the **whole** file
   *  regardless of the window, so it is an input the cap does not bound. Getting
   *  this wrong is not hypothetical, and it has now been wrong twice: first the
   *  fixture wrote `min(codexThreadsForProject, 200)` records, which is 200 at
   *  *both* scales; then it wrote the right number of records at 55% of the
   *  measured bytes, because a `named-N` line is a third the length of a real
   *  one. The count and `codexNameBytes` are both pinned for that reason. */
  codexNameRecords: number;
  /** Bytes of `~/.codex/session_index.jsonl`. The reader decodes and splits all
   *  of them, so the byte load is the cost and the record count only shapes it;
   *  records are padded to hit this total. */
  codexNameBytes: number;
}

/** Measured on the reference machine on 2026-08-11: 2,275 Codex threads
 *  (587 for the busiest cwd) in an 11.6 MB `state_5.sqlite`, 81 Claude JSONL
 *  files in the busiest project directory, 1,785 origin records, and a
 *  `session_index.jsonl` of 2,013 records in 266,393 bytes. */
export const SCALES: Record<string, FixtureScale> = {
  "1": {
    codexThreads: 2275, codexThreadsForProject: 587, claudeSessions: 81,
    originFiles: 1785, codexNameRecords: 2013, codexNameBytes: 266_393,
  },
  "10": {
    codexThreads: 22750, codexThreadsForProject: 5870, claudeSessions: 810,
    originFiles: 17850, codexNameRecords: 20130, codexNameBytes: 2_663_930,
  },
};

/** Bytes of rollout tail the read path examines per Codex row. Real rollout
 *  files run to hundreds of KB (p50 349 KB, p95 2.3 MB on the reference
 *  machine); only the last 64 KB is ever read, so the fixture writes just over
 *  that and the read path is byte-identical. */
const ROLLOUT_BYTES = 80 * 1024;
/** Claude JSONL size: the read path takes a 16 KB head and a 64 KB tail. */
const CLAUDE_BYTES = 96 * 1024;

/** Deterministic pseudo-random source — a fixture that changes between runs
 *  cannot support a before/after comparison. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A UUID-shaped id derived from `n`, so ids sort and collide like real ones. */
function fixtureId(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `019d${hex.slice(0, 4)}-${hex.slice(4, 8)}-7101-9b61-${hex.slice(0, 4)}${hex.slice(4)}`;
}

function lorem(bytes: number, next: () => number): string {
  const words = ["refactor", "session", "history", "provider", "measure", "stall", "window", "commit"];
  let out = "";
  while (out.length < bytes) out += words[Math.floor(next() * words.length)] + " ";
  return out.slice(0, bytes);
}

/** Codex rollout JSONL: `last_token_usage` lives in the final lines, which is
 *  where the tail reader scans backwards from. */
function rolloutContent(next: () => number): string {
  const lines: string[] = [];
  let size = 0;
  while (size < ROLLOUT_BYTES) {
    const line = JSON.stringify({
      type: "response_item",
      payload: { role: "user", content: [{ type: "input_text", text: lorem(400, next) }] },
    });
    lines.push(line);
    size += line.length + 1;
  }
  lines.push(JSON.stringify({
    type: "event_msg",
    payload: { info: { last_token_usage: { total_tokens: Math.floor(next() * 200_000) } } },
  }));
  return lines.join("\n") + "\n";
}

/** Claude JSONL: a first user message near the head and a `custom-title` plus
 *  a usage record near the tail — the three records the reader looks for. */
function claudeContent(next: () => number, ts: number): string {
  const lines = [
    JSON.stringify({ type: "user", message: { content: lorem(300, next) }, timestamp: new Date(ts).toISOString() }),
  ];
  let size = lines[0]!.length;
  while (size < CLAUDE_BYTES) {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: new Date(ts).toISOString(),
      message: { content: [{ type: "text", text: lorem(400, next) }] },
    });
    lines.push(line);
    size += line.length + 1;
  }
  lines.push(JSON.stringify({ type: "custom-title", customTitle: `bench title ${Math.floor(next() * 1000)}` }));
  lines.push(JSON.stringify({
    type: "assistant",
    timestamp: new Date(ts).toISOString(),
    message: { usage: { input_tokens: 900, cache_read_input_tokens: 40_000, output_tokens: 700 } },
  }));
  return lines.join("\n") + "\n";
}

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
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  preview TEXT NOT NULL DEFAULT '',
  recency_at INTEGER NOT NULL DEFAULT 0,
  recency_at_ms INTEGER NOT NULL DEFAULT 0
)`;

/** The index set Codex ships, so the benchmark's query plan matches
 *  production's.
 *
 *  The distinction the names carry is load-bearing and was got wrong once: the
 *  composite `cwd` indexes order by the **millisecond** columns, while the read
 *  orders by `updated_at` (seconds), whose only index does not carry `archived`
 *  or `cwd`. So the planner filters through a composite index and sorts the
 *  matches in a temp B-tree — it is *not* an index-prefix scan, and a fixture
 *  index that spelled `updated_at` here would have made the benchmark measure a
 *  plan production does not run. Verify with
 *  `node cli/test/bench/history-stall.ts --sqlite-probe --home ~`, which prints
 *  the plan it measured. */
const CODEX_INDEXES = [
  "CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC, id DESC)",
  "CREATE INDEX idx_threads_updated_at_ms ON threads(updated_at_ms DESC, id DESC)",
  "CREATE INDEX idx_threads_archived ON threads(archived)",
  "CREATE INDEX idx_threads_archived_cwd_updated_at_ms ON threads(archived, cwd, updated_at_ms DESC, id DESC)",
  "CREATE INDEX idx_threads_recency_at_ms ON threads(recency_at_ms DESC, id DESC)",
  "CREATE INDEX idx_threads_archived_cwd_recency_at_ms ON threads(archived, cwd, recency_at_ms DESC, id DESC)",
];

/** `session_index.jsonl` at the scale's measured record count *and* byte size. */
function buildNameIndex(scale: FixtureScale): string {
  const lines: string[] = [];
  for (let i = 0; i < scale.codexNameRecords; i++) {
    // Ids repeat every ninth record, so ~11% of the file is a rename of a name
    // already seen — the shape `loadCodexThreadNames` resolves last-entry-wins.
    const n = i % 9 === 8 ? Math.max(0, i - 8) : i;
    lines.push(JSON.stringify({ id: fixtureId(n % scale.codexThreads), thread_name: `named-${i}` }));
  }
  // Exactly what the return below writes: the join plus the trailing newline.
  const bare = lines.join("\n").length + 1;
  // Spread the shortfall across the names rather than appending filler records:
  // the record count is itself pinned, and padding a name is what a longer real
  // thread name is.
  const shortfall = Math.max(0, scale.codexNameBytes - bare);
  const padPerLine = Math.floor(shortfall / scale.codexNameRecords);
  // The division's remainder goes on the first line, so the file lands on the
  // measured size exactly rather than 1.4% under it. A fixture that is nearly
  // the right size is how the last two versions of this one went wrong.
  const remainder = shortfall - padPerLine * scale.codexNameRecords;
  if (padPerLine + remainder > 0) {
    for (let i = 0; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]!);
      const pad = padPerLine + (i === 0 ? remainder : 0);
      lines[i] = JSON.stringify({ ...entry, thread_name: entry.thread_name + "-".repeat(pad) });
    }
  }
  return lines.join("\n") + "\n";
}

export interface Fixture {
  /** Value for `HOME` — the provider homes hang off it. */
  home: string;
  /** Value for `YACO_HOME` — holds `agent/origins`. */
  yacoHome: string;
  /** Absolute path of the project whose history is read. */
  projectPath: string;
  /** Bytes written, for the report. */
  bytes: { codexDb: number; rollouts: number; claude: number; codexNameIndex: number };
}

/** Build the fixture under `root`, replacing anything already there. */
export function buildFixture(root: string, scale: FixtureScale, seed = 20260811): Fixture {
  rmSync(root, { recursive: true, force: true });
  const home = join(root, "home");
  const yacoHome = join(root, "yaco-home");
  const next = rng(seed);

  // -- Codex: threads table + one rollout file per row --
  const sessionsDir = join(home, ".codex", "sessions", "2026", "08", "10");
  mkdirSync(sessionsDir, { recursive: true });
  const rollout = rolloutContent(next);
  let rolloutBytes = 0;
  const dbPath = join(home, ".codex", "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(CODEX_SCHEMA);
    for (const sql of CODEX_INDEXES) db.exec(sql);
    const insert = db.prepare(
      // The millisecond columns carry the same instant as the second columns, so
      // the composite indexes are populated exactly as production's are and the
      // planner faces the same choice.
      `INSERT INTO threads (id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
        recency_at_ms, source, model_provider, cwd,
        title, sandbox_policy, approval_mode, git_branch, first_user_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'main', 'openai', ?, ?, 'workspace-write', 'on-request', ?, ?)`,
    );
    db.exec("BEGIN");
    const base = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);
    for (let i = 0; i < scale.codexThreads; i++) {
      const id = fixtureId(i);
      const inProject = i < scale.codexThreadsForProject;
      const cwd = inProject ? FIXTURE_PROJECT : `/home/bench/workspace/other-${i % 40}`;
      const path = join(sessionsDir, `rollout-2026-08-10T00-00-00-${id}.jsonl`);
      // Only the project's rows are ever tail-read, so only those get a file.
      if (inProject) {
        writeFileSync(path, rollout);
        rolloutBytes += rollout.length;
      }
      insert.run(
        id,
        path,
        base + i,
        base + i,
        (base + i) * 1000,
        (base + i) * 1000,
        (base + i) * 1000,
        cwd,
        `bench-thread-${i}`,
        i % 3 === 0 ? "main" : `feat/bench-${i % 50}`,
        // Matches the measured mean first_user_message length of ~1.3 KB.
        lorem(600 + Math.floor(next() * 1400), next),
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  // Every record is scanned whatever the window is, so this scales with the
  // fixture rather than with the window, in both dimensions: `codexNameRecords`
  // decides how many lines the split produces, `codexNameBytes` how much text is
  // decoded to get them, and the thread name is padded to reconcile the two.
  //
  // Every ninth record repeats an earlier id, so the reader's last-entry-wins
  // rule is exercised rather than merely described — a real file accumulates a
  // record per rename, and the fixture would otherwise be all-unique.
  const nameIndex = buildNameIndex(scale);
  writeFileSync(join(home, ".codex", "session_index.jsonl"), nameIndex);

  // -- Claude: one JSONL per session plus the optional sessions index --
  const claudeDir = join(home, ".claude", "projects", encodeClaudeCwd(FIXTURE_PROJECT));
  mkdirSync(claudeDir, { recursive: true });
  let claudeBytes = 0;
  const indexEntries: unknown[] = [];
  for (let i = 0; i < scale.claudeSessions; i++) {
    const id = fixtureId(1_000_000 + i);
    const content = claudeContent(next, Date.parse("2026-08-10T00:00:00Z") + i * 60_000);
    writeFileSync(join(claudeDir, `${id}.jsonl`), content);
    claudeBytes += content.length;
    // Roughly half the real sessions carry an index entry.
    if (i % 2 === 0) {
      indexEntries.push({ sessionId: id, gitBranch: "main", created: new Date().toISOString() });
    }
  }
  writeFileSync(join(claudeDir, "sessions-index.json"), JSON.stringify({ entries: indexEntries }));

  // -- YACO origin side index: one small JSON per known provider session --
  const originsDir = join(yacoHome, "agent", "origins");
  mkdirSync(originsDir, { recursive: true });
  for (let i = 0; i < scale.originFiles; i++) {
    const id = fixtureId(i);
    writeFileSync(
      join(originsDir, `${encodeURIComponent(id)}.json`),
      JSON.stringify({
        sessionId: id,
        spawnedBy: "user:web",
        parentSession: null,
        firstHandle: `bench-${i}`,
        createdAt: "2026-08-10T00:00:00.000Z",
      }),
    );
  }

  return {
    home,
    yacoHome,
    projectPath: FIXTURE_PROJECT,
    bytes: {
      codexDb: statSync(dbPath).size,
      rollouts: rolloutBytes,
      claude: claudeBytes,
      codexNameIndex: nameIndex.length,
    },
  };
}
