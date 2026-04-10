import { useCallback, useEffect } from 'react'
import { useResize } from './useResize'
import type { WorkspaceLayout } from '../hooks/workspaceTypes'

interface UseWorkspaceSidebarResizeOpts {
  layout: WorkspaceLayout
  sidebarRef: React.RefObject<HTMLDivElement | null>
  showProjects: boolean
  showExplorer: boolean
  showChanges: boolean
  showTextSearch: boolean
  showTasks: boolean
  showSessions: boolean
  updateLayout: (patch: Partial<WorkspaceLayout>) => void
}

export function useWorkspaceSidebarResize(opts: UseWorkspaceSidebarResizeOpts) {
  const {
    layout, sidebarRef,
    showProjects, showExplorer, showChanges, showTextSearch, showTasks,
    updateLayout,
  } = opts

  const projectSplit = useResize(layout.projectSize, 40, 300, 'down')
  const projectHeight = projectSplit.size
  const left = useResize(layout.leftSize, 140, 600)
  const right = useResize(layout.rightSize, 250, 900, 'right')

  // Available space for bottom sections = sidebar - headers - projects - explorer min
  const bottomAvailable = useCallback(() => {
    const el = sidebarRef.current
    if (!el) return 400
    const sidebarH = el.clientHeight
    const headers = 5 * 22 // Projects, Explorer, Changes, Search, Tasks
    const projectsH = showProjects ? projectSplit.size : 0
    const explorerMinH = showExplorer ? 80 : 0
    const tasksH = showTasks ? 50 : 0
    const handles = 6 // ~2 resize handles × 3px
    return Math.max(100, sidebarH - headers - projectsH - explorerMinH - tasksH - handles)
  }, [showProjects, showExplorer, showTasks, projectSplit.size, sidebarRef])

  const searchMax = useCallback(() => {
    const changesMinH = showChanges ? 50 : 0
    return Math.max(50, bottomAvailable() - changesMinH)
  }, [bottomAvailable, showChanges])

  const searchSplit = useResize(layout.searchSize, 50, searchMax, 'up')
  const searchHeight = showTextSearch ? searchSplit.size : 0

  const changesMax = useCallback(() => {
    const searchMinH = showTextSearch ? 50 : 0
    return Math.max(50, bottomAvailable() - searchMinH)
  }, [bottomAvailable, showTextSearch])

  const changesSplit = useResize(layout.changesSize, 50, changesMax, 'up')
  const changesHeight = showChanges ? changesSplit.size : 0

  const sessionSplit = useResize(layout.sessionSize, 50, 400, 'up')
  const sessionHeight = opts.showSessions ? sessionSplit.size : 0

  // Re-clamp when available space shrinks
  useEffect(() => {
    const maxC = changesMax()
    const maxS = searchMax()
    if (changesSplit.size > maxC) changesSplit.setSize(maxC)
    if (searchSplit.size > maxS) searchSplit.setSize(maxS)
  }, [changesMax, searchMax, changesSplit, searchSplit])

  // Sync resize handle sizes back to layout state for persistence
  useEffect(() => {
    updateLayout({
      leftSize: left.size,
      rightSize: right.size,
      searchSize: searchSplit.size,
      changesSize: changesSplit.size,
      sessionSize: sessionSplit.size,
      projectSize: projectSplit.size,
    })
  }, [left.size, right.size, searchSplit.size, changesSplit.size, sessionSplit.size, projectSplit.size, updateLayout])

  return {
    left, right,
    projectSplit, projectHeight,
    searchSplit, searchHeight,
    changesSplit, changesHeight,
    sessionSplit, sessionHeight,
  }
}
