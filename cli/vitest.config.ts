import { configDefaults, defineConfig } from "vitest/config";

/** The suite runs on Vitest, and the two suites are one directory apart:
 *  everything under `test/integration/` needs an installed binary and real
 *  tmux/git/provider processes, everything else does not.
 *
 *  That split used to live in `test/cohorts.mjs`, which also had to decide which
 *  *runner* owned a file. `cli-sqlite-hop` moved the last database fixtures off
 *  `bun:test`, so there is one runner again and the split is just two projects.
 */
const shared = {
  // The suite spawns the CLI as `dist/yaco.mjs`, so the bundle is a test input
  // and has to be rebuilt before anything reads it — including a focused run.
  globalSetup: ["./test/build-bundle.setup.ts"],
  // Many files build a sandbox out of process-wide state — cwd, PATH, HOME,
  // YACO_HOME. One process per file is what keeps that honest.
  isolate: true,
  // The suite spawns the CLI, git, and tmux; the slowest files are minutes of
  // real subprocess work under load, not milliseconds of assertion.
  testTimeout: 120_000,
  hookTimeout: 120_000,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          // Both extensions, so a stray `*.integration.ts` outside the
          // integration tree lands in a suite rather than in none.
          include: ["test/**/*.{test,integration}.ts"],
          exclude: [...configDefaults.exclude, "test/integration/**"],
        },
      },
      {
        test: {
          ...shared,
          name: "integration",
          include: ["test/integration/**/*.{test,integration}.ts"],
          // Sequential. These files share the machine — tmux, git, the
          // installed binary — and one of them runs `tools/install.sh`, whose
          // `prepack` deletes and rebuilds `dist/` under every other file's
          // feet. Isolation between processes does not help when the contended
          // resource is the filesystem.
          fileParallelism: false,
        },
      },
    ],
  },
});
