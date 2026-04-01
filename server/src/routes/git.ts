import { Hono } from 'hono'
import { spawnSync } from 'child_process'
import { GIT_COMMAND_TIMEOUT_MS } from '../lib/constants'
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

const app = new Hono<ProjectEnv>()

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

// GET /:project/diff?path=... — git diff for a specific file
app.get('/:project/diff', withProject, async (c) => {
  const proj = c.var.project

  const filePath = c.req.query('path')
  if (!filePath || filePath.includes('..') || filePath.startsWith('/')) {
    return c.json({ error: 'invalid path' }, 400)
  }

  // Try tracked changes first (staged + unstaged vs HEAD)
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

export const gitRoutes = app
