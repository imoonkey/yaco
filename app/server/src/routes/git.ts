import { Hono } from 'hono'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { realpath } from 'fs/promises'
import { join, dirname, basename } from 'path'
import { GIT_COMMAND_TIMEOUT_MS } from '../lib/constants'
import { fail } from '../lib/response'
import { getColocatedRepos } from '../lib/colocatedRepos'
import { withProject, type ProjectEnv } from '../middleware/project'

export interface GitChange {
  path: string
  status: 'M' | 'A' | 'D' | 'U'
}

interface GitOutput { stdout: string; ok: boolean; code?: number | string }

function git(cwd: string, args: string[]): Promise<GitOutput> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    }, (err, stdout) => {
      // Always return whatever stdout was captured. Some commands (e.g.
      // `git diff --no-index`) exit with code 1 to signal "differences
      // found" — that is success, not failure, and stdout is the diff.
      const code = err && 'code' in err ? err.code : undefined
      resolve({ stdout: (stdout as unknown as string) ?? '', ok: !err, code })
    })
  })
}

function parseStatus(xy: string): GitChange['status'] {
  if (xy === '??') return 'U'
  if (xy[0] === 'A') return 'A'
  if (xy[0] === 'D' || xy[1] === 'D') return 'D'
  return 'M'
}

function unsafeFilePath(filePath: string): boolean {
  return filePath.includes('..') || filePath.startsWith('/')
}

/** Resolve the git location + ref for a file's HEAD baseline.
 *  The /files content endpoint serves a symlink's real target, so the gutter must
 *  diff the buffer against that target's HEAD blob. `git show HEAD:<symlink>` returns
 *  only the link text, which paints the whole file blue. Running git from the resolved
 *  file's own directory yields the real content — and works even when the target lives
 *  in another repo. Paths absent on disk fall back to the literal lookup. */
async function resolveBaseline(projectPath: string, filePath: string): Promise<{ cwd: string; ref: string }> {
  const absPath = join(projectPath, filePath)
  if (!existsSync(absPath)) return { cwd: projectPath, ref: `HEAD:${filePath}` }
  const real = await realpath(absPath)
  return { cwd: dirname(real), ref: `HEAD:./${basename(real)}` }
}

/** Parse `git diff --shortstat` output → { added, deleted } */
function parseShortstat(output: string): { added: number; deleted: number } {
  const added = output.match(/(\d+) insertion/)
  const deleted = output.match(/(\d+) deletion/)
  return { added: added ? Number(added[1]) : 0, deleted: deleted ? Number(deleted[1]) : 0 }
}

/** Last-known-good git snapshots, keyed by `<effectivePath>\0<repoPrefix>` so a
 *  worktree never shares the primary's snapshot and each colocated repo is
 *  tracked independently. */
const gitSnapshots = new Map<string, GitChange[]>()

/** Cached refs per project (5s TTL) */
const refsCache = new Map<string, { data: RefsResult; ts: number }>()
const REFS_CACHE_TTL_MS = 5_000

interface RefsResult {
  branches: string[]
  tags: string[]
  recentCommits: { hash: string; subject: string; date: string; author: string }[]
}

/** Coalesce concurrent identical /:project/status requests, keyed by effective project path. */
const statusInflight = new Map<string, Promise<{ changes: GitChange[]; stale: boolean; stats?: { added: number; deleted: number } }>>()

const app = new Hono<ProjectEnv>()

// GET /:project/refs — branches, tags, recent commits
app.get('/:project/refs', withProject, async (c) => {
  const proj = c.var.project
  const cached = refsCache.get(proj.name)
  if (cached && Date.now() - cached.ts < REFS_CACHE_TTL_MS) {
    return c.json(cached.data)
  }

  const [branchOut, tagOut, logOut] = await Promise.all([
    git(proj.path, ['branch', '-a', '--format=%(refname:short)']),
    git(proj.path, ['tag', '--sort=-creatordate']),
    git(proj.path, ['log', '-50', '--format=%h\t%ci\t%an\t%s']),
  ])

  const branches = branchOut.ok ? branchOut.stdout.split('\n').filter(Boolean) : []
  const tags = tagOut.ok ? tagOut.stdout.split('\n').filter(Boolean).slice(0, 50) : []
  const recentCommits = logOut.ok
    ? logOut.stdout.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t')
        return { hash: parts[0], date: parts[1], author: parts[2], subject: parts[3] ?? '' }
      })
    : []

  const data: RefsResult = { branches, tags, recentCommits }
  refsCache.set(proj.name, { data, ts: Date.now() })
  return c.json(data)
})

interface RepoStatus {
  prefix: string
  changes: GitChange[]
  fresh: boolean
  stats?: { added: number; deleted: number }
}

/** Status for one repo (host when prefix is "", else a "<repo>/" colocated repo).
 *  On transient git failure, returns that repo's last-known-good snapshot marked
 *  stale; on success, stores a fresh snapshot keyed by effective path + prefix. */
