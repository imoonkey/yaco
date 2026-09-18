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
  let projectReal: string | null = null
  try {
    projectReal = await realpath(projectPath)
  } catch {
    projectReal = null
  }

  const candidates = [...(await childDirNames(projectPath)), PLAN_DIR]
  const repos: string[] = []
  for (const rel of candidates) {
    if (await isRepoDir(projectPath, projectReal, rel)) repos.push(rel)
  }
  if (repos.length === 0) return []

  const tracked = await trackedPaths(projectPath)
  const ig = await getProjectGitignore(projectPath)

  return repos
    .filter((rel) => !tracked.some((p) => p === rel || p.startsWith(`${rel}/`)))
    .filter((rel) => !(ig?.ignores(`${rel}/`) ?? false))
    .sort()
}

/** Depth-1 child names, `.git` excluded. */
async function childDirNames(projectPath: string): Promise<string[]> {
  try {
    const entries = await readdir(projectPath, { withFileTypes: true })
    return entries.map((e) => e.name).filter((name) => name !== '.git')
  } catch {
    return []
  }
}

/** True when `rel` is a directory (following a symlink) holding a `.git` — a dir
 *  (normal repo) or a file (linked worktree) — and does not resolve back into the
 *  host tree (loop -> ., link -> ..), which would alias the host as a colocated repo. */
async function isRepoDir(projectPath: string, projectReal: string | null, rel: string): Promise<boolean> {
  const abs = join(projectPath, rel)
  let real: string
  try {
    real = await realpath(abs)
    if (!(await stat(real)).isDirectory()) return false
  } catch {
    return false // absent or a broken symlink
  }
  if (projectReal && (real === projectReal || projectReal.startsWith(`${real}/`))) return false
  return existsSync(join(abs, '.git'))
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
