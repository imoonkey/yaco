import { useState, useEffect, useCallback, useRef } from 'react'
import { useSSERefresh } from './useSSE'

export interface WorktreeInfo {
  slug: string
  dirty: boolean
  branch: string
  ahead: number
  behind: number
}

/**
 * Derive active worktrees for a project from the task API response.
 * Tasks with worktreeStatus.active === true are collected and deduplicated by slug.
 */
export function useProjectWorktrees(projectName: string | null): WorktreeInfo[] {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const currentProject = useRef(projectName)

  const fetch_ = useCallback(async (signal?: AbortSignal) => {
    if (!projectName) return
    const project = projectName
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(project)}`, { signal })
      if (!res.ok || currentProject.current !== project) return
      const data = await res.json() as {
        tasks: Record<string, {
          worktree?: string | null
          worktreeStatus?: { active: boolean; dirty: boolean; branch: string; ahead: number; behind: number }
        }>
      }
      if (currentProject.current !== project) return

      const seen = new Set<string>()
      const result: WorktreeInfo[] = []
      for (const task of Object.values(data.tasks)) {
        if (!task.worktree || !task.worktreeStatus?.active) continue
        if (seen.has(task.worktree)) continue
        seen.add(task.worktree)
        result.push({
          slug: task.worktree,
          dirty: task.worktreeStatus.dirty,
          branch: task.worktreeStatus.branch,
          ahead: task.worktreeStatus.ahead,
          behind: task.worktreeStatus.behind,
        })
      }
      result.sort((a, b) => a.slug.localeCompare(b.slug))
      setWorktrees(result)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
    }
  }, [projectName])

  // setWorktrees([]) clears the list synchronously on project change; fetch_() sets
  // state only after its await. Worktree state is coupled with App's restore-on-switch
  // logic, so keep the original effect timing.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    currentProject.current = projectName
    setWorktrees([])
    const ac = new AbortController()
    void fetch_(ac.signal)
    const id = setInterval(() => void fetch_(), 60_000)
    return () => { ac.abort(); clearInterval(id) }
  }, [fetch_])
  /* eslint-enable react-hooks/set-state-in-effect */

  useSSERefresh('filetree', fetch_)
  useSSERefresh('worktrees', fetch_)

  return worktrees
}
