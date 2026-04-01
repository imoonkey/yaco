import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { SOLARIZED_LIGHT } from '../lib/solarizedLight'
import { createFile, saveFileContent } from '../hooks/useApi'
import { TASKS_FILE_PATH, useTaskGraph } from '../hooks/useTaskGraph'
import { usePanZoom } from '../hooks/usePanZoom'
import { useIsMobile } from '../hooks/useIsMobile'
import type { TaskState } from './taskGraphModel'
import { computeDisplayLayout } from './taskGraphModel'
import { type Selection, computeHighlight, searchTasks, EMPTY_HIGHLIGHT } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { TaskGraphTooltip } from './TaskGraphTooltip'
import { TaskGraphCanvas } from './TaskGraphCanvas'
import { TaskGraphToolbar } from './TaskGraphToolbar'
import { TaskGraphDetailPanel } from './TaskGraphDetailPanel'
import { TaskGraphMinimap } from './TaskGraphMinimap'

const ALL_STATES: TaskState[] = ['ready', 'running', 'done', 'blocked', 'cancelled']

function isInputLikeElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

function StateButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1.5 rounded text-[12px] font-medium cursor-pointer transition-colors disabled:cursor-default disabled:opacity-60"
      style={{
        backgroundColor: SOLARIZED_LIGHT.base2,
        color: SOLARIZED_LIGHT.base01,
        border: `1px solid ${SOLARIZED_LIGHT.border}`,
      }}
    >
      {label}
    </button>
  )
}

function StatePane({
  title,
  message,
  tone,
  actions,
  detail,
}: {
  title: string
  message: string
  tone: string
  actions?: React.ReactNode
  detail?: string | null
}) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-[440px] rounded-md border px-5 py-4 text-center" style={{ borderColor: SOLARIZED_LIGHT.border, backgroundColor: SOLARIZED_LIGHT.base3 }}>
        <div className="text-[15px] font-semibold" style={{ color: tone }}>{title}</div>
        <div className="mt-2 text-[12px]" style={{ color: SOLARIZED_LIGHT.base01 }}>{message}</div>
        {actions && <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div>}
        {detail && <div className="mt-3 text-[11px]" style={{ color: SOLARIZED_LIGHT.base1 }}>{detail}</div>}
      </div>
    </div>
  )
}

