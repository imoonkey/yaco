import { Hono } from 'hono'
import { execFile } from 'child_process'
import { GIT_COMMAND_TIMEOUT_MS } from '../lib/constants'
import { fail } from '../lib/response'
import { withProject, type ProjectEnv } from '../middleware/project'

export interface GitChange {
  path: string
  status: 'M' | 'A' | 'D' | 'U'
}

interface GitOutput { stdout: string; ok: boolean }

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
      resolve({ stdout: (stdout as unknown as string) ?? '', ok: !err })
    })
  })
}

function parseStatus(xy: string): GitChange['status'] {
  if (xy === '??') return 'U'
  if (xy[0] === 'A') return 'A'
  if (xy[0] === 'D' || xy[1] === 'D') return 'D'
  return 'M'
}

/** Parse `git diff --shortstat` output → { added, deleted } */
function parseShortstat(output: string): { added: number; deleted: number } {
  const added = output.match(/(\d+) insertion/)
  const deleted = output.match(/(\d+) deletion/)
  return { added: added ? Number(added[1]) : 0, deleted: deleted ? Number(deleted[1]) : 0 }
}

/** Last-known-good git snapshots per project */
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

async function resolveStatus(projectName: string, projectPath: string) {
  const [result, statResult] = await Promise.all([
    git(projectPath, ['status', '--porcelain', '-z']),
    git(projectPath, ['diff', '--shortstat']),
  ])

  if (!result.ok) {
    // Transient failure — return last-known-good snapshot with stale marker
    const snapshot = gitSnapshots.get(projectName)
    return { changes: snapshot ?? [], stale: true }
  }

  const entries = result.stdout.split('\0').filter(Boolean)
  const changes: GitChange[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const xy = entry.substring(0, 2)
    const path = entry.substring(3)
    changes.push({ path, status: parseStatus(xy) })
    // Renames/copies have an extra entry for the old path — skip it
    if (xy[0] === 'R' || xy[0] === 'C') i++
  }

  const stats = parseShortstat(statResult.stdout)
  gitSnapshots.set(projectName, changes)
  return { changes, stale: false, stats }
}

// GET /:project/status — git status for a project
app.get('/:project/status', withProject, async (c) => {
  const proj = c.var.project
  // Key by effective path so worktree variants don't share the main repo's promise
  const key = proj.path
  let pending = statusInflight.get(key)
  if (!pending) {
    pending = resolveStatus(proj.name, proj.path)
      .finally(() => statusInflight.delete(key))
    statusInflight.set(key, pending)
  }
  return c.json(await pending)
})

// GET /:project/diff?path=...&base=REF&compare=REF — git diff for a specific file
app.get('/:project/diff', withProject, async (c) => {
  const proj = c.var.project

  const filePath = c.req.query('path')
  if (!filePath || filePath.includes('..') || filePath.startsWith('/')) {
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