async function resolveRepoStatus(projectPath: string, prefix: string): Promise<RepoStatus> {
  const cwd = prefix === '' ? projectPath : join(projectPath, prefix.slice(0, -1))
  const key = `${projectPath}\0${prefix}`

  const [result, statResult] = await Promise.all([
    git(cwd, ['status', '--porcelain', '-z']),
    git(cwd, ['diff', '--shortstat']),
  ])

  if (!result.ok) {
    return { prefix, changes: gitSnapshots.get(key) ?? [], fresh: false }
  }

  const entries = result.stdout.split('\0').filter(Boolean)
  const changes: GitChange[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const xy = entry.substring(0, 2)
    const path = prefix + entry.substring(3)
    changes.push({ path, status: parseStatus(xy) })
    // Renames/copies have an extra entry for the old path — skip it
    if (xy[0] === 'R' || xy[0] === 'C') i++
  }

  gitSnapshots.set(key, changes)
  const stats = statResult.ok ? parseShortstat(statResult.stdout) : { added: 0, deleted: 0 }
  return { prefix, changes, fresh: true, stats }
}

/** Aggregate status across the host plus every colocated repo. Order is
 *  deterministic — host first, then colocated repos sorted by prefix
 *  (getColocatedRepos returns them sorted) — and a single seen-set prevents any
 *  path from being listed twice. If any repo is stale the response is stale and
 *  stats are suppressed; otherwise stats are summed across all repos. */
async function resolveStatus(projectPath: string) {
  const repos = await getColocatedRepos(projectPath)
  const prefixes = ['', ...repos.map((r) => `${r}/`)]
  const results = await Promise.all(prefixes.map((p) => resolveRepoStatus(projectPath, p)))

  const seen = new Set<string>()
  const changes: GitChange[] = []
  for (const repo of results) {
    for (const change of repo.changes) {
      if (seen.has(change.path)) continue
      seen.add(change.path)
      changes.push(change)
    }
  }

  if (results.some((r) => !r.fresh)) {
    return { changes, stale: true }
  }
  const stats = results.reduce(
    (acc, r) => ({ added: acc.added + (r.stats?.added ?? 0), deleted: acc.deleted + (r.stats?.deleted ?? 0) }),
    { added: 0, deleted: 0 },
  )
  return { changes, stale: false, stats }
}

// GET /:project/status — aggregated git status (host + colocated repos)
app.get('/:project/status', withProject, async (c) => {
  const proj = c.var.project
  // Key by effective path so worktree variants don't share the main repo's promise
  const key = proj.path
  let pending = statusInflight.get(key)
  if (!pending) {
    pending = resolveStatus(proj.path)
      .finally(() => statusInflight.delete(key))
    statusInflight.set(key, pending)
  }
  return c.json(await pending)
})

// GET /:project/baseline?path=... — file content from HEAD for editor-buffer diffing
app.get('/:project/baseline', withProject, async (c) => {
  const proj = c.var.project
  const filePath = c.req.query('path')
  if (!filePath || unsafeFilePath(filePath)) {
    return c.json({ error: 'invalid path' }, 400)
  }

  const { cwd, ref } = await resolveBaseline(proj.path, filePath)
  const result = await git(cwd, ['show', ref])
  if (!result.ok) {
    if (result.code === 128) return c.json({ content: '', exists: false })
    return fail(c, 500, 'git baseline failed')
  }
  return c.json({ content: result.stdout, exists: true })
})

// GET /:project/diff?path=...&base=REF&compare=REF — git diff for a specific file
app.get('/:project/diff', withProject, async (c) => {
  const proj = c.var.project

  const filePath = c.req.query('path')
  if (!filePath || unsafeFilePath(filePath)) {
    return c.json({ error: 'invalid path' }, 400)
  }

  const base = c.req.query('base')
  const compare = c.req.query('compare')

  // Both or neither — one without the other is invalid
  if ((base && !compare) || (!base && compare)) {
    return c.json({ error: 'both base and compare params are required' }, 400)
  }

  if (base && compare) {
    // Diff between two refs
    const result = await git(proj.path, ['diff', base, compare, '--', filePath])
    return c.json({ diff: result.stdout })
  }

  // No refs — diff working tree vs HEAD, then check staged, then untracked fallback
  let diff = (await git(proj.path, ['diff', 'HEAD', '--', filePath])).stdout

  // Working tree matches HEAD — check staged (index) changes
  if (!diff) {
    diff = (await git(proj.path, ['diff', '--cached', 'HEAD', '--', filePath])).stdout
  }

  // For untracked files, show full content as additions
  if (!diff) {
    diff = (await git(proj.path, ['diff', '--no-index', '--', '/dev/null', filePath])).stdout
  }

  return c.json({ diff })
})

// GET /:project/compare?base=REF&compare=REF — diff file list between two refs
app.get('/:project/compare', withProject, async (c) => {
  const proj = c.var.project
  const base = c.req.query('base')
  const compare = c.req.query('compare')

  if (!base || !compare) {
    return fail(c, 400, 'base and compare query params are required')
  }

  const result = await git(proj.path, ['diff', '--name-status', base, compare])
  if (!result.ok) return fail(c, 500, 'git diff failed')

  const statusMap: Record<string, GitChange['status']> = { M: 'M', A: 'A', D: 'D', R: 'M' }

  const files: GitChange[] = result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [rawStatus, ...pathParts] = line.split('\t')
      const letter = rawStatus[0]
      return {
        path: pathParts[pathParts.length - 1],
        status: statusMap[letter] ?? 'M',
      }
    })

  const statResult = await git(proj.path, ['diff', '--shortstat', base, compare])
  const stats = parseShortstat(statResult.stdout)

  return c.json({ files, stats })
})

export const gitRoutes = app
