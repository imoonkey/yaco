/** The published bundle: one esbuild pass over the server, with the manifest
 *  deciding what stays outside it.
 *
 *  The rule is one line and lives nowhere else: **a declared dependency is
 *  external, everything else is inlined.** Externals are read from
 *  `package.json` rather than spelled out in a flag so the two cannot drift —
 *  a dependency added without a matching flag would otherwise be silently
 *  inlined, and its native or lazily-`import()`ed pieces do not survive that.
 *  `@yaco/codex-transcribe` is inlined precisely *by not being a dependency*,
 *  which is also the only correct published manifest: it is not published.
 *
 *  Each name is externalised twice. esbuild matches an external entry against
 *  the import path literally, so `hono` alone leaves `hono/cors`, `dotenv/config`
 *  and `@yaco/cli/core/paths` to be bundled — the `/*` sibling is what covers
 *  the subpath exports the server actually imports. Node builtins need no entry;
 *  `platform: "node"` externalises them.
 *
 *  `bundleOptions` is exported because `test/manifest.test.ts` audits the graph
 *  esbuild resolves from *these* options. Auditing a rebuild with different
 *  options would prove nothing about the artifact this file writes.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

const manifest = JSON.parse(readFileSync(at("../package.json"), "utf-8"));

export const OUTFILE = at("../dist/yaco-app.mjs");

export const bundleOptions = {
  entryPoints: [at("../src/index.ts")],
  outfile: OUTFILE,
  // Held in memory rather than written, so the caller decides what to do with
  // a build it has not inspected yet.
  write: false,
  // esbuild reports every path — metafile entries and the `// <path>` label on
  // each inlined module — relative to this directory, which otherwise defaults
  // to the caller's cwd, so the same sources would produce a different bundle
  // depending on where the build was invoked from. Anchored at the monorepo
  // root they read `app/server/src/...` and `packages/codex-transcribe/...`
  // either way.
  absWorkingDir: at("../../../"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // The bundle *is* the `bin` target, so it carries its own shebang.
  banner: { js: "#!/usr/bin/env node" },
  external: [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ].flatMap((name) => [name, `${name}/*`]),
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await build(bundleOptions);
  mkdirSync(dirname(OUTFILE), { recursive: true });
  // Executable because `bin` names this file directly: npm sets the mode on the
  // executables it links, and this keeps it runnable from the checkout too,
  // where nothing links it.
  writeFileSync(OUTFILE, result.outputFiles[0].contents, { mode: 0o755 });
}
