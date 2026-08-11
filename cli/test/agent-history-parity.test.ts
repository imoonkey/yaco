/** The history-read cutover's parity fixture.
 *
 *  The History tab used to answer with a `yaco agent history --path <p> --json`
 *  spawn; it now answers with an in-process `readProjectHistory`. This file pins
 *  that the two mechanisms agree — not by describing the subprocess route, but
 *  by *running* it: `viaSubprocess` spawns the real `bin/yaco.mjs` against the
 *  same hermetic HOME the in-process read gets, and the two payloads are
 *  compared across six windows. The failure envelope is pinned rather than
 *  compared, and the last test says why.
 *
 *  The fixture is deliberately larger than the window in both providers, so the
 *  comparison exercises the cap, the merge across two providers, `--since`, and
 *  the truncation flag rather than a handful of rows that fit either way.
 *
 *  What this can and cannot catch is worth stating, because the suite rebuilds
 *  the bundle from the same source the in-process call imports. It pins the two
 *  *mechanisms* over one implementation: the argv adapter, the JSON envelope,
 *  and — the one genuinely parallel path — where the live sessions come from,
 *  YACO's state files on one side and an explicit argument on the other. It
 *  cannot catch a bug inside the shared read, which is what makes that a
 *  feature: a divergence here would mean a second implementation had appeared.
 *  The shared read's own answers are pinned against an uncapped reference in
 *  `test/history.test.ts`.
 *
 *  Delete this file only when the CLI's `agent history` subprocess surface goes
 *  away — until then it is what makes reverting the cutover a real option. */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runCli } from "./helpers/cli-process.ts";
import { encodeClaudeCwd } from "../src/lib/core/project/encode.ts";
import { readProjectHistory } from "../src/lib/core/agent/providers/history.ts";
import { isErr } from "../src/lib/core/result.ts";
import type { HistoryLiveSession } from "../src/lib/core/agent/providers/history.ts";
import type { HistoryWindow } from "../src/lib/core/agent/providers/types.ts";

const PROJECT = "/tmp/yaco-history-parity-project";
/** More rows than the default window, in both providers, so the cap is live. */
const CLAUDE_SESSIONS = 140;
const CODEX_THREADS = 140;

let sandbox: string;
let env: Record<string, string>;

/** Minute `i` of the fixture day. */
const at = (i: number): string => new Date(Date.UTC(2026, 5, 4, 0, i)).toISOString();
const epochSec = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

type ParityResult =
  | { ok: true; window: HistoryWindow }
  | { ok: false; message: string };

/** The retired route: spawn the real binary, and translate a failure envelope
 *  the way `app/server`'s `runYacoAgentJson` was written to.
 *
 *  "Was written to" and not "did": that helper builds the structured message
 *  inside the same `try` whose `catch` swallows it, so what it actually threw
 *  was the opaque `exit <code>: <stderr>`. The intended translation is used here
 *  because it is the one both sides can be compared on, and because the HTTP
 *  body does not distinguish them — an uncaught route error is
 *  `500 "Internal Server Error"` whichever message it carries. */
