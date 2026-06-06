import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { TaskState, TaskGraphModel } from './taskGraphModel'
import { type Selection, computeHighlight, searchTasks, EMPTY_HIGHLIGHT } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'

export type TaskWorkspaceLayout = 'stacked' | 'dag'
export type Workset = 'active' | 'backlog' | 'archive'

export type TaskGraphFilters = {
  states: Set<TaskState>
  worksets: Set<Workset>
}

const ALL_STATES: TaskState[] = ['ready', 'running', 'done', 'blocked', 'cancelled']
const ALL_WORKSETS: Workset[] = ['active', 'backlog', 'archive']
const DEFAULT_WORKSETS: Workset[] = ['active', 'backlog']

export type TaskGraphInteraction = ReturnType<typeof useTaskGraphInteraction>

// Persisted workspace state (new key). Unknown/stale layout resolves to stacked.
type LoadedWorkspace = {
  layout: TaskWorkspaceLayout
  worksets: Set<Workset>
  states: Set<TaskState>
  collapsed: Set<string>
}

function loadWorkspace(project: string): LoadedWorkspace {
  const base: LoadedWorkspace = {
    layout: 'stacked',
    worksets: new Set(DEFAULT_WORKSETS),
    states: new Set(ALL_STATES),
    collapsed: new Set(),
  }
  try {
    const stored = localStorage.getItem(`yaco-task-workspace:${project}`)
    if (!stored) return base
    const p = JSON.parse(stored)
    const worksets = Array.isArray(p.worksets) ? p.worksets.filter((w: unknown): w is Workset => ALL_WORKSETS.includes(w as Workset)) : []
    const states = Array.isArray(p.states) ? p.states.filter((s: unknown): s is TaskState => ALL_STATES.includes(s as TaskState)) : []
    return {
      // DAG isn't built yet; any stored layout resolves to stacked until it ships.
      layout: 'stacked',
      worksets: worksets.length ? new Set(worksets) : new Set(DEFAULT_WORKSETS),
      states: states.length ? new Set(states) : new Set(ALL_STATES),
      collapsed: Array.isArray(p.collapsedTaskIds) ? new Set(p.collapsedTaskIds) : new Set(),
    }
  } catch {
    return base
  }
}

export function useTaskGraphInteraction(
  projectName: string,
  graph: TaskGraphModel | null,
  panZoom: { didDrag: React.RefObject<boolean> },
  isMobile: boolean,
) {
  const [initial] = useState(() => loadWorkspace(projectName))
  const [selection, setSelection] = useState<Selection>(null)
  const [layout, setLayout] = useState<TaskWorkspaceLayout>(initial.layout)
  const [stateFilters, setStateFilters] = useState<Set<TaskState>>(initial.states)
  const [worksets, setWorksets] = useState<Set<Workset>>(initial.worksets)
  const [searchQuery, setSearchQuery] = useState('')

  const filters = useMemo<TaskGraphFilters>(() => ({ states: stateFilters, worksets }), [stateFilters, worksets])

  const clickConsumed = useRef(false)

  // --- Collapse state ---
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(initial.collapsed)

  // Persist workspace state under the new key
  useEffect(() => {
    localStorage.setItem(`yaco-task-workspace:${projectName}`, JSON.stringify({
      layout,
      worksets: [...worksets],
      states: [...stateFilters],
      collapsedTaskIds: [...collapsedTaskIds],
    }))
  }, [projectName, layout, worksets, stateFilters, collapsedTaskIds])

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
    setSelection(id)
  }, [clearTooltip])

  const handleClearSelection = useCallback(() => {
    if (panZoom.didDrag.current) return
    if (clickConsumed.current) return
    clearTooltip()
    setSelection(null)
  }, [clearTooltip, panZoom.didDrag])

  const handleToggleFilter = useCallback((state: TaskState) => {
    setStateFilters(prev => {
      const next = new Set(prev)
      if (next.has(state)) next.delete(state)
      else next.add(state)
      return next
    })
  }, [])

  const handleToggleWorkset = useCallback((workset: Workset) => {
    setWorksets(prev => {
      const next = new Set(prev)
      if (next.has(workset)) next.delete(workset)
      else next.add(workset)
      return next
    })
    // Selection that becomes hidden by this change is cleared centrally where the
    // rendered layout is known (TaskGraphScreen), so any filter is covered.
  }, [])

  // --- Navigate to node ---
  const pendingPanRef = useRef<string | null>(null)
  const clearPendingPan = useCallback(() => { pendingPanRef.current = null }, [])

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
    layout,
    setLayout,
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
    handleToggleWorkset,
    handleToggleCollapse,
    handleCollapseAll,
    handleExpandAll,
    handleNavigate,
    handleSearchSubmit,
    handlePointerEnter,
    handlePointerLeave,
    clearTooltip,
    pendingPanRef,
    clearPendingPan,
  }
}
