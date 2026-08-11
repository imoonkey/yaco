/** Directory ordering is defined, not incidental.
 *
 *  Each reader is exercised over a directory built BOTH ascending and descending,
 *  with enough entries that a single-row fixture could not pass by accident:
 *  whichever way a directory read leans, one of the two builds has to be
 *  reordered before the reader can answer in ascending order.
 *
 *  The exception is a filesystem that enumerates lexicographically no matter how
 *  a directory was built. There these assertions hold without the readers doing
 *  any work — but there the readers have no undefined order to fix either, and
 *  the same suite run anywhere else catches the regression. The proof that
 *  ordering actually changed lives in `test/golden/ordering-delta.test.ts`, which
 *  compares two committed artifacts and reads no directory at all.
 *
 *  The golden matrix pins the same behavior end to end; these pin it per reader,
 *  so a failure names the reader that regressed. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeClaudeCwd } from "../../../../src/lib/core/project/encode.ts";
import { claudeHistory, finalizeHistory } from "../../../../src/lib/core/agent/providers/history.ts";
import { listByPath, listStateHandles } from "../../../../src/lib/core/agent/session-state.ts";
import type { HistorySession } from "../../../../src/lib/core/agent/providers/types.ts";

const HANDLES = ["zeta-3", "alpha-1", "mid-2", "beta-4", "kappa-5"];
const ASCENDING = [...HANDLES].sort();
const DESCENDING = [...ASCENDING].reverse();
/** The two write orders every enumeration case is run under. */
const WRITE_ORDERS: [string, string[]][] = [["ascending", ASCENDING], ["descending", DESCENDING]];

let sandbox: string;
const saved = { ...process.env };

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-ordering-"));
  process.env["HOME"] = join(sandbox, "home");
  process.env["YACO_HOME"] = join(sandbox, "yaco");
  process.env["YACO_AGENT_SESSIONS_DIR"] = join(sandbox, "sessions");
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(sandbox, { recursive: true, force: true });
});

function writeSessions(sessionPath: string, writeOrder: string[]): void {
  const dir = process.env["YACO_AGENT_SESSIONS_DIR"]!;
  mkdirSync(dir, { recursive: true });
  for (const handle of writeOrder) {
    writeFileSync(
      join(dir, `${handle}.json`),
      JSON.stringify({
        handle,
        provider: "claude",
        sessionPath,
        pid: 1,
        sessionId: `id-${handle}`,
        status: "idle",
        createdAt: "2026-06-01T09:00:00.000Z",
      }),
    );
  }
}

describe("session-state enumeration", () => {
  for (const [label, writeOrder] of WRITE_ORDERS) {
    it(`lists handles in ascending order when written ${label}`, () => {
      writeSessions("/work/alpha", writeOrder);
      expect(listStateHandles()).toEqual(ASCENDING);
    });

    it(`lists sessions under a path in ascending handle order when written ${label}`, () => {
      writeSessions("/work/alpha", writeOrder);
      expect(listByPath("/work/alpha").map((s) => s.handle)).toEqual(ASCENDING);
    });
  }
});

describe("claude project-log enumeration", () => {
  const IDS = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];

  for (const [label, writeOrder] of [
    ["ascending", IDS],
    ["descending", [...IDS].reverse()],
  ] as [string, string[]][]) {
    it(`returns history rows in ascending session-id order when written ${label}`, async () => {
      const projectPath = join(sandbox, "work", "alpha");
      const projectDir = join(process.env["HOME"]!, ".claude", "projects", encodeClaudeCwd(projectPath));
      mkdirSync(projectDir, { recursive: true });
      for (const id of writeOrder) {
        writeFileSync(
          join(projectDir, `${id}.jsonl`),
          JSON.stringify({ type: "user", timestamp: "2026-06-01T09:00:00.000Z", message: { content: id } }) + "\n",
        );
      }

      const rows = await claudeHistory().list(projectPath, []);
      expect(rows.map((r) => r.sessionId)).toEqual(IDS);
    });
  }
});