function viaSubprocess(args: string[]): ParityResult {
  const r = runCli(["agent", "history", "--path", PROJECT, ...args, "--json"], {
    env: { ...process.env, ...env },
  });
  if (r.status === 0) {
    return { ok: true, window: JSON.parse((r.stdout ?? "").trim()).data as HistoryWindow };
  }
  const tail = (r.stderr ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "";
  const parsed = JSON.parse(tail) as { ok: false; error: { code?: string; message: string } };
  return {
    ok: false,
    message: `yaco agent history failed [${parsed.error.code ?? "INTERNAL"}]: ${parsed.error.message}`,
  };
}

/** The cutover route: the shared read, with the app's failure translation. */
async function inProcess(
  live: readonly HistoryLiveSession[],
  options: { limit?: number; since?: Date } = {},
): Promise<ParityResult> {
  const window = await readProjectHistory(PROJECT, live, options);
  if (isErr(window)) {
    return { ok: false, message: `yaco agent history failed [${window.code}]: ${window.message}` };
  }
  return { ok: true, window: window.value };
}

// -- Fixtures --

function claudeLog(i: number): string {
  return [
    JSON.stringify({ type: "user", timestamp: at(0), message: { content: `claude prompt ${i}` } }),
    JSON.stringify({ type: "custom-title", customTitle: `title ${i}` }),
    JSON.stringify({
      type: "assistant",
      timestamp: at(i),
      message: { usage: { input_tokens: 100 + i, cache_read_input_tokens: 20, output_tokens: 5 } },
    }),
  ].join("\n") + "\n";
}

function buildFixture(): void {
  const claudeDir = join(sandbox, ".claude", "projects", encodeClaudeCwd(PROJECT));
  mkdirSync(claudeDir, { recursive: true });
  const indexed: unknown[] = [];
  for (let i = 0; i < CLAUDE_SESSIONS; i++) {
    const sessionId = `claude-${String(i).padStart(4, "0")}`;
    writeFileSync(join(claudeDir, `${sessionId}.jsonl`), claudeLog(i));
    // Every third session carries index enrichment, and every seventeenth is a
    // sidechain, so the comparison covers both branches of the Claude row.
    if (i % 3 === 0) {
      indexed.push({
        sessionId,
        summary: `indexed summary ${i}`,
        gitBranch: "main",
        created: at(0),
        modified: at(i),
        isSidechain: i % 17 === 0,
      });
    }
  }
  writeFileSync(join(claudeDir, "sessions-index.json"), JSON.stringify({ entries: indexed }));

  const codexDir = join(sandbox, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
  db.exec(
    `CREATE TABLE threads (
       id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT,
       created_at INTEGER, updated_at INTEGER, git_branch TEXT,
       cwd TEXT, archived INTEGER DEFAULT 0, rollout_path TEXT
     )`,
  );
  const insert = db.prepare(
    `INSERT INTO threads (id, title, first_user_message, created_at, updated_at, git_branch, cwd, archived, rollout_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const names: string[] = [];
  for (let i = 0; i < CODEX_THREADS; i++) {
    const id = `codex-${String(i).padStart(4, "0")}`;
    const rollout = join(codexDir, `rollout-${id}.jsonl`);
    writeFileSync(rollout, JSON.stringify({
      type: "event_msg",
      payload: { info: { last_token_usage: { total_tokens: 1000 + i } } },
    }) + "\n");
    // Half the Claude and Codex timestamps interleave, so the merge is real.
    insert.run(id, `codex title ${i}`, `codex prompt ${i}`, epochSec(at(0)), epochSec(at(i)),
      i % 2 === 0 ? "main" : null, PROJECT, i % 23 === 0 ? 1 : 0, rollout);
    if (i % 5 === 0) names.push(JSON.stringify({ id, thread_name: `named ${i}` }));
  }
  db.close();
  writeFileSync(join(codexDir, "session_index.jsonl"), names.join("\n") + "\n");
}

const LIVE: HistoryLiveSession[] = [
  { handle: "live-claude", sessionId: "claude-0100", spawnedBy: "agent", parentSession: "boss" },
  { handle: "live-codex", sessionId: "codex-0099", spawnedBy: "user:web", parentSession: null },
];

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "yaco-history-parity-"));
  const sessionsDir = join(sandbox, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  // The subprocess reads its live sessions from YACO's state files; the
  // in-process call is handed the same two as explicit inputs.
  for (const s of LIVE) {
    writeFileSync(join(sessionsDir, `${s.handle}.json`), JSON.stringify({
      handle: s.handle,
      provider: s.sessionId.startsWith("claude") ? "claude" : "codex",
      sessionPath: PROJECT,
      pid: 1,
      sessionId: s.sessionId,
      status: "idle",
      createdAt: at(0),
      spawnedBy: s.spawnedBy,
      ...(s.parentSession ? { parentSession: s.parentSession } : {}),
    }));
  }
  env = {
    HOME: sandbox,
    YACO_HOME: join(sandbox, ".yaco"),
    YACO_AGENT_SESSIONS_DIR: sessionsDir,
  };
  Object.assign(process.env, env);
  buildFixture();
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("agent history — subprocess and in-process agree", () => {
  const cases: [name: string, argv: string[], options: { limit?: number; since?: Date }][] = [
    ["the default window", [], {}],
    ["a window smaller than either provider holds", ["--limit", "7"], { limit: 7 }],
    ["a window larger than both providers hold", ["--limit", "400"], { limit: 400 }],
    ["--since inside the fixture", ["--since", at(90)], { since: new Date(at(90)) }],
    ["--since below the window boundary", ["--since", at(40)], { since: new Date(at(40)) }],
    [
      "--since and a limit together",
      ["--since", at(100), "--limit", "12"],
      { since: new Date(at(100)), limit: 12 },
    ],
  ];

  for (const [name, argv, options] of cases) {
    it(`returns the same payload for ${name}`, async () => {
      const subprocess = viaSubprocess(argv);
      expect(subprocess.ok, JSON.stringify(subprocess)).toBe(true);
      expect(await inProcess(LIVE, options)).toEqual(subprocess);
    });
  }

  it("returns a non-trivial window, so the comparisons above are not vacuous", () => {
    const subprocess = viaSubprocess([]);
    expect(subprocess.ok).toBe(true);
    if (!subprocess.ok) return;
    expect(subprocess.window.returned).toBe(200);
    expect(subprocess.window.truncated).toBe(true);
    // Both providers, live tagging and durable-origin nulls all reach the window.
    expect(new Set(subprocess.window.rows.map((r) => r.provider))).toEqual(new Set(["claude", "codex"]));
    expect(subprocess.window.rows.filter((r) => r.live).map((r) => r.liveSessionName).sort())
      .toEqual(["live-claude", "live-codex"]);
  });

  it("renders a rejected argument as a structured failure envelope", async () => {
    // USAGE is the only failure the subprocess route can be made to produce
    // here: the readers answer a missing or unreadable provider home with an
    // empty list rather than an error, by design. It is also a failure the
    // in-process caller cannot reach — the app passes no flags — so this pins
    // the envelope the translation reads, not a two-sided comparison.
    const subprocess = viaSubprocess(["--limit", "0"]);
    expect(subprocess).toEqual({
      ok: false,
      message: expect.stringContaining("yaco agent history failed [USAGE]:") as unknown as string,
    });
  });
});
