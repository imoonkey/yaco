import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDevPorts } from '../../../e2ePorts'

// Cleanup of every artifact an e2e run can create OUTSIDE the repo. Used by
// global-setup (clean slate before a run) and global-teardown (backstop after a
// run). Both run only in the Playwright main process, never in workers.
//
// Two modes (see e2ePorts.ts):
//  - Isolated (default): the API server binds an ephemeral YACO_HOME under the
//    OS temp dir. Teardown nukes that whole dir (the webServer command wipes it
//    pre-boot, so setup leaves it alone).
//  - Reuse (E2E_REUSE=1): the suite runs against the real ~/.yaco. Cleanup
//    prunes only the leftover test fixtures from the real registry.
//
// SAFETY: every helper-created fixture writes a marker file. Cleanup only ever
// deletes a dir / prunes a registry entry that EITHER carries the marker OR no
// longer exists on disk (a leaked registry row). So a real project/dir that
// happens to sit under a test-looking prefix is never touched.

/** Prefix for $HOME-rooted browse fixtures (the /api/browse endpoint only
 *  serves paths under $HOME, so those can't live in the temp YACO_HOME). */
export const BROWSE_FIXTURE_PREFIX = '.yaco-e2e-browse-'

/** Marker file written into every helper-created fixture root. */
export const FIXTURE_MARKER = '.yaco-e2e-fixture'

/** Prefixes of the temp fixture repos created by helpers/workspace.ts. */
const TMP_FIXTURE_PREFIXES = ['yaco-e2e-proj-', 'yaco-e2e-wt-', 'yaco-e2e-bin-']

/** The ephemeral runtime root the e2e API server binds, or null in reuse mode
 *  (where the server uses the real ~/.yaco). Matches the YACO_HOME injected
 *  into the server env by playwright.config.ts. */
export function ephemeralYacoHome(): string | null {
  return resolveDevPorts({ e2e: true }).yacoHome
}

function isFixtureDir(dir: string): boolean {
  return existsSync(join(dir, FIXTURE_MARKER))
}

/** Remove only marker-bearing fixture dirs under `parent` matching a prefix. */
function removeFixtureDirs(parent: string, prefixes: string[]): void {
  let entries
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !prefixes.some((p) => entry.name.startsWith(p))) continue
    const full = join(parent, entry.name)
    if (isFixtureDir(full)) rmSync(full, { recursive: true, force: true })
  }
}

/** Drop registry entries that point at a leaked e2e fixture: a path under
 *  /tmp/yaco-e2e-* that is EITHER gone (disposed, leaked row) OR still carries
 *  the fixture marker. Real projects are never under that prefix, and one that
 *  somehow were would lack the marker and be preserved. Same 2-space JSON / no
 *  trailing newline as the server writes. */
function pruneRegistryFixtures(registryFile: string): void {
  if (!existsSync(registryFile)) return
  try {
    const records = JSON.parse(readFileSync(registryFile, 'utf-8')) as { id: string; path: string }[]
    const e2ePrefix = join(tmpdir(), 'yaco-e2e-')
    const kept = records.filter((r) => {
      if (!r.path.startsWith(e2ePrefix)) return true
      return existsSync(r.path) && !isFixtureDir(r.path)
    })
    if (kept.length !== records.length) {
      writeFileSync(registryFile, JSON.stringify(kept, null, 2), 'utf-8')
    }
  } catch {
    // Corrupt/locked registry — leave it; per-spec dispose is the primary path.
  }
}

function sweepFixtures(): void {
  removeFixtureDirs(tmpdir(), TMP_FIXTURE_PREFIXES)
  removeFixtureDirs(homedir(), [BROWSE_FIXTURE_PREFIX])
}

/** Teardown backstop: remove the temp YACO_HOME (isolated) or prune
 *  real-registry leftovers (reuse), then sweep leaked fixture dirs. */
export function removeE2eArtifacts(): void {
  const home = ephemeralYacoHome()
  if (home) {
    rmSync(home, { recursive: true, force: true })
  } else {
    pruneRegistryFixtures(join(homedir(), '.yaco', 'projects.json'))
  }
  sweepFixtures()
}

/** Setup: sweep leaked fixture dirs from a crashed prior run. The ephemeral
 *  YACO_HOME itself is wiped by the webServer command pre-boot, and the real
 *  registry is left alone here (teardown cleans our own leftovers post-run). */
export function prepareCleanSlate(): void {
  sweepFixtures()
}
