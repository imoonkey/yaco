/** Colocated-repo detection.
 *
 *  A "colocated repo" is a depth-1 child directory that is its own git repo but
 *  is deliberately not part of the host repo — `plan/` excluded via
 *  `.git/info/exclude` is the motivating instance. The app mirrors its read-only
 *  git surfaces (status / diff / search-index) across the host plus every
 *  detected colocated repo, so they show up first-class without entering host git.
 *
 *  The mechanism never matches the name `plan`; it operates on a detected set.
 *  Detection signal (a depth-1 child `X`):
 *    - `X/.git` exists (dir OR worktree-style file), AND
 *    - `X` is NOT in the host index (excludes submodule gitlinks and a
 *      normally-tracked dir), AND
 *    - `X` is NOT matched by the host's root working-tree `.gitignore`
 *      (excludes node_modules & friends) — the same source the tree's dimming
 *      uses, so detection and dimming can never disagree.
 *
 *  The host-index half is one `git ls-files -z` read (top-level tracked names),
 *  not a git process per child; the `.gitignore` half reuses getProjectGitignore.
 *  Result is cached by realpath(projectPath) for a short TTL — a /status poll
 *  storm pays detection once. No watchers.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readdir, readFile, realpath, stat } from 'fs/promises'
import { join } from 'path'
import { parseScopedToml } from '@yaco/cli/core/paths'
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

/** Detected colocated-repo directory names (relative to projectPath), sorted.
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
  const policy = await readPolicy(projectPath)
  if (policy === 'off') return []

  const candidates = await childRepoDirs(projectPath)
  if (candidates.length === 0) return []

  const tracked = await trackedTopLevel(projectPath)
  const ig = await getProjectGitignore(projectPath)

  let detected = candidates.filter(
    (name) => !tracked.has(name) && !(ig?.ignores(`${name}/`) ?? false),
  )

  if (policy !== 'auto') {
    const allow = new Set(parseAllowList(policy))
    detected = detected.filter((name) => allow.has(name))
  }

  return detected.sort()
}

/** Depth-1 child directories (following a symlinked dir) that contain a `.git`. */
async function childRepoDirs(projectPath: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(projectPath, { withFileTypes: true })
  } catch {
    return []
  }

  const names: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git') continue
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await stat(join(projectPath, entry.name))).isDirectory()
      } catch {
        continue // broken symlink
      }
    }
    if (!isDir) continue
    // `.git` as a dir (normal repo) or a file (linked worktree) both qualify.
    if (existsSync(join(projectPath, entry.name, '.git'))) names.push(entry.name)
  }
  return names
}

/** Top-level names present in the host index (one `git ls-files -z`).
 *  A nested repo is never descended into, and a submodule gitlink lists as its
 *  own dir — both land here correctly. Non-git host → empty set. */
async function trackedTopLevel(projectPath: string): Promise<Set<string>> {
  try {
    const { stdout } = await exec('git', ['ls-files', '-z'], {
      cwd: projectPath,
      maxBuffer: GIT_MAX_BUFFER,
    })
    const set = new Set<string>()
    for (const path of stdout.split('\0')) {
      if (!path) continue
      const top = path.split('/')[0]
      if (top) set.add(top)
    }
    return set
  } catch {
    return new Set()
  }
}

/** Read the colocatedRepos policy from `<projectPath>/yaco.toml` `[colocated] repos`.
 *  Default "auto". A missing file or malformed toml degrades to "auto" with a
 *  warning — a status poll must never crash on a bad config. */
async function readPolicy(projectPath: string): Promise<string> {
  let raw: string
  try {
    raw = await readFile(join(projectPath, 'yaco.toml'), 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[colocated] failed to read yaco.toml in ${projectPath}:`, e)
    }
    return 'auto'
  }
  try {
    const sections = parseScopedToml(raw)
    return sections['colocated']?.['repos']?.trim() || 'auto'
  } catch (e) {
    console.warn(`[colocated] failed to parse yaco.toml in ${projectPath}:`, e)
    return 'auto'
  }
}

/** Parse a comma-separated allow-list into depth-1 names.
 *  Trims, drops empties, de-dupes, and rejects path separators / `.` / `..`. */
function parseAllowList(policy: string): string[] {
  const names = policy
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\'))
  return [...new Set(names)]
}
