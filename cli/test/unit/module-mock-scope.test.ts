/** Guard: no test file may reach for bun's module-mock registry.
 *
 *  The hazard it was written against is gone with the runner. `bun test` ran a whole
 *  cohort in one process over a process-global mock registry that `mock.restore()` does
 *  not undo, so one registration changed what every later-loaded file imported, following
 *  filesystem traversal order — that is how `hooks-install.test.ts` inherited a stubbed
 *  `lifecycle.ts` under `/tmp` and `tmux.test.ts` a partial `tmux.ts` on the GitHub runner.
 *  `vi.mock` is file-scoped by construction, one process per file.
 *
 *  The guard outlives the hazard because the call is still writable. A file carried in from
 *  the bun era would fail on its unresolvable `bun:test` import, which says nothing about
 *  what was actually wrong with it. This says it.
 *
 *  The scan is deliberately literal — no comment stripping, no lexing. Anything that
 *  parses TypeScript to decide what "counts" can be fooled into a false negative by a
 *  string holding a comment marker; a plain substring scan can only over-report, and a
 *  file that merely names the call in prose can reword it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const TEST_ROOT = join(import.meta.dirname, "..");

/** Escaped so this guard does not match its own source. */
const REGISTRATION = /mock\.module\(/;

describe("module mocks stay file-scoped", () => {
  it("no test file registers a process-global module mock", () => {
    const offenders = readdirSync(TEST_ROOT, { recursive: true, encoding: "utf-8" })
      .map(entry => join(TEST_ROOT, entry))
      .filter(path => path.endsWith(".ts"))
      .filter(path => REGISTRATION.test(readFileSync(path, "utf-8")))
      .map(path => relative(TEST_ROOT, path));

    expect(offenders).toEqual([]);
  });
});
