import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createFile, saveFileContent } from '../hooks/useApi'
import { TASKS_FILE_PATH, useTaskGraph } from '../hooks/useTaskGraph'
import { usePanZoom } from '../hooks/usePanZoom'
import { useIsMobile } from '../hooks/useIsMobile'
import { computeDisplayLayout } from './taskGraphModel'
import { TaskGraphTooltip } from './TaskGraphTooltip'
import { TaskGraphCanvas } from './TaskGraphCanvas'
import { TaskGraphToolbar } from './TaskGraphToolbar'
import { TaskGraphMinimap } from './TaskGraphMinimap'
import { TaskGraphStatusPane } from './TaskGraphStatusPane'
import { useTaskGraphInteraction } from './useTaskGraphInteraction'
import { useTaskGraphKeyboard } from './useTaskGraphKeyboard'

export function TaskGraphScreen({ projectName, onOpenTasksFile, onSelectTask, selectedTaskId }: { projectName: string; onOpenTasksFile?: () => void; onSelectTask?: (id: string | null) => void; selectedTaskId?: string | null }) {
  const { status, graph, error, warnings, refresh } = useTaskGraph(projectName)
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  // Interaction hook — selection, filters, collapse, search, tooltip, navigate
  const panZoomBoundsRef = useRef({ width: 0, height: 0 })
  const panZoom = usePanZoom({ graphBoundsRef: panZoomBoundsRef, containerRef })
  const ix = useTaskGraphInteraction(projectName, graph, panZoom, isMobile)

  // Sync graph selection → parent (emit selected task ID upward)
  const prevGraphSelection = useRef(ix.selection)
  useEffect(() => {
    if (ix.selection !== prevGraphSelection.current) {
      prevGraphSelection.current = ix.selection
      onSelectTask?.(ix.selection)
    }
  }, [ix.selection, onSelectTask])

  // Sync parent selection → graph (when cleared externally)
  useEffect(() => {
    if (selectedTaskId === null && ix.selection !== null) {
      ix.handleClearSelection()
    }
  }, [selectedTaskId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Compute display layout from graph + interaction view state
  const displayLayout = useMemo(() => {
    if (!graph) return null
    return computeDisplayLayout(
      { tasks: graph.tasks, childIdsByTask: graph.childIdsByTask, rootIds: graph.rootIds, subtreeIdsByTask: graph.subtreeIdsByTask, dependenciesByTask: graph.dependenciesByTask },
      { collapsedTaskIds: ix.collapsedTaskIds, filters: ix.filters },
      graph.aggregateStateByTask,
      graph.leafProgressByTask,
      graph.cycleEdgeIds,
      containerSize.width,
    )
  }, [graph, ix.collapsedTaskIds, ix.filters, containerSize.width])

  // Keep panZoom bounds in sync (read lazily by fitToView)
  useEffect(() => {
    panZoomBoundsRef.current = displayLayout?.bounds ?? { width: 0, height: 0 }
  })

  // Pan to pending navigate target after layout recomputes
  const { pendingPanRef, clearPendingPan } = ix
  useEffect(() => {
    const id = pendingPanRef.current
    if (!id || !displayLayout) return
    const node = displayLayout.nodes.get(id)
    if (node) {
      clearPendingPan()
      panZoom.panTo(node.x + node.width / 2, node.y + node.height / 2)
    }
  }, [displayLayout, panZoom, pendingPanRef, clearPendingPan])

  // Keyboard shortcuts
  useTaskGraphKeyboard(graph, displayLayout, ix.selection, ix.collapsedTaskIds, ix, panZoom)

  // Clear tooltip on viewport change
  const prevViewportRef = useRef(panZoom.state)
  useEffect(() => {
    const prev = prevViewportRef.current
    prevViewportRef.current = panZoom.state
    if (prev.tx !== panZoom.state.tx || prev.ty !== panZoom.state.ty || prev.scale !== panZoom.state.scale) {
      ix.clearTooltip()
    }
  }, [panZoom.state, ix])

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

  // Create tasks file handler
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

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

  // --- Status panes ---
  if (status === 'loading') {
    return <TaskGraphStatusPane status="loading" />
  }

  if (status === 'missing') {
    return (
      <TaskGraphStatusPane
        status="missing"
        creating={creating}
        actionError={actionError}
        onOpenTasksFile={onOpenTasksFile}
        onCreateTasksFile={() => { void handleCreateTasksFile() }}
      />
    )
  }

  if (status === 'error' || !graph || !displayLayout) {
    return (
      <TaskGraphStatusPane
        status="error"
        error={error}
        onOpenTasksFile={onOpenTasksFile}
        onRetry={refresh}
      />
    )
  }

  if (graph.tasks.size === 0) {
    return <TaskGraphStatusPane status="empty" />
  }

  // --- Main render ---
  return (
    <div className="flex flex-col h-full">
      <TaskGraphToolbar
        scale={panZoom.state.scale}
        filters={ix.filters}
        searchQuery={ix.searchQuery}
        searchMatchCount={ix.searchMatchIds.size}
        allCollapsed={ix.allCollapsed}
        allExpanded={ix.allExpanded}
        onZoomIn={panZoom.zoomIn}
        onZoomOut={panZoom.zoomOut}
        onFitToView={() => panZoom.fitToView()}
        onToggleFilter={ix.handleToggleFilter}
        onSearchChange={ix.setSearchQuery}
        onSearchSubmit={ix.handleSearchSubmit}
        onCollapseAll={ix.handleCollapseAll}
        onExpandAll={ix.handleExpandAll}
      />

      {warnings.length > 0 && (
        <div className="px-3 py-1 text-[11px]" style={{ backgroundColor: 'color-mix(in srgb, var(--sol-yellow) 13%, transparent)', color: 'var(--sol-yellow)' }}>
          {warnings.length} warning{warnings.length > 1 ? 's' : ''}: {warnings[0]}
          {warnings.length > 1 && ` (+${warnings.length - 1} more)`}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div ref={containerRef} className="relative flex-1 overflow-hidden">
          <TaskGraphCanvas
            graph={graph}
            layout={displayLayout}
            searchMatchIds={ix.searchMatchIds}
            transform={panZoom.transform}
            highlight={ix.highlight}
            selection={ix.selection}
            scale={panZoom.state.scale}
            collapsedTaskIds={ix.collapsedTaskIds}
            handlers={panZoom.handlers}
            onSelectTask={ix.handleSelectTask}
            onClearSelection={ix.handleClearSelection}
            onToggleCollapse={ix.handleToggleCollapse}
            onPointerEnter={ix.handlePointerEnter}
            onPointerLeave={ix.handlePointerLeave}
          />

          {ix.tooltipTarget && (
            <TaskGraphTooltip
              target={ix.tooltipTarget}
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
        </div>
      </div>
    </div>
  )
}
