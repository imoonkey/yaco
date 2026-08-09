/** Guard: no test file may register a process-global module mock.
 *
 *  `bun test` runs the whole suite in one process, bun's module-mock registry is
 *  process-global, and `mock.restore()` does not undo a registration — so one unscoped
 *  registration changes what every later-loaded file imports, and bun's load order
 *  follows filesystem traversal (i.e. the checkout path). That is how
 *  `hooks-install.test.ts` inherited a stubbed `lifecycle.ts` under `/tmp` and
 *  `tmux.test.ts` inherited a partial `tmux.ts` on the GitHub runner.
 *  `helpers/module-mock.ts` is the one place allowed to register one.
 *
 *  The scan is deliberately literal — no comment stripping, no lexing. Anything that
 *  parses TypeScript to decide what "counts" can be fooled into a false negative by a
 *  string holding a comment marker; a plain substring scan can only over-report, and a
 *  file that merely names the call in prose can reword it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const TEST_ROOT = join(import.meta.dir, "..");
const HELPER = join(TEST_ROOT, "helpers", "module-mock.ts");

/** Escaped so this guard does not match its own source. */
const REGISTRATION = /mock\.module\(/;

describe("module mocks stay file-scoped", () => {
  it("no test file registers a module mock outside helpers/module-mock.ts", () => {
    const offenders = readdirSync(TEST_ROOT, { recursive: true, encoding: "utf-8" })
      .map(entry => join(TEST_ROOT, entry))
      .filter(path => path.endsWith(".ts") && path !== HELPER)
      .filter(path => REGISTRATION.test(readFileSync(path, "utf-8")))
      .map(path => relative(TEST_ROOT, path));

    expect(offenders).toEqual([]);
  });
});
