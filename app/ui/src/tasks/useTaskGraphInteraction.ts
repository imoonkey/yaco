import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { TaskState, TaskGraphModel } from './taskGraphModel'
import { type Selection, computeHighlight, searchTasks, EMPTY_HIGHLIGHT } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'

const ALL_STATES: TaskState[] = ['ready', 'running', 'done', 'blocked', 'cancelled']

export type TaskGraphInteraction = ReturnType<typeof useTaskGraphInteraction>

export function useTaskGraphInteraction(
  projectName: string,
  graph: TaskGraphModel | null,
  panZoom: { didDrag: React.RefObject<boolean> },
  isMobile: boolean,
) {
  const [selection, setSelection] = useState<Selection>(null)
  const [filters, setFilters] = useState<Set<TaskState>>(() => new Set(ALL_STATES))
  const [searchQuery, setSearchQuery] = useState('')

  const clickConsumed = useRef(false)

  // --- Collapse state ---
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`yaco-taskgraph:${projectName}`)
      if (stored) {
        const parsed = JSON.parse(stored)
        const ids = parsed.collapsedTaskIds ?? parsed.collapsedMilestones
        if (Array.isArray(ids)) return new Set(ids)
      }
    } catch { /* ignore */ }
    return new Set()
  })

  // Persist collapse state
  useEffect(() => {
    localStorage.setItem(`yaco-taskgraph:${projectName}`,
      JSON.stringify({ collapsedTaskIds: [...collapsedTaskIds] }))
  }, [projectName, collapsedTaskIds])

  // --- Tooltip state ---
  const [tooltipTarget, setTooltipTarget] = useState<TooltipTarget | null>(null)
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTooltip = useCallback(() => {
    if (tooltipTimerRef.current) {
      clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = null
    }
    setTooltipTarget(null)
  }, [])

  const handlePointerEnter = useCallback((target: TooltipTarget) => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
    tooltipTimerRef.current = setTimeout(() => {
      setTooltipTarget(target)
    }, isMobile ? 500 : 400)
  }, [isMobile])

  const handlePointerLeave = useCallback(() => {
    clearTooltip()
  }, [clearTooltip])

  // --- Collapse handlers ---
  const handleToggleCollapse = useCallback((taskId: string) => {
    clickConsumed.current = true
    queueMicrotask(() => { clickConsumed.current = false })
    clearTooltip()
    setCollapsedTaskIds(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
        if (selection && graph) {
          const subtree = graph.subtreeIdsByTask.get(taskId) ?? []
          if (subtree.includes(selection) && selection !== taskId) {
            setSelection(taskId)
          }
        }
      }
      return next
    })
  }, [selection, graph, clearTooltip])

  const handleCollapseAll = useCallback(() => {
    if (!graph) return
    clearTooltip()
    const expandable = new Set<string>()
    for (const [id, task] of graph.tasks) {
      if (task.hasChildren) expandable.add(id)
    }
    setCollapsedTaskIds(expandable)
    if (selection) {
      let current = selection
      while (current) {
        const task = graph.tasks.get(current)
        if (!task?.parent) break
        if (expandable.has(current) || !expandable.has(task.parent)) break
        current = task.parent
      }
      if (current !== selection) setSelection(current)
    }
  }, [graph, selection, clearTooltip])

  const handleExpandAll = useCallback(() => {
    clearTooltip()
    setCollapsedTaskIds(new Set())
  }, [clearTooltip])

  // Collapse toolbar state
  const expandableCount = useMemo(() => {
    if (!graph) return 0
    let count = 0
    for (const task of graph.tasks.values()) {
      if (task.hasChildren) count++
    }
    return count
  }, [graph])
  const allCollapsed = expandableCount > 0 && collapsedTaskIds.size >= expandableCount
  const allExpanded = collapsedTaskIds.size === 0

  // --- Search ---
  const searchMatchIds = useMemo(() => {
    if (!graph || !searchQuery.trim()) return new Set<string>()
    return new Set(searchTasks(searchQuery, graph))
  }, [graph, searchQuery])

  // --- Highlight ---
  const highlight = useMemo(() => {
    if (!graph || !selection) return EMPTY_HIGHLIGHT
    return computeHighlight(selection, graph)
  }, [graph, selection])

  // --- Selection handlers ---
  const handleSelectTask = useCallback((id: string) => {
    clickConsumed.current = true
    queueMicrotask(() => { clickConsumed.current = false })
    clearTooltip()
    setSelection(prev => prev === id ? null : id)
  }, [clearTooltip])

  const handleClearSelection = useCallback(() => {
    if (panZoom.didDrag.current) return
    if (clickConsumed.current) return
    clearTooltip()
    setSelection(null)
  }, [clearTooltip, panZoom.didDrag])

  const handleToggleFilter = useCallback((state: TaskState) => {
    setFilters(prev => {
      const next = new Set(prev)
      if (next.has(state)) next.delete(state)
      else next.add(state)
      return next
    })
  }, [])

  // --- Navigate to node ---
  const pendingPanRef = useRef<string | null>(null)

  const handleNavigate = useCallback((id: string) => {
    if (!graph) return
    const task = graph.tasks.get(id)
    if (task) {
      let ancestor = task.parent
      const visited = new Set<string>()
      while (ancestor && !visited.has(ancestor)) {
        visited.add(ancestor)
        if (collapsedTaskIds.has(ancestor)) {
          setCollapsedTaskIds(prev => {
            const next = new Set(prev)
            next.delete(ancestor!)
            return next
          })
        }
        ancestor = graph.tasks.get(ancestor)?.parent ?? null
      }
    }
    setSelection(id)
    pendingPanRef.current = id
  }, [graph, collapsedTaskIds])

  const handleSearchSubmit = useCallback(() => {
    if (!graph || !searchQuery.trim()) return
    const results = searchTasks(searchQuery, graph)
    if (results.length > 0) handleNavigate(results[0])
  }, [graph, searchQuery, handleNavigate])

  return {
    selection,
    setSelection,
    filters,
    searchQuery,
    setSearchQuery,
    searchMatchIds,
    collapsedTaskIds,
    highlight,
    tooltipTarget,
    allCollapsed,
    allExpanded,

    handleSelectTask,
    handleClearSelection,
    handleToggleFilter,
    handleToggleCollapse,
    handleCollapseAll,
    handleExpandAll,
    handleNavigate,
    handleSearchSubmit,
    handlePointerEnter,
    handlePointerLeave,
    clearTooltip,
    pendingPanRef,
  }
}
