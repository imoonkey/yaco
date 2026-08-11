/** Read-path parity: the in-process `readTaskList` against the CLI it replaced.
 *
 *  `app/server` stopped spawning `yaco task list --workset all --json` for its
 *  task GET and calls `readTaskList` instead. Two different claims make that a
 *  cutover rather than a rewrite, and both are checked here:
 *
 *  1. **Against the pre-cutover CLI.** `test/fixtures/task-list-baseline.json`
 *     is the envelope every fixture below produced when spawned from the base
 *     commit's build, captured before any of this landed. It is the only
 *     baseline that can catch a regression *inside* the new reader — comparing
 *     the new in-process read to the new spawned CLI cannot, since at this head
 *     they are the same function.
 *  2. **Against the current CLI.** The spawned binary must still agree, which
 *     is what "one shared implementation, not a parallel one" means.
 *
 *  The comparison runs through `JSON.parse(JSON.stringify(...))` on the
 *  in-process side on purpose: that is what the app's `c.json()` does to the
 *  value, so it is the shape a browser actually receives. Key *order* is not
 *  compared — the CLI's `--json` writer sorts keys for stream determinism and
 *  an in-process value keeps file order — but every key and value is.
 */

import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readTaskList } from "../../../src/lib/core/task/index.ts";
import { isErr, type Result } from "../../../src/lib/core/result.ts";
import { CLI_ROOT } from "../../helpers/export-closure.ts";
import { runCli } from "../../helpers/cli-process.ts";
import {
  FIXTURE_KINDS,
  WALLED_DIRS,
  buildTaskFixture,
  type FixtureKind,
} from "../../helpers/task-fixture.ts";

/** Captured from the base commit's build — see the file's own header. */
const BASELINE = JSON.parse(
  readFileSync(resolve(CLI_ROOT, "test/fixtures/task-list-baseline.json"), "utf-8"),
) as Record<string, Record<string, { status: number; envelope: unknown }>>;

/** The invocations the baseline pins, as argv and as the equivalent call. */
const INVOCATIONS = [
  { name: "all", args: ["--workset", "all"], input: { workset: "all" } },
  { name: "default", args: [], input: {} },
  { name: "backlog", args: ["--workset", "backlog"], input: { workset: "backlog" } },
  { name: "archive", args: ["--workset", "archive"], input: { workset: "archive" } },
  {
    name: "state-done",
    args: ["--workset", "all", "--state", "done"],
    input: { workset: "all", state: "done" },
  },
] as const;

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) {
    // The walled fixture has to be reopened before it can be removed.
    for (const dir of WALLED_DIRS) {
      try { chmodSync(join(root, dir), 0o755); } catch { /* not that fixture */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

function fixture(kind: FixtureKind): string {
  const root = mkdtempSync(join(tmpdir(), "yaco-read-parity-"));
  roots.push(root);
  buildTaskFixture(root, kind);
  return root;
}

/** The `{ok,data}` / `{ok,error}` envelope a `Result` renders as — the same
 *  branch `src/main.ts#render` takes, including its omission of an absent
 *  `details`. */
function envelopeOf(result: Result<unknown>): unknown {
  if (!isErr(result)) return { ok: true, data: result.value };
  const error: Record<string, unknown> = { code: result.code, message: result.message };
  if (result.details !== undefined) error["details"] = result.details;
  return { ok: false, error };
}

/** Replace the temporary root with the placeholder the baseline was frozen
 *  with, so absolute paths compare. */
const normalize = (value: unknown, root: string): unknown =>
  JSON.parse(JSON.stringify(value).split(root).join("<ROOT>"));

function spawnList(root: string, args: readonly string[]): { status: number; envelope: unknown } {
  const r = runCli(["task", "list", ...args, "--json"], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: r.status ?? -1,
    envelope: normalize(JSON.parse((r.stdout || r.stderr).trim()), root),
  };
}

describe("readTaskList against the pre-cutover CLI baseline", () => {
  for (const kind of FIXTURE_KINDS) {
    for (const { name, args, input } of INVOCATIONS) {
      it(`${kind} / ${name}: in process and spawned both match the frozen envelope`, async () => {
        const root = fixture(kind);
        const expected = BASELINE[kind]?.[name];
        expect(expected, `no baseline for ${kind}/${name}`).toBeDefined();

        const inProcess = normalize(
          envelopeOf(await readTaskList({ repoRoot: root, ...input })),
          root,
        );
        expect(inProcess).toEqual(expected!.envelope);

        const spawned = spawnList(root, args);
        expect(spawned.envelope).toEqual(expected!.envelope);
        expect(spawned.status).toBe(expected!.status);
      });
    }
  }

  it("pins a non-empty graph, so the comparison is not vacuous", () => {
    const tasks = (BASELINE["graph"]!["all"]!.envelope as { data: { tasks: object } }).data.tasks;
    expect(Object.keys(tasks).length).toBeGreaterThan(1);
  });

  it("pins a failure for every failure fixture", () => {
    for (const kind of ["malformed", "array", "duplicate", "absoluteTasksPath", "brokenToml", "unreadableDirs"]) {
      const envelope = BASELINE[kind]!["all"]!.envelope as { ok: boolean; error?: { code: string } };
      expect(envelope.ok, kind).toBe(false);
      expect(envelope.error?.code, kind).toBeTruthy();
    }
  });
});

describe("readTaskList — behaviour the baseline does not reach", () => {
  it("returns the failure rather than throwing it", async () => {
    // The app must not acquire an unhandled rejection at the moment its
    // subprocess boundary disappears.
    const root = fixture("malformed");
    await expect(readTaskList({ repoRoot: root, workset: "all" })).resolves.toMatchObject({
      ok: false,
      code: "INVALID",
    });
  });

  it("rejects a filter the type system did not stop", async () => {
    // A published entry point is reachable from plain JavaScript.
    const root = fixture("graph");
    for (const bad of [
      { workset: "typo" as "all" },
      { state: "unknown" as "done" },
    ]) {
      const result = await readTaskList({ repoRoot: root, ...bad });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.code).toBe("USAGE");
    }
  });

  it("agrees with the spawned CLI when yaco.toml relocates the task tree", async () => {
    const root = fixture("empty");
    // A relocated tree is a path case the frozen fixtures do not cover.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    writeFileSync(join(root, "yaco.toml"), '[paths]\nplan = "docs"\ntasks = "graph"\n');
    mkdirSync(join(root, "docs/graph"), { recursive: true });
    writeFileSync(
      join(root, "docs/graph/tasks.json"),
      JSON.stringify({ only: { parent: null, depends: [], state: "ready" } }, null, 2) + "\n",
    );

    const inProcess = normalize(
      envelopeOf(await readTaskList({ repoRoot: root, workset: "all" })),
      root,
    );
    expect(inProcess).toEqual(spawnList(root, ["--workset", "all"]).envelope);
    expect((inProcess as { data: { tasks: object } }).data.tasks).toHaveProperty("only");
  });
});
