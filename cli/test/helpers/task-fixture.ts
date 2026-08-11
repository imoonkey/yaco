/** The task trees the read-path baseline is frozen against.
 *
 *  One builder, used by both the parity test and the script that captured
 *  `test/fixtures/task-list-baseline.json` from the pre-cutover CLI. If the two
 *  built their trees separately the golden would stop describing the tree the
 *  test runs on, which is the failure mode a frozen baseline exists to avoid.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Every scenario the baseline pins: one healthy graph and one per failure the
 *  read can produce. */
export const FIXTURE_KINDS = [
  "graph",
  "empty",
  "malformed",
  "array",
  "duplicate",
  "absoluteTasksPath",
  "brokenToml",
  "unreadableDirs",
  "duplicateBeforeMalformed",
] as const;

export type FixtureKind = (typeof FIXTURE_KINDS)[number];

/** Directories `unreadableDirs` walls off. The caller restores their modes. */
export const WALLED_DIRS = ["plan/tasks/a/deep", "plan/tasks/b"];

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function graph(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Populate `root` for one scenario. Deterministic: same bytes every time, so
 *  the only thing that varies between the frozen capture and a test run is the
 *  temporary root itself. */
export function buildTaskFixture(root: string, kind: FixtureKind): void {
  switch (kind) {
    case "graph":
      // Nesting, every workset, every state, a legacy `agent` to normalize, and
      // a task with no workset at all so the load-time default is pinned too.
      write(root, "plan/tasks/tasks.json", graph({
        milestone: {
          parent: null,
          depends: [],
          state: "running",
          title: "Milestone",
          description: "top of the tree",
          workset: "active",
          agent: "claude",
        },
        legacy: {
          parent: null,
          depends: [],
          state: "ready",
          title: "No workset on disk",
          description: "d",
        },
      }));
      write(root, "plan/tasks/cli/tasks.json", graph({
        shipped: {
          parent: "milestone",
          depends: ["legacy"],
          state: "done",
          title: "Shipped",
          description: "d",
          acceptCriteria: ["one", "two"],
          workset: "archive",
          agents: [" codex ", "codex", ""],
          scope: ["cli/src/**"],
        },
      }));
      write(root, "plan/tasks/app/server/tasks.json", graph({
        queued: {
          parent: "milestone",
          depends: [],
          state: "blocked",
          title: "Queued",
          description: "d",
          workset: "backlog",
          worktree: "queued-slug",
        },
      }));
      return;
    case "empty":
      mkdirSync(join(root, "plan/tasks"), { recursive: true });
      return;
    case "malformed":
      write(root, "plan/tasks/tasks.json", "{ not json");
      return;
    case "array":
      write(root, "plan/tasks/tasks.json", graph([]));
      return;
    case "duplicate": {
      const both = graph({ dup: { parent: null, depends: [], state: "ready" } });
      write(root, "plan/tasks/tasks.json", both);
      write(root, "plan/tasks/other/tasks.json", both);
      return;
    }
    case "absoluteTasksPath":
      write(root, "yaco.toml", '[paths]\ntasks = "/etc"\n');
      return;
    case "brokenToml":
      write(root, "yaco.toml", "[paths\ntasks =\n");
      return;
    case "duplicateBeforeMalformed":
      // A duplicate id in the *first* file by sort order, and a record the
      // canonicalizer cannot touch later in the second. Which of the two the
      // loader reports is decided by whether it normalizes before or after the
      // duplicate check, and the answer is part of the error contract.
      write(root, "plan/tasks/a/tasks.json", graph({
        dup: { parent: null, depends: [], state: "ready", title: "first" },
      }));
      write(root, "plan/tasks/b/tasks.json", graph({
        dup: { parent: null, depends: [], state: "ready", title: "second" },
        bad: null,
      }));
      return;
    case "unreadableDirs":
      // Two unreadable directories at different depths. Which one the loader
      // names is a traversal-order fact, and the baseline is what pins it.
      write(root, "plan/tasks/a/deep/tasks.json", graph({}));
      write(root, "plan/tasks/b/tasks.json", graph({}));
      write(root, "plan/tasks/c/tasks.json", graph({
        readable: { parent: null, depends: [], state: "ready" },
      }));
      for (const dir of WALLED_DIRS) chmodSync(join(root, dir), 0o000);
      return;
  }
}
