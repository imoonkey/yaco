/** Hermetic sandbox for the golden matrix.
 *
 *  Every case runs against a freshly built sandbox so a capture depends on
 *  nothing but this file: `$HOME`, `$YACO_HOME`, and a `$PATH` holding one empty
 *  directory — `which tmux` and the provider-CLI probes therefore fail the same
 *  way on every machine, which keeps liveness resolution off the process table.
 *
 *  Session state files, Claude project logs, and task rows are written in a
 *  DELIBERATELY non-alphabetical order: five sessions and three project logs, so
 *  no single-row surface can agree by accident. A directory read returns them in
 *  some filesystem-chosen order that is not ascending, which is precisely the
 *  delta the ordering prerequisite has to make visible — on a filesystem that
 *  did return them ascending there would be no undefined order to fix. */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeClaudeCwd } from "../../src/lib/core/project/encode.ts";

export interface Sandbox {
  /** Realpath'd sandbox root — the redaction key. */
  root: string;
  home: string;
  yacoHome: string;
  /** Registered project roots, by registry name. */
  projects: Record<"alpha" | "beta", string>;
  /** Env for a CLI child. Built from scratch: the capturing process's own
   *  YACO_* / provider variables must never leak into a golden run. */
  env: Record<string, string>;
}

/** Session state files, in write order. Alphabetical order is
 *  `alpha-1, beta-4, kappa-5, mid-2, zeta-3` — deliberately different. */
const SESSIONS = [
  { handle: "zeta-3", project: "alpha", provider: "claude", sessionId: "33333333-3333-4333-8333-333333333333", status: "idle", pid: 424203 },
  { handle: "alpha-1", project: "alpha", provider: "claude", sessionId: "11111111-1111-4111-8111-111111111111", status: "idle", pid: 424201 },
  { handle: "mid-2", project: "beta", provider: "codex", sessionId: "0198c0de-2222-4222-8222-222222222222", status: "idle", pid: 424202 },
  { handle: "beta-4", project: "alpha", provider: "claude", sessionId: "22222222-2222-4222-8222-222222222222", status: "crashed", pid: 424204, exitCode: 1 },
  { handle: "kappa-5", project: "beta", provider: "claude", sessionId: "pending", status: "starting", pid: 424205 },
] as const;

/** Claude project logs under project `alpha`, in write order. `1111…` and
 *  `2222…` share `modified`, so the newest-first history sort has a genuine tie
 *  that only an explicit tie break can resolve. */
const CLAUDE_LOGS = [
  { sessionId: "33333333-3333-4333-8333-333333333333", indexed: true, modified: "2026-06-01T10:00:00.000Z", prompt: "third session prompt" },
  { sessionId: "11111111-1111-4111-8111-111111111111", indexed: true, modified: "2026-06-01T11:00:00.000Z", prompt: "first session prompt" },
  { sessionId: "22222222-2222-4222-8222-222222222222", indexed: false, modified: "2026-06-01T11:00:00.000Z", prompt: "second session prompt" },
] as const;

const CREATED = "2026-06-01T09:00:00.000Z";

/** Task-graph rows, in write order; ascending order is t-alfa, t-mike, t-zulu. */
const TASKS = {
  "t-zulu": { parent: null, depends: [], state: "ready", workset: "active", title: "Zulu" },
  "t-mike": { parent: null, depends: ["t-zulu"], state: "active", workset: "active", title: "Mike" },
  "t-alfa": { parent: null, depends: [], state: "done", workset: "archive", title: "Alfa" },
};

/** One Claude JSONL: a user prompt, an end_turn assistant reply carrying a usage
 *  record. Timestamps are literals so `stat` never reaches the output — a golden
 *  capture must not encode when it ran. */
function claudeLog(prompt: string, modified: string, cwd: string): string {
  return [
    JSON.stringify({ type: "user", cwd, timestamp: CREATED, message: { content: prompt } }),
    JSON.stringify({
      type: "assistant",
      timestamp: modified,
      message: {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 5 },
      },
    }),
    "",
  ].join("\n");
}

export function buildSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yaco-golden-")));
  const home = join(root, "home");
  const yacoHome = join(root, "yaco");
  const bin = join(root, "bin");
  const projects = { alpha: join(root, "work", "alpha"), beta: join(root, "work", "beta") };

  for (const dir of [home, yacoHome, bin, projects.alpha, projects.beta]) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(
    join(yacoHome, "projects.json"),
    JSON.stringify([
      { id: "alpha", path: projects.alpha },
      { id: "beta", path: projects.beta },
    ]),
  );

  const sessionsDir = join(yacoHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  for (const s of SESSIONS) {
    writeFileSync(
      join(sessionsDir, `${s.handle}.json`),
      JSON.stringify({
        handle: s.handle,
        provider: s.provider,
        sessionPath: projects[s.project],
        pid: s.pid,
        sessionId: s.sessionId,
        status: s.status,
        createdAt: CREATED,
        statusEnteredAt: CREATED,
        spawnedBy: "user:terminal",
        ...("exitCode" in s ? { exitCode: s.exitCode } : {}),
      }),
    );
  }

  const tasksDir = join(root, "plan", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify(TASKS));

  const claudeProjectDir = join(home, ".claude", "projects", encodeClaudeCwd(projects.alpha));
  mkdirSync(claudeProjectDir, { recursive: true });
  for (const log of CLAUDE_LOGS) {
    writeFileSync(join(claudeProjectDir, `${log.sessionId}.jsonl`), claudeLog(log.prompt, log.modified, projects.alpha));
  }
  writeFileSync(
    join(claudeProjectDir, "sessions-index.json"),
    JSON.stringify(
      CLAUDE_LOGS.filter((l) => l.indexed).map((l) => ({
        sessionId: l.sessionId,
        summary: `indexed: ${l.prompt}`,
        gitBranch: "main",
        created: CREATED,
        modified: l.modified,
      })),
    ),
  );

  return {
    root,
    home,
    yacoHome,
    projects,
    env: { HOME: home, YACO_HOME: yacoHome, PATH: bin, NO_COLOR: "1", TZ: "UTC", LANG: "C" },
  };
}
