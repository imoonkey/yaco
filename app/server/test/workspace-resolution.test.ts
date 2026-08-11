/** Which checkout does this suite actually import?
 *
 *  npm workspaces write their self-links inside `node_modules` relative
 *  (`@yaco/cli -> ../../cli`), so a worktree that shares `node_modules` with the
 *  main checkout resolves every `@yaco/*` import to *main's* source — a
 *  different branch. Nothing about that is visible in a test run: the suite goes
 *  green against code the branch does not contain, and a CLI change made on the
 *  branch is invisible to the branch's own server tests.
 *
 *  So ask the resolver this suite really uses (`import.meta.resolve` is vite's
 *  here, conditions and all) where each specifier lands, and require it to land
 *  inside this checkout. `scripts/worktree-provision.sh` is what keeps that
 *  true; this is the assertion that notices when it stops being true.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const serverDir = resolve(fileURLToPath(import.meta.url), '../..')
const repoRoot = resolve(serverDir, '../..')
const repoRootUrl = pathToFileURL(repoRoot + '/').href

const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](@yaco\/[^'"]+)['"]/g

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : tsFiles(full)
    return e.isFile() && /\.tsx?$/.test(e.name) ? [full] : []
  })
}

/** Every workspace specifier this package imports, read off its own source. A
 *  hardcoded list would go stale the first time someone adds an import. */
function importedWorkspaceSpecifiers(): string[] {
  const found = new Set<string>()
  for (const dir of ['src', 'test']) {
    const full = join(serverDir, dir)
    if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const file of tsFiles(full))
      for (const m of readFileSync(file, 'utf-8').matchAll(SPECIFIER)) found.add(m[1])
  }
  return [...found].sort()
}

describe('workspace resolution', () => {
  const specifiers = importedWorkspaceSpecifiers()

  it('finds the workspace imports it is meant to check', () => {
    expect(specifiers).toContain('@yaco/cli/core/paths')
    expect(specifiers).toContain('@yaco/codex-transcribe')
  })

  it.each(specifiers)('%s resolves inside this checkout', (specifier) => {
    const resolved = import.meta.resolve(specifier)
    expect(
      resolved.startsWith(repoRootUrl),
      `${specifier} resolves to ${resolved}, outside ${repoRoot}.\n` +
        'This worktree shares node_modules with another checkout, so these tests\n' +
        'are validating that checkout\'s source. Run `bash scripts/worktree-provision.sh`\n' +
        'from the worktree root to repoint the workspace links.',
    ).toBe(true)
  })
})
