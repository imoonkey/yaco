import { configDefaults, defineConfig } from 'vitest/config'

/** Two projects, one directory apart: everything under `test/integration/`
 *  needs the packages actually built, packed and installed, everything else
 *  runs against the source tree. Same split `cli/vitest.config.ts` draws, for
 *  the same reason — one suite is seconds of assertions, the other is minutes
 *  of npm and native compilation, and a developer should be able to run the
 *  first without paying for the second.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // Tests sit beside their subject in `src/**/__tests__/` and, for a
          // few older ones, in `test/`.
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'test/integration/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // A clean-prefix `npm install` compiles node-pty from source on
          // Linux; the packing step ahead of it runs a full UI build.
          testTimeout: 900_000,
          hookTimeout: 900_000,
          // These files pack the workspaces, and `prepack` deletes and rebuilds
          // `dist/` and `ui/` under any sibling doing the same.
          fileParallelism: false,
        },
      },
    ],
  },
})
