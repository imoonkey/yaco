/** Guard: no test file may register a process-global module mock.
 *
 *  `bun test` runs its whole cohort in one process, bun's module-mock registry is
 *  process-global, and `mock.restore()` does not undo a registration — so one
 *  registration changes what every later-loaded file in that cohort imports, and bun's
 *  load order follows filesystem traversal (i.e. the checkout path). That is how
 *  `hooks-install.test.ts` inherited a stubbed `lifecycle.ts` under `/tmp` and
 *  `tmux.test.ts` inherited a partial `tmux.ts` on the GitHub runner.
 *
 *  The Vitest cohort has no such hazard: `vi.mock` is file-scoped by construction, one
 *  process per file. Every former `mock.module` user now uses it, so the scoping helper
 *  this guard used to exempt is gone and the rule is simply *never* — for as long as any
 *  file still runs under bun.
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
