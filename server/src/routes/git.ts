import { Hono } from 'hono'
import { spawnSync } from 'child_process'
import { GIT_COMMAND_TIMEOUT_MS } from '../lib/constants'
import { fail } from '../lib/response'
import { withProject, type ProjectEnv } from '../middleware/project'

export interface GitChange {
  path: string
  status: 'M' | 'A' | 'D' | 'U'
}

function parseStatus(xy: string): GitChange['status'] {
  if (xy === '??') return 'U'
  if (xy[0] === 'A') return 'A'
  if (xy[0] === 'D' || xy[1] === 'D') return 'D'
  return 'M'
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

const app = new Hono<ProjectEnv>()

// GET /:project/refs — branches, tags, recent commits
app.get('/:project/refs', withProject, async (c) => {
  const proj = c.var.project
  const cached = refsCache.get(proj.name)
  if (cached && Date.now() - cached.ts < REFS_CACHE_TTL_MS) {
    return c.json(cached.data)
  }

  const empty: RefsResult = { branches: [], tags: [], recentCommits: [] }
  const gitOpts = { cwd: proj.path, encoding: 'utf-8' as const, timeout: GIT_COMMAND_TIMEOUT_MS }

  const branchResult = spawnSync('git', ['branch', '-a', '--format=%(refname:short)'], gitOpts)
  const branches = branchResult.status === 0
    ? branchResult.stdout.split('\n').filter(Boolean)
    : empty.branches

  const tagResult = spawnSync('git', ['tag', '--sort=-creatordate'], gitOpts)
  const tags = tagResult.status === 0
    ? tagResult.stdout.split('\n').filter(Boolean).slice(0, 50)
    : empty.tags

  const logResult = spawnSync('git', ['log', '-50', '--format=%h\t%ci\t%an\t%s'], gitOpts)
  const recentCommits = logResult.status === 0
    ? logResult.stdout.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t')
        return { hash: parts[0], date: parts[1], author: parts[2], subject: parts[3] ?? '' }
      })
    : empty.recentCommits

  const data: RefsResult = { branches, tags, recentCommits }
  refsCache.set(proj.name, { data, ts: Date.now() })
  return c.json(data)
})

// GET /:project/status — git status for a project
app.get('/:project/status', withProject, async (c) => {
  const proj = c.var.project

  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: proj.path,
    encoding: 'utf-8',
    timeout: GIT_COMMAND_TIMEOUT_MS,
  })

  if (result.error || result.status !== 0) {
    // Transient failure — return last-known-good snapshot with stale marker
    const snapshot = gitSnapshots.get(proj.name)
    return c.json({ changes: snapshot ?? [], stale: true })
  }

  const changes: GitChange[] = result.stdout
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map(line => ({
      path: line.substring(3),
      status: parseStatus(line.substring(0, 2)),
    }))

  gitSnapshots.set(proj.name, changes)
  return c.json({ changes, stale: false })
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
    const result = spawnSync('git', ['diff', base, compare, '--', filePath], {
      cwd: proj.path,
      encoding: 'utf-8',
      timeout: GIT_COMMAND_TIMEOUT_MS,
    })
    return c.json({ diff: result.stdout || '' })
  }

  // No refs — existing behavior: diff vs HEAD with untracked fallback
  let result = spawnSync('git', ['diff', 'HEAD', '--', filePath], {
    cwd: proj.path,
    encoding: 'utf-8',
    timeout: GIT_COMMAND_TIMEOUT_MS,
  })
  let diff = result.stdout || ''

  // For untracked files, show full content as additions
  if (!diff) {
    result = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', filePath], {
      cwd: proj.path,
      encoding: 'utf-8',
      timeout: GIT_COMMAND_TIMEOUT_MS,
    })
    diff = result.stdout || ''
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

  const result = spawnSync('git', ['diff', '--name-status', base, compare], {
    cwd: proj.path,
    encoding: 'utf-8',
    timeout: GIT_COMMAND_TIMEOUT_MS,
  })

  if (result.error || result.status !== 0) {
    return fail(c, 500, 'git diff failed')
  }

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

  return c.json({ files })
})

export const gitRoutes = app
