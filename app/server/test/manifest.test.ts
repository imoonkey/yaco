/** The manifest against the code, in both directions.
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
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'

const SERVER_DIR = join(import.meta.dirname, '..')
const MANIFEST = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf-8'))

/** The one package the bundle inlines on purpose: an unpublished workspace with
 *  a single consumer (`routes/voice.ts`) and no dependencies of its own, so
 *  publishing it separately would buy nothing. Declaring it would be wrong in
 *  the other direction — a consumer's npm cannot fetch it. */
const INLINED = new Set(['@yaco/codex-transcribe'])

const BUILTINS = new Set(builtinModules)

/** The package a specifier names, or null for a relative path or a builtin. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (specifier.startsWith('node:')) return null
  const segments = specifier.split('/')
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!
  return BUILTINS.has(name) ? null : name
}

/** Every package the production sources import, static or dynamic. Tests are
 *  excluded: they are entitled to devDependencies, and none of them is in the
 *  bundle. */
function importedPackages(): Map<string, string> {
  const found = new Map<string, string>()
  const files = readdirSync(join(SERVER_DIR, 'src'), { recursive: true, encoding: 'utf-8' })
  for (const relative of files) {
    if (!relative.endsWith('.ts')) continue
    if (relative.includes('__tests__')) continue
    const source = readFileSync(join(SERVER_DIR, 'src', relative), 'utf-8')
    // `from "x"`, `import("x")`, and the side-effect form `import "x"` — which
    // `dotenv/config` is, and which a `from`-only pattern reports as unused.
    const specifiers = source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm,
    )
    for (const [, specifier] of specifiers) {
      const name = packageOf(specifier!)
      if (name && !found.has(name)) found.set(name, relative)
    }
  }
  return found
}

const imported = importedPackages()
const declared = new Set([
  ...Object.keys(MANIFEST.dependencies as Record<string, string>),
  ...Object.keys(MANIFEST.optionalDependencies as Record<string, string>),
])

describe('the manifest decides what the bundle externalises', () => {
  it('declares every package the server imports', () => {
    const undeclared = [...imported]
      .filter(([name]) => !declared.has(name) && !INLINED.has(name))
      .map(([name, file]) => `${name} (imported by src/${file})`)
    expect(undeclared).toEqual([])
  })

  it('declares nothing the server does not import', () => {
    const unused = [...declared].filter((name) => !imported.has(name))
    expect(unused).toEqual([])
  })
})
