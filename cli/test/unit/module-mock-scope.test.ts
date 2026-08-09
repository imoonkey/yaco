/** Guard: no test file may register a process-global module mock.
 *
 *  `bun test` runs the whole suite in one process, `mock.module()` is process-global,
 *  and `mock.restore()` does not undo it — so one unscoped registration changes what
 *  every later-loaded file imports, and bun's load order follows filesystem traversal
 *  (i.e. the checkout path). That is how `hooks-install.test.ts` inherited a stubbed
 *  `lifecycle.ts` under `/tmp` and `tmux.test.ts` inherited a partial `tmux.ts` on the
 *  GitHub runner. `helpers/module-mock.ts` is the one place allowed to call it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const TEST_ROOT = join(import.meta.dir, "..");
const HELPER = join(TEST_ROOT, "helpers", "module-mock.ts");

/** Escaped so this guard does not match its own source. */
const DIRECT_CALL = /mock\.module\(/;

/** Source with `//` line comments and block comments blanked out. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("module mocks stay file-scoped", () => {
  it("no test file registers a module mock outside helpers/module-mock.ts", () => {
    const offenders = readdirSync(TEST_ROOT, { recursive: true, encoding: "utf-8" })
      .map(entry => join(TEST_ROOT, entry))
      .filter(path => path.endsWith(".ts") && path !== HELPER)
      .filter(path => DIRECT_CALL.test(stripComments(readFileSync(path, "utf-8"))))
      .map(path => relative(TEST_ROOT, path));

    expect(offenders).toEqual([]);
  });
});
