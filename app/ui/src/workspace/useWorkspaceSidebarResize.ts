import { useCallback, useEffect } from 'react'
import { useResize } from './useResize'
import type { WorkspaceLayout } from '../hooks/workspaceTypes'

interface UseWorkspaceSidebarResizeOpts {
  layout: WorkspaceLayout
  sidebarRef: React.RefObject<HTMLDivElement | null>
  showProjects: boolean
  showExplorer: boolean
  showChanges: boolean
  showTasks: boolean
  showSessions: boolean
  updateLayout: (patch: Partial<WorkspaceLayout>) => void
}

export function useWorkspaceSidebarResize(opts: UseWorkspaceSidebarResizeOpts) {
  const {
    layout, sidebarRef,
    showProjects, showExplorer, showChanges, showTasks,
    updateLayout,
  } = opts

  const projectSplit = useResize(layout.projectSize, 40, 300, 'down')
  const projectHeight = projectSplit.size
  const left = useResize(layout.leftSize, 140, 600)

  // Right panel max: viewport width minus sidebar minus an editor-min reserve,
  // so the editor never disappears but users on wide monitors can pull the
  // shell as wide as they like.
  const rightMax = useCallback(() => {
    const vw = typeof window === 'undefined' ? 1600 : window.innerWidth
    const sidebarW = layout.showSidebar ? left.size : 0
    const editorMin = 200
    return Math.max(250, vw - sidebarW - editorMin)
  }, [layout.showSidebar, left.size])
  const right = useResize(layout.rightSize, 250, rightMax, 'right')

  // Available space for bottom sections = sidebar - headers - projects - explorer min
  const bottomAvailable = useCallback(() => {
    const el = sidebarRef.current
    if (!el) return 400
    const sidebarH = el.clientHeight
    const headers = 4 * 22 // Projects, Explorer, Changes, Tasks
    const projectsH = showProjects ? projectSplit.size : 0
    const explorerMinH = showExplorer ? 80 : 0
    const tasksH = showTasks ? 50 : 0
    const handles = 4 // ~2 resize handles × 2px
    return Math.max(100, sidebarH - headers - projectsH - explorerMinH - tasksH - handles)
  }, [showProjects, showExplorer, showTasks, projectSplit.size, sidebarRef])

  const changesMax = useCallback(() => {
    return Math.max(50, bottomAvailable())
  }, [bottomAvailable])

  const changesSplit = useResize(layout.changesSize, 50, changesMax, 'up')
  const changesHeight = showChanges ? changesSplit.size : 0

  const sessionSplit = useResize(layout.sessionSize, 50, 400, 'up')
  const sessionHeight = opts.showSessions ? sessionSplit.size : 0

  // Re-clamp when available space shrinks
  useEffect(() => {
    const maxC = changesMax()
    const maxR = rightMax()
    if (changesSplit.size > maxC) changesSplit.setSize(maxC)
    if (right.size > maxR) right.setSize(maxR)
  }, [changesMax, rightMax, changesSplit, right])

  // React to viewport resize so rightMax stays correct
  useEffect(() => {
    const onResize = () => {
      const maxR = rightMax()
      if (right.size > maxR) right.setSize(maxR)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [rightMax, right])

  // Sync resize handle sizes back to layout state for persistence
  useEffect(() => {
    updateLayout({
      leftSize: left.size,
      rightSize: right.size,
      changesSize: changesSplit.size,
      sessionSize: sessionSplit.size,
      projectSize: projectSplit.size,
    })
  }, [left.size, right.size, changesSplit.size, sessionSplit.size, projectSplit.size, updateLayout])

  return {
    left, right,
    projectSplit, projectHeight,
    changesSplit, changesHeight,
    sessionSplit, sessionHeight,
  }
}
