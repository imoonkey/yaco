/** File-scoped module mocking for `bun test`.
 *
 *  `bun test` runs the whole suite in one process and `mock.module()` writes to a
 *  process-global registry that `mock.restore()` does not undo. A bare top-level
 *  `mock.module()` therefore stays installed for every file bun loads afterwards,
 *  and bun's file order is filesystem-traversal order — so which files see the mock
 *  depends on the checkout path. Use this helper instead; never call `mock.module()`
 *  directly (`test/unit/module-mock-scope.test.ts` enforces that).
 */
import { afterAll, beforeAll, mock } from "bun:test";
import { join } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "..", "src");

/**
 * Replace a `cli/src` module's exports for the calling test file only.
 *
 * Registers the mock in `beforeAll` and re-registers the module's real exports in
 * `afterAll`, so no other test file can observe it whatever order bun picks. Modules
 * the file already imported still pick the mock up: ESM named imports are live
 * bindings and bun updates the module's exports in place.
 *
 * The replacement merges, as bun's own `mock.module()` does: an export the factory omits
 * keeps its real implementation. So a factory covering part of a module leaves the rest
 * live — list every export the code under test reaches, or it will run for real.
 *
 * @param srcPath module to mock, relative to `cli/src` (e.g. `"lib/core/agent/tmux.ts"`)
 * @param exports  factory returning the replacement exports
 */
export function mockSrcModule(srcPath: string, exports: () => Record<string, unknown>): void {
  const target = join(SRC_ROOT, srcPath);
  let real: Record<string, unknown>;

  beforeAll(async () => {
    real = { ...(await import(target)) };
    mock.module(target, exports);
  });

  afterAll(() => {
    mock.module(target, () => real);
  });
}
