#!/usr/bin/env node
/**
 * node-pty ships a prebuilt `spawn-helper` binary that npm's tarball extraction
 * can leave without its executable bit. When that happens every PTY spawn fails
 * with `posix_spawnp failed`, and the app's terminals are stuck showing
 * "[Reconnecting...]". Restore +x on any `spawn-helper` under an installed
 * node-pty so a fresh `npm install` just works.
 *
 * Wired as the repo's `postinstall`. Idempotent, dependency-free, and a no-op on
 * Windows (no spawn-helper) or when node-pty isn't present.
 */
import { existsSync, readdirSync, chmodSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// node-pty is usually hoisted to the repo root, but may land under a workspace.
const nodePtyDirs = [
  join(repoRoot, 'node_modules', 'node-pty'),
  join(repoRoot, 'app', 'server', 'node_modules', 'node-pty'),
]

function findSpawnHelpers(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let s
    try {
      s = statSync(p)
    } catch {
      continue
    }
    if (s.isDirectory()) out.push(...findSpawnHelpers(p))
    else if (name === 'spawn-helper') out.push(p)
  }
  return out
}

let fixed = 0
for (const base of nodePtyDirs) {
  // Both the from-source build (`build/Release`) and prebuilt arches.
  for (const sub of [join(base, 'build', 'Release'), join(base, 'prebuilds')]) {
    for (const helper of findSpawnHelpers(sub)) {
      try {
        chmodSync(helper, 0o755)
        fixed++
      } catch {
        // Best-effort: never fail the install over a perms tweak.
      }
    }
  }
}

if (fixed > 0) {
  console.log(`[fix-node-pty] restored +x on ${fixed} spawn-helper binary(ies)`)
}
