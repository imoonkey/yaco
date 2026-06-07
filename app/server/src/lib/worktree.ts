import { existsSync, realpathSync } from 'fs'
import { execFile } from 'child_process'
import { worktreePath, worktreeBranch } from '@yaco/cli/core/worktree'

export interface WorktreeStatus {
  active: boolean
  dirty: boolean
  branch: string
  ahead: number
  behind: number
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout)
    })
  })
}

function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const parts = output.trim().split('\t')
  return {
    behind: parseInt(parts[0], 10) || 0,
    ahead: parseInt(parts[1], 10) || 0,
  }
}

/** Parse `git worktree list --porcelain` into a Set of canonical worktree paths */
function parseWorktreeList(output: string): Set<string> {
  const set = new Set<string>()
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) set.add(line.slice('worktree '.length))
  }
  return set
}

async function listRegistered(projectPath: string): Promise<Set<string>> {
  try {
    return parseWorktreeList(await git(projectPath, ['worktree', 'list', '--porcelain']))
  } catch {
    return new Set()
  }
}

function isRegistered(dir: string, registered: Set<string>): boolean {
  try {
    return registered.has(realpathSync(dir))
  } catch {
    return false
  }
}

function inactive(branch: string): WorktreeStatus {
  return { active: false, dirty: false, branch, ahead: 0, behind: 0 }
}

async function resolveActive(dir: string, branch: string): Promise<WorktreeStatus> {
  const [dirty, aheadBehind] = await Promise.all([
    git(dir, ['status', '--porcelain'])
      .then(out => out.trim().length > 0)
      .catch(() => false),
    git(dir, ['rev-list', '--count', '--left-right', `main...HEAD`])
      .then(parseAheadBehind)
      .catch(() => ({ ahead: 0, behind: 0 })),
  ])
  return { active: true, dirty, branch, ...aheadBehind }
}

/** Resolve worktree status for a single slug within a project */
export async function getWorktreeStatus(projectPath: string, slug: string): Promise<WorktreeStatus> {
  const dir = worktreePath(projectPath, slug)
  const branch = worktreeBranch(slug)
  if (!existsSync(dir)) return inactive(branch)

  const registered = await listRegistered(projectPath)
  if (!isRegistered(dir, registered)) return inactive(branch)
  return resolveActive(dir, branch)
}

/** Extract worktree slug from a session path, if it's inside a .worktrees directory */
export function extractWorktreeSlug(sessionPath: string): string | undefined {
  const match = sessionPath.match(/[/\\]\.worktrees[/\\]([^/\\]+)/)
  return match?.[1]
}

/** Batch-resolve worktree statuses for all unique slugs found in tasks.
 *  Calls `git worktree list` once and shares the result across all slugs. */
export async function getWorktreeStatuses(
  projectPath: string,
  tasks: Record<string, { worktree?: string }>,
): Promise<Map<string, WorktreeStatus>> {
  const slugs = new Set<string>()
  for (const task of Object.values(tasks)) {
    if (task.worktree) slugs.add(task.worktree)
  }

  const results = new Map<string, WorktreeStatus>()
  if (slugs.size === 0) return results

  const registered = await listRegistered(projectPath)

  await Promise.all(
    [...slugs].map(async (slug) => {
      const dir = worktreePath(projectPath, slug)
      const branch = worktreeBranch(slug)
      if (!existsSync(dir) || !isRegistered(dir, registered)) {
        results.set(slug, inactive(branch))
        return
      }
      results.set(slug, await resolveActive(dir, branch))
    }),
  )
  return results
}
