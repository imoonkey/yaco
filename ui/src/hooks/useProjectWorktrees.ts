import { useState, useEffect, useCallback } from 'react'
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

  const fetch_ = useCallback(async (signal?: AbortSignal) => {
    if (!projectName) return
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(projectName)}`, { signal })
      if (!res.ok) return
      const data = await res.json() as {
        tasks: Record<string, {
          worktree?: string | null
          worktreeStatus?: { active: boolean; dirty: boolean; branch: string; ahead: number; behind: number }
        }>
      }

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

  useEffect(() => {
    setWorktrees([])
    const ac = new AbortController()
    void fetch_(ac.signal)
    const id = setInterval(() => void fetch_(), 60_000)
    return () => { ac.abort(); clearInterval(id) }
  }, [fetch_])

  useSSERefresh('filetree', fetch_)
  useSSERefresh('worktrees', fetch_)

  return worktrees
}