export function TaskGraphScreen({ projectName, onOpenTasksFile }: { projectName: string; onOpenTasksFile?: () => void }) {
  const { status, graph, error, warnings, refresh } = useTaskGraph(projectName)
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  const [selection, setSelection] = useState<Selection>(null)
  const [filters, setFilters] = useState<Set<TaskState>>(() => new Set(ALL_STATES))
  const [searchQuery, setSearchQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // --- Collapse state ---
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`workflow-taskgraph:${projectName}`)
      if (stored) {
        const parsed = JSON.parse(stored)
        // Support both old and new format
        const ids = parsed.collapsedTaskIds ?? parsed.collapsedMilestones
        if (Array.isArray(ids)) return new Set(ids)
      }
    } catch { /* ignore */ }
    return new Set()
  })

  // Persist collapse state
  useEffect(() => {
    localStorage.setItem(`workflow-taskgraph:${projectName}`,
      JSON.stringify({ collapsedTaskIds: [...collapsedTaskIds] }))
  }, [projectName, collapsedTaskIds])

  // Compute display layout from model + view state (graph-only data already on model)
  const displayLayout = useMemo(() => {
    if (!graph) return null
    return computeDisplayLayout(
      { tasks: graph.tasks, childIdsByTask: graph.childIdsByTask, rootIds: graph.rootIds, subtreeIdsByTask: graph.subtreeIdsByTask, dependenciesByTask: graph.dependenciesByTask },
      { collapsedTaskIds, filters },
      graph.aggregateStateByTask,
      graph.leafProgressByTask,
      graph.cycleEdgeIds,
    )
  }, [graph, collapsedTaskIds, filters])

  const graphBounds = displayLayout?.bounds ?? { width: 0, height: 0 }
  const panZoom = usePanZoom({ graphBounds, containerRef })

  const clickConsumed = useRef(false)

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

  const prevViewportRef = useRef(panZoom.state)
  useEffect(() => {
    const prev = prevViewportRef.current
    prevViewportRef.current = panZoom.state
    if (prev.tx !== panZoom.state.tx || prev.ty !== panZoom.state.ty || prev.scale !== panZoom.state.scale) {
      clearTooltip()
    }
  }, [panZoom.state, clearTooltip])

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
        // If selected task is inside this subtree, move selection to the collapsing task
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
    // Move selection to nearest visible ancestor if needed
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

  // Derive search match IDs
  const searchMatchIds = useMemo(() => {
    if (!graph || !searchQuery.trim()) return new Set<string>()
    return new Set(searchTasks(searchQuery, graph))
  }, [graph, searchQuery])

  // Track container size for minimap
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setContainerSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit to view on first data load
  const fittedRef = useRef(false)
  useEffect(() => {
    if (graph && !fittedRef.current && containerSize.width > 0) {
      fittedRef.current = true
      requestAnimationFrame(() => panZoom.fitToView(false))
    }
  }, [graph, containerSize.width, panZoom])

  // Compute highlight model
  const highlight = useMemo(() => {
    if (!graph || !selection) return EMPTY_HIGHLIGHT
    return computeHighlight(selection, graph)
  }, [graph, selection])

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

  // Pending pan target — set by handleNavigate, consumed by effect after layout recomputes
  const pendingPanRef = useRef<string | null>(null)

  const handleNavigate = useCallback((id: string) => {
    if (!graph) return
    // Auto-expand collapsed ancestors
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

  // Pan to pending target after layout recomputes
  useEffect(() => {
    const id = pendingPanRef.current
    if (!id || !displayLayout) return
    const node = displayLayout.nodes.get(id)
    if (node) {
      pendingPanRef.current = null
      panZoom.panTo(node.x + node.width / 2, node.y + node.height / 2)
    }
  }, [displayLayout, panZoom])

  const handleSearchSubmit = useCallback(() => {
    if (!graph || !searchQuery.trim()) return
    const results = searchTasks(searchQuery, graph)
    if (results.length > 0) handleNavigate(results[0])
  }, [graph, searchQuery, handleNavigate])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isInputLikeElement(document.activeElement)) return

      if (e.key === 'Escape') {
        setSelection(null)
        clearTooltip()
        return
      }
      if (e.key === '+' || e.key === '=') { panZoom.zoomIn(); return }
      if (e.key === '-') { panZoom.zoomOut(); return }
      if (e.key === '0') { panZoom.fitToView(); return }

      // Collapse shortcuts
      if (e.key === 'c' && !e.shiftKey && selection && graph?.tasks.get(selection)?.hasChildren) {
        handleToggleCollapse(selection)
        return
      }
      if (e.key === 'C' && e.shiftKey) {
        handleCollapseAll()
        return
      }
      if (e.key === 'E' && e.shiftKey) {
        handleExpandAll()
        return
      }

      if (!displayLayout) return

      // Tab: DFS traversal
      if (e.key === 'Tab') {
        e.preventDefault()
        const order = displayLayout.visibleOrder
        if (order.length === 0) return
        if (!selection) {
          handleNavigate(order[0])
        } else {
          const idx = order.indexOf(selection)
          const next = e.shiftKey
            ? (idx <= 0 ? order.length - 1 : idx - 1)
            : ((idx + 1) % order.length)
          handleNavigate(order[next])
        }
        return
      }

      if (!selection || !graph) return

      const order = displayLayout.visibleOrder
      const task = graph.tasks.get(selection)
      if (!task) return

      // ArrowUp/ArrowDown: previous/next in DFS visible order
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const idx = order.indexOf(selection)
        if (idx === -1) return
        const next = e.key === 'ArrowUp' ? idx - 1 : idx + 1
        if (next >= 0 && next < order.length) {
          handleNavigate(order[next])
        }
        return
      }

      // ArrowLeft: collapse or go to parent
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (task.hasChildren && !collapsedTaskIds.has(selection)) {
          // Collapse without changing selection
          handleToggleCollapse(selection)
        } else if (task.parent) {
          handleNavigate(task.parent)
        } else {
          // At root level — go to previous root
          const rootIdx = graph.rootIds.indexOf(selection)
          if (rootIdx > 0) handleNavigate(graph.rootIds[rootIdx - 1])
        }
        return
      }

      // ArrowRight: expand or go to first child
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (task.hasChildren && collapsedTaskIds.has(selection)) {
          // Expand without changing selection
          handleToggleCollapse(selection)
        } else {
          const visChildren = displayLayout.visibleChildrenByTask.get(selection) ?? []
          if (visChildren.length > 0) {
            handleNavigate(visChildren[0])
          } else if (!task.parent) {
            // At root level — go to next root
            const rootIdx = graph.rootIds.indexOf(selection)
            if (rootIdx !== -1 && rootIdx < graph.rootIds.length - 1) handleNavigate(graph.rootIds[rootIdx + 1])
          }
        }
        return
      }

      // Home / End
      if (e.key === 'Home') {
        e.preventDefault()
        if (order.length > 0) handleNavigate(order[0])
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        if (order.length > 0) handleNavigate(order[order.length - 1])
        return
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [graph, displayLayout, selection, panZoom, handleNavigate, clearTooltip, collapsedTaskIds, handleToggleCollapse, handleCollapseAll, handleExpandAll])

  const handleCreateTasksFile = useCallback(async () => {
    if (creating) return
    setCreating(true)
    setActionError(null)
    try {
      await createFile(projectName, TASKS_FILE_PATH)
      await saveFileContent(projectName, TASKS_FILE_PATH, '{}\n')
      refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create tasks.json'
      if (message.startsWith('409')) {
        refresh()
      } else {
        setActionError(message)
      }
    } finally {
      setCreating(false)
    }
  }, [creating, projectName, refresh])

  // Loading state
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: SOLARIZED_LIGHT.base1 }}>
        Loading task graph...
      </div>
    )
  }

  if (status === 'missing') {
    return (
      <StatePane
        title="No tasks.json yet"
        message="This project does not have a task graph file yet."
        tone={SOLARIZED_LIGHT.base01}
        actions={
          <>
            {onOpenTasksFile && <StateButton label="Open tasks.json" onClick={onOpenTasksFile} />}
            <StateButton label={creating ? 'Creating\u2026' : 'Create tasks.json'} onClick={() => { void handleCreateTasksFile() }} disabled={creating} />
          </>
        }
        detail={actionError}
      />
    )
  }

  if (status === 'error' || !graph || !displayLayout) {
    return (
      <StatePane
        title="Unable to load task graph"
        message={error?.message ?? 'Failed to load tasks'}
        tone={SOLARIZED_LIGHT.red}
        actions={
          <>
            {onOpenTasksFile && <StateButton label="Open tasks.json" onClick={onOpenTasksFile} />}
            <StateButton label="Retry" onClick={refresh} />
          </>
        }
      />
    )
  }

  if (graph.tasks.size === 0) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: SOLARIZED_LIGHT.base1 }}>
        No tasks defined
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <TaskGraphToolbar
        scale={panZoom.state.scale}
        filters={filters}
        searchQuery={searchQuery}
        searchMatchCount={searchMatchIds.size}
        allCollapsed={allCollapsed}
        allExpanded={allExpanded}
        onZoomIn={panZoom.zoomIn}
        onZoomOut={panZoom.zoomOut}
        onFitToView={() => panZoom.fitToView()}
        onToggleFilter={handleToggleFilter}
        onSearchChange={setSearchQuery}
        onSearchSubmit={handleSearchSubmit}
        onCollapseAll={handleCollapseAll}
        onExpandAll={handleExpandAll}
      />

      {warnings.length > 0 && (
        <div className="px-3 py-1 text-[11px]" style={{ backgroundColor: SOLARIZED_LIGHT.yellow + '22', color: SOLARIZED_LIGHT.yellow }}>
          {warnings.length} warning{warnings.length > 1 ? 's' : ''}: {warnings[0]}
          {warnings.length > 1 && ` (+${warnings.length - 1} more)`}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div ref={containerRef} className="relative flex-1 overflow-hidden">
          <TaskGraphCanvas
            graph={graph}
            layout={displayLayout}
            searchMatchIds={searchMatchIds}
            transform={panZoom.transform}
            highlight={highlight}
            selection={selection}
            scale={panZoom.state.scale}
            collapsedTaskIds={collapsedTaskIds}
            handlers={panZoom.handlers}
            onSelectTask={handleSelectTask}
            onClearSelection={handleClearSelection}
            onToggleCollapse={handleToggleCollapse}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
          />

          {tooltipTarget && (
            <TaskGraphTooltip
              target={tooltipTarget}
              graph={graph}
              viewportTransform={panZoom.state}
              containerRef={containerRef}
            />
          )}

          {!isMobile && (
            <TaskGraphMinimap
              layout={displayLayout}
              graph={graph}
              viewport={panZoom.state}
              containerWidth={containerSize.width}
              containerHeight={containerSize.height}
              onPanTo={panZoom.panTo}
            />
          )}

          {isMobile && (
            <TaskGraphDetailPanel
              selection={selection}
              graph={graph}
              isMobile
              onClose={handleClearSelection}
              onNavigate={handleNavigate}
              collapsedTaskIds={collapsedTaskIds}
              onToggleCollapse={handleToggleCollapse}
            />
          )}
        </div>

        {!isMobile && selection && (
          <TaskGraphDetailPanel
            selection={selection}
            graph={graph}
            isMobile={false}
            onClose={handleClearSelection}
            onNavigate={handleNavigate}
            collapsedTaskIds={collapsedTaskIds}
            onToggleCollapse={handleToggleCollapse}
          />
        )}
      </div>
    </div>
  )
}
