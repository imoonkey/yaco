import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** The Vitest half of the dual-run cohorts (design §5 stage 2).
 *
 *  `test/cohorts.mjs` decides which files land here — a file joins this cohort
 *  by importing `vitest`, and the Bun cohort by importing `bun:test`. This
 *  config only has to describe how the files that arrived should run.
 */
export default defineConfig({
  resolve: {
    alias: {
      // See test/helpers/bun-sqlite-stub.ts. Removed by cli-sqlite-hop.
      "bun:sqlite": fileURLToPath(new URL("./test/helpers/bun-sqlite-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.{test,integration}.ts"],
    // Many files build a sandbox out of process-wide state — cwd, PATH, HOME,
    // YACO_HOME. One process per file is what keeps that honest.
    isolate: true,
    // The suite spawns the CLI, git, and tmux; the slowest files are minutes of
    // real subprocess work under load, not milliseconds of assertion.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
