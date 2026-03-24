import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { SOLARIZED_LIGHT } from '../lib/solarizedLight'
import { useTaskGraph } from '../hooks/useTaskGraph'
import { usePanZoom } from '../hooks/usePanZoom'
import { useIsMobile } from '../hooks/useIsMobile'
import type { TaskState } from './taskGraphModel'
import { computeCollapsedLayout } from './taskGraphModel'
import { type Selection, computeHighlight, searchTasks, EMPTY_HIGHLIGHT } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { TaskGraphTooltip } from './TaskGraphTooltip'
import { TaskGraphCanvas } from './TaskGraphCanvas'
import { TaskGraphToolbar } from './TaskGraphToolbar'
import { TaskGraphDetailPanel } from './TaskGraphDetailPanel'
import { TaskGraphMinimap } from './TaskGraphMinimap'

const ALL_STATES: TaskState[] = ['ready', 'running', 'done', 'blocked', 'cancelled']

export function TaskGraphScreen({ projectName }: { projectName: string }) {
  const { status, graph, error, warnings } = useTaskGraph(projectName)
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  const [selection, setSelection] = useState<Selection>(null)
  const [filters, setFilters] = useState<Set<TaskState>>(() => new Set(ALL_STATES))
  const [searchQuery, setSearchQuery] = useState('')

  // --- Collapse state ---
  const [collapsedMilestones, setCollapsedMilestones] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`workflow-taskgraph:${projectName}`)
      if (stored) {
        const { collapsedMilestones: cm } = JSON.parse(stored)
        if (Array.isArray(cm)) return new Set(cm)
      }
    } catch { /* ignore */ }
    return new Set()
  })

  // Persist collapse state
  useEffect(() => {
    localStorage.setItem(`workflow-taskgraph:${projectName}`,
      JSON.stringify({ collapsedMilestones: [...collapsedMilestones] }))
  }, [projectName, collapsedMilestones])

  // Compute display layout with collapsed milestones
  const displayLayout = useMemo(() => {
    if (!graph || collapsedMilestones.size === 0) return graph?.layout ?? null
    return computeCollapsedLayout(graph.layout, collapsedMilestones)
  }, [graph, collapsedMilestones])

  const graphBounds = displayLayout?.bounds ?? { width: 0, height: 0 }
  const panZoom = usePanZoom({ graphBounds, containerRef })

  // Ref to prevent SVG onClick from clearing selection set by child element clicks.
  // Child onClick calls stopPropagation, but in React's synthetic event system for SVG
  // this may not reliably prevent the SVG handler from firing.
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

  // Dismiss tooltip on viewport changes (pan/zoom)
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
  const handleToggleCollapse = useCallback((milestoneId: string) => {
    clickConsumed.current = true
    queueMicrotask(() => { clickConsumed.current = false })
    clearTooltip()
    setCollapsedMilestones(prev => {
      const next = new Set(prev)
      if (next.has(milestoneId)) {
        next.delete(milestoneId)
      } else {
        next.add(milestoneId)
        // Clear selection if selected task is inside this milestone
        if (selection?.type === 'task' && graph) {
          const node = graph.layout.nodes.get(selection.id)
          if (node?.columnId === milestoneId) setSelection(null)
        }
      }
      return next
    })
  }, [selection, graph, clearTooltip])

  const handleCollapseAll = useCallback(() => {
    if (!graph) return
    clearTooltip()
    const allIds = new Set(graph.layout.columns.filter(c => c.taskIds.length > 0).map(c => c.id))
    setCollapsedMilestones(allIds)
    if (selection?.type === 'task') setSelection(null)
  }, [graph, selection, clearTooltip])

  const handleExpandAll = useCallback(() => {
    clearTooltip()
    setCollapsedMilestones(new Set())
  }, [clearTooltip])

  // Collapse toolbar state
  const milestoneCount = graph?.layout.columns.filter(c => c.taskIds.length > 0).length ?? 0
  const allCollapsed = milestoneCount > 0 && collapsedMilestones.size >= milestoneCount
  const allExpanded = collapsedMilestones.size === 0

  // Derive search match IDs from query
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
    setSelection(prev => prev?.type === 'task' && prev.id === id ? null : { type: 'task', id })
  }, [clearTooltip])

  const handleSelectMilestone = useCallback((id: string) => {
    clickConsumed.current = true
    queueMicrotask(() => { clickConsumed.current = false })
    clearTooltip()
    setSelection(prev => prev?.type === 'milestone' && prev.id === id ? null : { type: 'milestone', id })
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

  const handleNavigate = useCallback((id: string) => {
    if (!graph) return
    // Check if it's a milestone
    const col = graph.layout.columns.find(c => c.id === id)
    if (col) {
      setSelection({ type: 'milestone', id })
      panZoom.panTo(col.x + col.width / 2, col.y + col.height / 2)
      return
    }
    // Auto-expand collapsed milestone if navigating to a task inside it
    const node = graph.layout.nodes.get(id)
    if (node && collapsedMilestones.has(node.columnId)) {
      setCollapsedMilestones(prev => { const next = new Set(prev); next.delete(node.columnId); return next })
    }
    setSelection({ type: 'task', id })
    if (node) panZoom.panTo(node.x + node.width / 2, node.y + node.height / 2)
  }, [graph, panZoom, collapsedMilestones])

  const handleSearchSubmit = useCallback(() => {
    if (!graph || !searchQuery.trim()) return
    const results = searchTasks(searchQuery, graph)
    if (results.length > 0) handleNavigate(results[0])
  }, [graph, searchQuery, handleNavigate])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT') return

      if (e.key === 'Escape') {
        setSelection(null)
        clearTooltip()
        return
      }
      if (e.key === '+' || e.key === '=') { panZoom.zoomIn(); return }
      if (e.key === '-') { panZoom.zoomOut(); return }
      if (e.key === '0') { panZoom.fitToView(); return }

      // Collapse keyboard shortcuts
      if (e.key === 'c' && !e.shiftKey && selection?.type === 'milestone') {
        handleToggleCollapse(selection.id)
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

      // Tab: entry point when nothing selected, or cycle through nodes
      if (e.key === 'Tab' && graph) {
        e.preventDefault()
        const allNodes = graph.layout.columns.flatMap(c => c.taskIds)
        if (allNodes.length === 0) return
        if (!selection || selection.type !== 'task') {
          handleNavigate(allNodes[0])
        } else {
          const idx = allNodes.indexOf(selection.id)
          const next = (idx + 1) % allNodes.length
          handleNavigate(allNodes[next])
        }
        return
      }

      // Arrow key navigation
      if (!graph || !selection) return

      // Handle milestone selected with arrow keys
      if (selection.type === 'milestone') {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          const colIdx = graph.layout.columns.findIndex(c => c.id === selection.id)
          const nextColIdx = e.key === 'ArrowLeft' ? colIdx - 1 : colIdx + 1
          const nextCol = graph.layout.columns[nextColIdx]
          if (nextCol) {
            if (collapsedMilestones.has(nextCol.id)) {
              setSelection({ type: 'milestone', id: nextCol.id })
            } else if (nextCol.taskIds.length > 0) {
              handleNavigate(nextCol.taskIds[0])
            }
          }
        }
        return
      }

      if (selection.type !== 'task') return
      const node = graph.layout.nodes.get(selection.id)
      if (!node) return

      const col = graph.layout.columns.find(c => c.id === node.columnId)
      if (!col) return

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const idx = col.taskIds.indexOf(selection.id)
        const next = e.key === 'ArrowUp' ? idx - 1 : idx + 1
        if (next >= 0 && next < col.taskIds.length) {
          handleNavigate(col.taskIds[next])
        }
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const colIdx = graph.layout.columns.indexOf(col)
        const nextColIdx = e.key === 'ArrowLeft' ? colIdx - 1 : colIdx + 1
        const nextCol = graph.layout.columns[nextColIdx]
        if (nextCol) {
          // If next column is collapsed, select the milestone
          if (collapsedMilestones.has(nextCol.id)) {
            setSelection({ type: 'milestone', id: nextCol.id })
            panZoom.panTo(nextCol.x + nextCol.width / 2, nextCol.y + nextCol.height / 2)
            return
          }
          if (nextCol.taskIds.length > 0) {
            // Find nearest node by Y
            const currentY = node.y + node.height / 2
            let closest = nextCol.taskIds[0]
            let minDist = Infinity
            for (const tid of nextCol.taskIds) {
              const n = graph.layout.nodes.get(tid)
              if (!n) continue
              const dist = Math.abs(n.y + n.height / 2 - currentY)
              if (dist < minDist) { minDist = dist; closest = tid }
            }
            handleNavigate(closest)
          }
        }
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [graph, selection, panZoom, handleNavigate, clearTooltip, collapsedMilestones, handleToggleCollapse, handleCollapseAll, handleExpandAll])

  // Compute hidden nodes from state filter + collapsed milestones
  const hiddenNodeIds = useMemo(() => {
    if (!graph) return new Set<string>()
    const hidden = new Set<string>()
    for (const [id, task] of graph.tasks) {
      if (!filters.has(task.state)) hidden.add(id)
    }
    // Nodes in collapsed milestones are already removed from displayLayout.nodes
    // but we also want to hide their edges from state filter
    return hidden
  }, [graph, filters])

  // Loading state
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: SOLARIZED_LIGHT.base1 }}>
        Loading task graph...
      </div>
    )
  }

  // Error state
  if (status === 'error' || !graph || !displayLayout) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: SOLARIZED_LIGHT.red }}>
        {error?.message ?? 'Failed to load tasks'}
      </div>
    )
  }

  // Empty state
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

      {/* Warnings banner */}
      {warnings.length > 0 && (
        <div className="px-3 py-1 text-[11px]" style={{ backgroundColor: SOLARIZED_LIGHT.yellow + '22', color: SOLARIZED_LIGHT.yellow }}>
          {warnings.length} warning{warnings.length > 1 ? 's' : ''}: {warnings[0]}
          {warnings.length > 1 && ` (+${warnings.length - 1} more)`}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Canvas area */}
        <div ref={containerRef} className="relative flex-1 overflow-hidden">
          <TaskGraphCanvas
            graph={graph}
            layout={displayLayout}
            hiddenNodeIds={hiddenNodeIds}
            searchMatchIds={searchMatchIds}
            transform={panZoom.transform}
            highlight={highlight}
            selection={selection}
            scale={panZoom.state.scale}
            collapsedMilestones={collapsedMilestones}
            handlers={panZoom.handlers}
            onSelectTask={handleSelectTask}
            onSelectMilestone={handleSelectMilestone}
            onClearSelection={handleClearSelection}
            onToggleCollapse={handleToggleCollapse}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
          />

          {/* Tooltip */}
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
              graph={graph}
              hiddenNodeIds={hiddenNodeIds}
              viewport={panZoom.state}
              containerWidth={containerSize.width}
              containerHeight={containerSize.height}
              onPanTo={panZoom.panTo}
            />
          )}

          {/* Mobile detail panel */}
          {isMobile && (
            <TaskGraphDetailPanel
              selection={selection}
              graph={graph}
              isMobile
              onClose={handleClearSelection}
              onNavigate={handleNavigate}
              collapsedMilestones={collapsedMilestones}
              onToggleCollapse={handleToggleCollapse}
            />
          )}
        </div>

        {/* Desktop detail panel */}
        {!isMobile && selection && (
          <TaskGraphDetailPanel
            selection={selection}
            graph={graph}
            isMobile={false}
            onClose={handleClearSelection}
            onNavigate={handleNavigate}
            collapsedMilestones={collapsedMilestones}
            onToggleCollapse={handleToggleCollapse}
          />
        )}
      </div>
    </div>
  )
}
