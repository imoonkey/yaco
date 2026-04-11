import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { join } from 'path'

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

/** Resolve worktree status for a single slug within a project */
export async function getWorktreeStatus(projectPath: string, slug: string): Promise<WorktreeStatus> {
  const worktreePath = join(projectPath, '.worktrees', slug)
  const branch = `task/${slug}`

  if (!existsSync(worktreePath)) {
    return { active: false, dirty: false, branch, ahead: 0, behind: 0 }
  }

  const [dirty, aheadBehind] = await Promise.all([
    git(worktreePath, ['status', '--porcelain'])
      .then(out => out.trim().length > 0)
      .catch(() => false),
    git(worktreePath, ['rev-list', '--count', '--left-right', `main...HEAD`])
      .then(parseAheadBehind)
      .catch(() => ({ ahead: 0, behind: 0 })),
  ])

  return { active: true, dirty, branch, ...aheadBehind }
}

/** Extract worktree slug from a session path, if it's inside a .worktrees directory */
export function extractWorktreeSlug(sessionPath: string): string | undefined {
  const match = sessionPath.match(/[/\\]\.worktrees[/\\]([^/\\]+)/)
  return match?.[1]
}

/** Batch-resolve worktree statuses for all unique slugs found in tasks */
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

  await Promise.all(
    [...slugs].map(async (slug) => {
      results.set(slug, await getWorktreeStatus(projectPath, slug))
    }),
  )
  return results
}
