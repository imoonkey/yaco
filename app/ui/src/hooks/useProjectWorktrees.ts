import { useState, useEffect, useCallback, useRef } from 'react'
import { useSSERefresh } from './useSSE'

/** One git-registered worktree of a project (mirrors the server's WorktreeInfo).
 *  `id` is the worktree's absolute path — the stable identity that replaces the
 *  old `.worktrees/<slug>` slug. */
export interface WorktreeInfo {
  id: string         // absolute path — stable identifier
  name: string       // display label ("<repo> (primary)" | basename)
  branch: string     // "task/foo" | "(detached)" | "(bare)"
  head: string       // short sha
  isPrimary: boolean // the main working tree
  dirty: boolean
  ahead: number
  behind: number
}

/**
 * Enumerate every git-registered worktree of a project (primary + linked) from
 * `GET /api/worktrees/:project`. The source of truth is `git worktree list`, so
 * manually-created and task-less worktrees appear — unlike the old task-derived
 * list, which only surfaced worktrees referenced by an active task.
 */
export function useProjectWorktrees(projectName: string | null): WorktreeInfo[] {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const currentProject = useRef(projectName)

  const fetch_ = useCallback(async (signal?: AbortSignal) => {
    if (!projectName) return
    const project = projectName
    try {
      const res = await fetch(`/api/worktrees/${encodeURIComponent(project)}`, { signal })
      if (!res.ok || currentProject.current !== project) return
      const data = await res.json() as { worktrees: WorktreeInfo[] }
      if (currentProject.current !== project) return
      setWorktrees(data.worktrees ?? [])
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
  }, [fetch_, projectName])
  /* eslint-enable react-hooks/set-state-in-effect */

  useSSERefresh('filetree', fetch_)
  useSSERefresh('worktrees', fetch_)

  return worktrees
}