describe("history window tie break", () => {
  function row(sessionId: string, updatedAt: string): HistorySession {
    return {
      sessionId,
      provider: "claude",
      title: null,
      summary: "s",
      created: "2026-06-01T09:00:00.000Z",
      updatedAt,
      tokens: null,
      gitBranch: null,
    };
  }

  it("orders rows sharing an updatedAt by ascending sessionId", () => {
    const tied = "2026-06-01T11:00:00.000Z";
    const window = finalizeHistory(
      [row("c", tied), row("a", tied), row("b", tied), row("z", "2026-06-01T10:00:00.000Z")],
      [],
    );
    expect(window.rows.map((r) => r.sessionId)).toEqual(["a", "b", "c", "z"]);
  });

  it("keeps the window boundary stable when the tie straddles the limit", () => {
    const tied = "2026-06-01T11:00:00.000Z";
    const rows = [row("c", tied), row("a", tied), row("b", tied)];
    const window = finalizeHistory(rows, [], { limit: 2 });
    expect(window.rows.map((r) => r.sessionId)).toEqual(["a", "b"]);
    expect(window.truncated).toBe(true);
  });

  it("ranks rows whose updatedAt does not parse after every real timestamp", () => {
    const window = finalizeHistory(
      [row("c", "not-a-date"), row("a", "not-a-date"), row("b", "2026-06-01T10:00:00.000Z")],
      [],
    );
    expect(window.rows.map((r) => r.sessionId)).toEqual(["b", "a", "c"]);
  });

  it("returns the same order for every permutation of the same rows", () => {
    // A comparator that answers NaN, or that ranks a row differently depending
    // on which row it is asked about, produces a different result per input
    // permutation — the sort's internals, not the data, decide.
    const input = [
      row("a", "2026-06-01T11:00:00.000Z"),
      row("b", "2026-06-01T11:00:00.000Z"),
      row("c", "nonsense"),
      row("d", "2026-06-01T10:00:00.000Z"),
    ];
    const expected = ["a", "b", "d", "c"];
    for (const permutation of permutations(input)) {
      expect(finalizeHistory(permutation, []).rows.map((r) => r.sessionId)).toEqual(expected);
    }
  });
});

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("codex rollout selection", () => {
  const IDS = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  const name = (id: string): string => `rollout-2026-06-01T00-00-00-${id}.jsonl`;
  const SRC = resolve(import.meta.dirname, "../../../../src/lib/core/agent/session-id.ts");

  /** Build a rollout day directory holding one inode under `creationOrder`
   *  names — identical birthtime, so all delays are exactly equal and nothing
   *  but the tie break can decide — then resolve it. */
  function resolveTie(label: string, creationOrder: string[]): unknown {
    const home = join(sandbox, label);
    const dayDir = join(home, ".codex", "sessions", "2026", "06", "01");
    mkdirSync(dayDir, { recursive: true });
    const first = join(dayDir, name(creationOrder[0]!));
    writeFileSync(
      first,
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } }) + "\n",
    );
    for (const id of creationOrder.slice(1)) linkSync(first, join(dayDir, name(id)));

    // session-id.ts resolves the provider home through os.homedir(), which Bun
    // fixes at process start — so the override only takes effect in a child.
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `import { resolveSessionId } from ${JSON.stringify(SRC)};` +
          `console.log(JSON.stringify(resolveSessionId(0, "codex", ${statSync(first).birthtimeMs - 10})));`,
      ],
      { env: { ...process.env, HOME: home }, encoding: "utf-8" },
    );
    expect(run.stderr).toBe("");
    return JSON.parse(run.stdout.trim());
  }

  it("breaks an equal-birthtime tie by ascending rollout path", () => {
    // Both creation orders, because a directory read reflects creation order:
    // whichever way the filesystem leans, one of these two would answer with a
    // different session id if the winner were "whoever was reached first".
    const winner = { sessionId: IDS[0], summary: "hello" };
    expect(resolveTie("ascending", IDS)).toEqual(winner);
    expect(resolveTie("descending", [...IDS].reverse())).toEqual(winner);
  });

  /** Threads-table fallback: `created_at` is second-precision, so two threads
   *  started in the same second tie and only `id` can decide. Rows are inserted
   *  descending so a query that leaned on insertion order would answer with the
   *  other thread. */
  it("breaks an equal-created_at threads tie by ascending id", () => {
    const home = join(sandbox, "db-home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const db = new DatabaseSync(join(home, ".codex", "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, created_at INTEGER)");
    const insert = db.prepare("INSERT INTO threads (id, cwd, created_at) VALUES (?, ?, ?)");
    for (const id of [...IDS].reverse()) {
      insert.run(id, "/work/alpha", 1_780_000_000);
    }
    db.close();

    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `import { resolveSessionId } from ${JSON.stringify(SRC)};` +
          `console.log(JSON.stringify(resolveSessionId(0, "codex", 1_780_000_000_000, "/work/alpha")));`,
      ],
      { env: { ...process.env, HOME: home }, encoding: "utf-8" },
    );

    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout.trim())).toEqual({ sessionId: IDS[0] });
  });
});
