import { existsSync, realpathSync } from 'fs'
import { execFile } from 'child_process'
import { worktreePath, worktreeBranch } from 'yaco-cli/core/worktree'
import { readYacoProjectPaths } from 'yaco-cli/core/paths'

export interface WorktreeStatus {
  active: boolean
  dirty: boolean
  branch: string
  ahead: number
  behind: number
}

/** One entry from `git worktree list --porcelain`, with display-ready identity. */
export interface WorktreeEntry {
  path: string       // absolute path git reports for the worktree (stable id)
  branch: string     // "task/foo" | "(detached)" | "(bare)"
  head: string       // short sha ("" for a bare entry)
  isPrimary: boolean // the main working tree (git always lists it first)
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

/** Parse `git worktree list --porcelain` into structured entries. Each entry is
 *  blank-line separated; the main working tree is the first one git emits. */
function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let path: string | null = null
  let head = ''
  let branch = ''
  let detached = false
  let bare = false

  const flush = () => {
    if (path === null) return
    entries.push({
      path,
      head: head.slice(0, 7),
      branch: bare ? '(bare)' : detached ? '(detached)' : branch.replace(/^refs\/heads\//, '') || '(detached)',
      isPrimary: entries.length === 0,
    })
  }

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length)
      head = ''
      branch = ''
      detached = false
      bare = false
    } else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) branch = line.slice('branch '.length)
    else if (line === 'detached') detached = true
    else if (line === 'bare') bare = true
  }
  flush()
  return entries
}

/** List every worktree registered with the repo at `primaryRoot`, including the
 *  primary checkout. Returns [] if git fails (not a repo, etc.). */
export async function listRegisteredWorktrees(primaryRoot: string): Promise<WorktreeEntry[]> {
  try {
    return parseWorktreeList(await git(primaryRoot, ['worktree', 'list', '--porcelain']))
  } catch {
    return []
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

/** Resolve the working-tree status (dirty + ahead/behind vs main) of a single
 *  registered worktree. The caller guarantees `absPath` is a live worktree. */
export async function worktreeStatus(absPath: string, branch: string): Promise<WorktreeStatus> {
  const [dirty, aheadBehind] = await Promise.all([
    git(absPath, ['status', '--porcelain'])
      .then(out => out.trim().length > 0)
      .catch(() => false),
    git(absPath, ['rev-list', '--count', '--left-right', `main...HEAD`])
      .then(parseAheadBehind)
      .catch(() => ({ ahead: 0, behind: 0 })),
  ])
  return { active: true, dirty, branch, ...aheadBehind }
}

/** Resolve worktree status for a single slug within a project */
export async function getWorktreeStatus(projectPath: string, slug: string): Promise<WorktreeStatus> {
  const dir = worktreePath(projectPath, readYacoProjectPaths(projectPath).worktrees, slug)
  const branch = worktreeBranch(slug)
  if (!existsSync(dir)) return inactive(branch)

  const registered = registeredPaths(await listRegisteredWorktrees(projectPath))
  if (!isRegistered(dir, registered)) return inactive(branch)
  return worktreeStatus(dir, branch)
}

/** Extract worktree slug from a session path, if it's inside a .worktrees directory */
export function extractWorktreeSlug(sessionPath: string): string | undefined {
  const match = sessionPath.match(/[/\\]\.worktrees[/\\]([^/\\]+)/)
  return match?.[1]
}

function registeredPaths(entries: WorktreeEntry[]): Set<string> {
  return new Set(entries.map(e => e.path))
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

  const registered = registeredPaths(await listRegisteredWorktrees(projectPath))
  const worktrees = readYacoProjectPaths(projectPath).worktrees

  await Promise.all(
    [...slugs].map(async (slug) => {
      const dir = worktreePath(projectPath, worktrees, slug)
      const branch = worktreeBranch(slug)
      if (!existsSync(dir) || !isRegistered(dir, registered)) {
        results.set(slug, inactive(branch))
        return
      }
      results.set(slug, await worktreeStatus(dir, branch))
    }),
  )
  return results
}
