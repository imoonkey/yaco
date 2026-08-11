/** The manifest against the graph esbuild actually resolves, in both directions.
 *
 *  `scripts/build.mjs` externalises exactly the declared dependencies and
 *  inlines everything else, so the manifest is not documentation — it is the
 *  build's only input for that decision, and both ways of getting it wrong are
 *  silent:
 *
 *  - an import the manifest does not declare is *inlined*, which works in this
 *    monorepo (npm hoists it there for some other package) and ships a copy of
 *    someone else's library inside our bundle. `qrcode-terminal` was exactly
 *    this: a real runtime import, present only because `whatsapp-web.js`'s tree
 *    happened to provide it;
 *  - a declared dependency nothing imports is installed by every consumer for
 *    nothing. `better-sqlite3` was exactly this: 13 MB of native module,
 *    compiled from source on Linux, left behind when the CLI moved its SQLite
 *    reads to `node:sqlite`.
 *
 *  Neither is visible to a test that runs the server, because in a checkout
 *  both resolve. This file is where they are visible.
 *
 *  The audit reads esbuild's own metafile rather than scanning source text: the
 *  question is what ends up in the bundle, and only the resolver knows that.
 *  A `require("picocolors")` inlines a package with no import statement to find
 *  and no warning to catch, and an earlier version of this file — which matched
 *  import specifiers with a regular expression — passed while exactly that
 *  happened. The two escapes the resolver cannot see either, a non-literal
 *  `import(name)` and a `createRequire`, are the last test here; between them
 *  the graph is closed.
 */
import { build, transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { extname, join } from 'node:path'
import { bundleOptions } from '../scripts/build.mjs'

const SERVER_DIR = join(import.meta.dirname, '..')
const REPO_ROOT = join(SERVER_DIR, '../..')
const MANIFEST = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf-8'))

/** The one package the bundle inlines on purpose: an unpublished workspace with
 *  a single consumer (`routes/voice.ts`) and no dependencies of its own, so
 *  publishing it separately would buy nothing. Declaring it would be wrong in
 *  the other direction — a consumer's npm cannot fetch it. */
const INLINED_PREFIX = 'packages/codex-transcribe/'

const BUILTINS = new Set(builtinModules)

/** The package a specifier names, or null for a builtin. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('node:')) return null
  const segments = specifier.split('/')
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!
  return BUILTINS.has(name) ? null : name
}

/** The real build's graph. Paths are relative to `absWorkingDir`, the monorepo
 *  root, so an inlined third-party module reads `node_modules/...`. */
const graph = await build({ ...bundleOptions, metafile: true, write: false })
const inputs = Object.keys(graph.metafile.inputs)
const externals = new Set(
  Object.values(graph.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((imported) => imported.external)
    .map((imported) => packageOf(imported.path))
    .filter((name): name is string => name !== null),
)
const declared = new Set([
  ...Object.keys(MANIFEST.dependencies as Record<string, string>),
  ...Object.keys(MANIFEST.optionalDependencies as Record<string, string>),
])

const LOADERS: Record<string, 'ts' | 'js'> = {
  '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.js': 'js', '.mjs': 'js', '.cjs': 'js',
}

/** What has to follow `import(` in re-printed output for esbuild to have been
 *  able to resolve it: one complete string literal and then the closing paren.
 *  A concatenation, a template, or an identifier all leave something else
 *  there — and esbuild prints each of them back verbatim, having quietly
 *  declined to resolve it. Both quote styles, because the minifier picks
 *  whichever escapes less. */
const LITERAL_ARGUMENT = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/

/** Every file the bundle inlined, re-emitted by esbuild's own parser with
 *  comments and layout gone.
 *
 *  The escapes below are syntax, and syntax cannot be matched against source
 *  *spelling*: `import /* c *​/ (name)` is the same expression as
 *  `import(name)` and a pattern written against the second misses the first.
 *  Minifying through the same parser the build uses normalises every such
 *  variant to one form before anything looks at it. Reading the set from the
 *  metafile rather than from a directory is what extends the check to the
 *  inlined `packages/codex-transcribe` closure, which is equally in the bundle
 *  and was equally unscanned. */
const normalizedInputs = new Map<string, string | null>(
  await Promise.all(
    inputs.map(async (path): Promise<[string, string | null]> => {
      const loader = LOADERS[extname(path)]
      if (!loader) return [path, null]
      try {
        // Metafile paths are relative to `absWorkingDir`, the monorepo root. One
        // that resolves outside it is an input from another checkout — which the
        // test above rejects, and which this one must not crash on first.
        const source = readFileSync(join(REPO_ROOT, path), 'utf-8')
        return [path, (await transform(source, { loader, minify: true })).code]
      } catch {
        return [path, null]
      }
    }),
  ),
)

describe('the manifest decides what the bundle externalises', () => {
  it('declares every package the bundle leaves external', () => {
    expect([...externals].filter((name) => !declared.has(name)).sort()).toEqual([])
  })

  it('declares nothing the bundle does not import', () => {
    expect([...declared].filter((name) => !externals.has(name)).sort()).toEqual([])
  })

  it('inlines only this repo, never a third-party package', () => {
    const foreign = inputs.filter(
      (path) => !path.startsWith('app/server/src/') && !path.startsWith(INLINED_PREFIX),
    )
    expect(foreign).toEqual([])
  })

  it('loads nothing by a route the resolver cannot follow', () => {
    // Two escapes survive everything above: `import(name)` stays in the bundle
    // unresolved, with no warning and no graph entry, and fails on a consumer's
    // machine the first time that code path runs; `require` — directly or
    // through `createRequire` — reaches a package the metafile check above
    // cannot attribute. Everything in the bundle must load by literal import,
    // so that the graph above is the whole graph.
    const offenders: string[] = []
    for (const [path, code] of normalizedInputs) {
      if (code === null) {
        offenders.push(`${path}: inlined but not parseable, so not checked`)
        continue
      }
      for (const match of code.matchAll(/\bimport\(/g)) {
        const argument = code.slice(match.index + match[0].length)
        if (!LITERAL_ARGUMENT.test(argument)) offenders.push(`${path}: non-literal import()`)
      }
      if (/(?<![.\w$])require\(/.test(code)) offenders.push(`${path}: require()`)
      if (/\bcreateRequire\b/.test(code)) offenders.push(`${path}: createRequire`)
    }
    expect(offenders).toEqual([])
  })
})
