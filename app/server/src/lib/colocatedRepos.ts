/** Colocated-repo detection.
 *
 *  A "colocated repo" is a directory that is its own git repo but is
 *  deliberately not part of the host repo — a private `.yaco/plan` excluded via
 *  `.git/info/exclude` is the motivating instance. The app mirrors its read-only
 *  git surfaces (status / diff / search-index) across the host plus every
 *  detected colocated repo, so they show up first-class without entering host git.
 *
 *  Candidates are every depth-1 child with a `.git`, plus `.yaco/plan` when it
 *  has one. A candidate `X` is detected when:
 *    - `X/.git` exists (dir OR worktree-style file), AND
 *    - nothing at or under `X` is in the host index (excludes submodule gitlinks
 *      and a normally-tracked dir), AND
 *    - `X` is NOT matched by the host's root working-tree `.gitignore`
 *      (excludes node_modules & friends) — the same source the tree's dimming
 *      uses, so detection and dimming can never disagree.
 *
 *  The host-index half is one `git ls-files -z` read, not a git process per
 *  candidate; the `.gitignore` half reuses getProjectGitignore.
 *  Result is cached by realpath(projectPath) for a short TTL — a /status poll
 *  storm pays detection once. No watchers.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readdir, realpath, stat } from 'fs/promises'
import { join } from 'path'
import { PLAN_DIR } from 'yaco-cli/core/paths'
import { getProjectGitignore } from './gitignore'
import { GIT_MAX_BUFFER } from './constants'

const exec = promisify(execFile)

/** Short TTL: detection is cheap but a status poll fires every couple seconds. */
const CACHE_TTL_MS = 2_000

interface CacheEntry {
  repos: string[]
  ts: number
}

const cache = new Map<string, CacheEntry>()

/** Drop cached detection for a project (tests; future config/file-watch hooks).
 *  Normalizes via realpath so a targeted clear matches the stored key. */
export async function clearColocatedReposCache(projectPath?: string): Promise<void> {
  if (projectPath === undefined) {
    cache.clear()
    return
  }
  let key: string
  try {
    key = await realpath(projectPath)
  } catch {
    key = projectPath
  }
  cache.delete(key)
}

/** Detected colocated-repo paths (relative to projectPath), sorted.
 *  Cached by realpath(projectPath) for CACHE_TTL_MS. */
export async function getColocatedRepos(projectPath: string): Promise<string[]> {
  let key: string
  try {
    key = await realpath(projectPath)
  } catch {
    key = projectPath
  }

  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.repos

  const repos = await detect(projectPath)
  cache.set(key, { repos, ts: Date.now() })
  return repos
}

async function detect(projectPath: string): Promise<string[]> {
  const candidates = await childRepoDirs(projectPath)
  if (existsSync(join(projectPath, PLAN_DIR, '.git'))) candidates.push(PLAN_DIR)
  if (candidates.length === 0) return []

  const tracked = await trackedPaths(projectPath)
  const ig = await getProjectGitignore(projectPath)

  return candidates
    .filter((rel) => !tracked.some((p) => p === rel || p.startsWith(`${rel}/`)))
    .filter((rel) => !(ig?.ignores(`${rel}/`) ?? false))
    .sort()
}

/** Depth-1 child directories (following a symlinked dir) that contain a `.git`. */
async function childRepoDirs(projectPath: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(projectPath, { withFileTypes: true })
  } catch {
    return []
  }

  let projectReal: string | null = null
  try {
    projectReal = await realpath(projectPath)
  } catch {
    projectReal = null
  }

  const names: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git') continue
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      let real: string
      try {
        real = await realpath(join(projectPath, entry.name))
        isDir = (await stat(real)).isDirectory()
      } catch {
        continue // broken symlink
      }
      if (!isDir) continue
      // Skip self/ancestor links (loop -> ., link -> ..) that resolve back into
      // the host tree — otherwise the host repo aliases itself as a colocated one.
      if (projectReal && (real === projectReal || projectReal.startsWith(`${real}/`))) continue
    }
    if (!isDir) continue
    // `.git` as a dir (normal repo) or a file (linked worktree) both qualify.
    if (existsSync(join(projectPath, entry.name, '.git'))) names.push(entry.name)
  }
  return names
}

/** Paths present in the host index (one `git ls-files -z`). A nested repo is
 *  never descended into, and a submodule gitlink lists as its own dir — both
 *  land here correctly. Non-git host → empty. */
async function trackedPaths(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['ls-files', '-z'], {
      cwd: projectPath,
      maxBuffer: GIT_MAX_BUFFER,
    })
    return stdout.split('\0').filter(Boolean)
  } catch {
    return []
  }
}
