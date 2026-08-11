/** Text-render sweep contract (phase 2/3 of the {text} convention).
 *
 *  Every ordinary, result-bearing `yaco` command must render text mode through
 *  a `{text}` (or, for usage, `{help}`) envelope — never a bare object. The
 *  `main.ts` fallback that used to JSON-dump such objects is now a guarded
 *  INTERNAL error, so a stray bare object is a bug, not a silent dump.
 *
 *  ALLOWLIST — the ONLY commands exempt from the `{text}`/`{help}` rule are the
 *  streaming / process-owning ones. They own stdout and call `process.exit()`
 *  before `render()` ever runs, so they never hand a Result to the renderer:
 *    - `agent output-follow`  (NDJSON stream, then exit)
 *    - `align poll`           (status words + own exit codes)
 *    - `doctor` (`env doctor`) (own renderText + process.exit)
 *  These are excluded by construction; this test never dispatches them.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch, renderExitCode, textEnvelope } from "../../src/main.ts";
import { isOk, ok } from "../../src/lib/core/result.ts";
import { ErrCode, exitCodeFor } from "../../src/lib/core/errors.ts";

/** The streaming/process-owning allowlist named in the design. Asserted here so
 *  the contract documents exactly which commands bypass the {text} rule. */
const STREAMING_ALLOWLIST = ["agent output-follow", "align poll", "doctor"] as const;

const TMP: string[] = [];
afterAll(() => {
  for (const d of TMP) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix = "yaco-text-sweep-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TMP.push(d);
  return d;
}

function repoWithTask(): string {
  const root = tempDir();
  const dir = join(root, "plan", "tasks");
  mkdirSync(dir, { recursive: true });
  // A done leaf so archive (terminal-only) and rm both succeed.
  writeFileSync(
    join(dir, "tasks.json"),
    JSON.stringify({
      a: { parent: null, depends: [], state: "done", workset: "active", title: "t", acceptCriteria: ["x"] },
    }),
  );
  return root;
}

/** Dispatch in text mode and assert the value is a `{text}`/`{help}` envelope —
 *  i.e. `textEnvelope` (the exact predicate render() uses) returns a string. */
async function expectTextEnvelope(argv: string[]): Promise<void> {
  const { result, json } = await dispatch(argv);
  expect(json).toBe(false);
  expect(isOk(result)).toBe(true);
  if (isOk(result)) {
    expect(typeof textEnvelope(result.value)).toBe("string");
  }
}

describe("text-render sweep — ordinary commands render {text} in text mode", () => {
  it("paths runtime / project", async () => {
    await expectTextEnvelope(["paths", "runtime"]);
    await expectTextEnvelope(["paths", "project", "--repo", tempDir()]);
  });

  it("agent providers / history / summaries", async () => {
    const path = tempDir();
    await expectTextEnvelope(["agent", "providers"]);
    await expectTextEnvelope(["agent", "history", "--path", path]);
    await expectTextEnvelope(["agent", "summaries", "--path", path]);
  });

  it("agent usage", async () => {
    // Served from a seeded cache so the sweep stays hermetic: no app-server
    // spawn, no network. Both path resolvers read the environment at call
    // time, so pointing them at a temp home is enough.
    const home = tempDir();
    const yacoHome = join(home, ".yaco");
    mkdirSync(join(yacoHome, "cache"), { recursive: true });
    // The cache binds entries to the mtime of the provider's credential file,
    // and refuses to serve any entry when there is no file to bind to.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const credentials = join(home, ".claude", ".credentials.json");
    writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
    writeFileSync(
      join(yacoHome, "cache", "usage-claude.json"),
      JSON.stringify({
        credentialGeneration: statSync(credentials).mtimeMs,
        checkedAt: new Date().toISOString(),
        windows: [{ window: "weekly", percent: 42, resetsAt: "2026-07-30T02:57:02.000Z" }],
      }),
    );
    const restore = { home: process.env["HOME"], yacoHome: process.env["YACO_HOME"] };
    process.env["HOME"] = home;
    process.env["YACO_HOME"] = yacoHome;
    try {
      await expectTextEnvelope(["agent", "usage", "claude"]);
    } finally {
      process.env["HOME"] = restore.home;
      process.env["YACO_HOME"] = restore.yacoHome;
    }
  });

  it("task set / validate / attach / detach / archive / rm", async () => {
    const repo = repoWithTask();
    await expectTextEnvelope([
      "task", "set", "b",
      "--data", '{"title":"t","description":"d","acceptCriteria":["x"]}',
      "--repo", repo,
    ]);
    await expectTextEnvelope(["task", "validate", "--repo", repo]);
    await expectTextEnvelope(["task", "attach", "a", "sess-1", "--repo", repo]);
    await expectTextEnvelope(["task", "detach", "a", "sess-1", "--repo", repo]);
    await expectTextEnvelope(["task", "archive", "a", "--repo", repo]);
    await expectTextEnvelope(["task", "rm", "a", "--repo", repo]);
  });

  it("init links", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "CLAUDE.md"), "# project\n");
    await expectTextEnvelope(["init", "links", "--cwd", dir]);
  });
});

describe("fallback guard — a bare object in text mode is an INTERNAL error", () => {
  it("textEnvelope recognizes {text} and {help}, rejects bare objects", () => {
    expect(textEnvelope({ text: "hi" })).toBe("hi");
    expect(textEnvelope({ help: "usage" })).toBe("usage");
    expect(textEnvelope({ handle: "x", state: {} })).toBeUndefined();
    expect(textEnvelope(undefined)).toBeUndefined();
  });

  it("renderExitCode flags an unrendered text-mode result as INTERNAL", () => {
    // A success Result carrying a bare object in text mode — the exact shape the
    // old JSON-dump fallback used to swallow — now resolves to the INTERNAL code.
    expect(renderExitCode(ok({ bare: true }), false)).toBe(exitCodeFor(ErrCode.INTERNAL));
    // A proper {text} envelope, and any --json result, exit 0.
    expect(renderExitCode(ok({ text: "ok\n" }), false)).toBe(0);
    expect(renderExitCode(ok({ bare: true }), true)).toBe(0);
  });

  it("the streaming/process-owning allowlist is exactly the three documented commands", () => {
    expect([...STREAMING_ALLOWLIST]).toEqual(["agent output-follow", "align poll", "doctor"]);
  });
});
