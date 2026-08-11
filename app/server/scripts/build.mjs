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
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

const manifest = JSON.parse(readFileSync(at("../package.json"), "utf-8"));
const external = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
].flatMap((name) => [name, `${name}/*`]);

const outfile = at("../dist/yaco-app.mjs");

const result = await build({
  entryPoints: [at("../src/index.ts")],
  outfile,
  // Held in memory until the warnings below have been read, so "refusing to
  // emit" leaves no half-trusted bundle behind for the next step to pack.
  write: false,
  // esbuild labels every inlined module with its path relative to this
  // directory, which otherwise defaults to the caller's cwd — so the same
  // sources would produce a different bundle depending on where the build was
  // invoked from. Anchored at the monorepo root, the labels read
  // `app/server/src/...` and `packages/codex-transcribe/...` either way.
  absWorkingDir: at("../../../"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // The bundle *is* the `bin` target, so it carries its own shebang. npm sets
  // the mode on the executables it links; this keeps it runnable from the
  // checkout too, where nothing links it.
  banner: { js: "#!/usr/bin/env node" },
  external,
});

// A warning here is a module esbuild could not follow — an `import(name)` whose
// argument is not a literal being the one that matters, because such an import
// survives into the bundle unresolved and then fails at whatever moment the
// feature behind it is first used, on a consumer's machine. Refusing to emit is
// also what makes the manifest audit in `test/manifest.test.ts` complete: if
// every import must be a literal, scanning for literals sees the whole graph.
if (result.warnings.length > 0) {
  for (const { text, location } of result.warnings) {
    console.error(`build: ${location?.file ?? "?"}:${location?.line ?? "?"} ${text}`);
  }
  console.error(`build: refusing to emit with ${result.warnings.length} warning(s)`);
  process.exit(1);
}

mkdirSync(dirname(outfile), { recursive: true });
// Executable because `bin` names this file directly: npm sets the mode on the
// executables it links, and this keeps it runnable from the checkout too, where
// nothing links it.
writeFileSync(outfile, result.outputFiles[0].contents, { mode: 0o755 });
