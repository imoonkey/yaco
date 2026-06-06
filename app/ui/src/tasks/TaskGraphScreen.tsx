import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createFile, saveFileContent } from '../hooks/useApi'
import { TASKS_FILE_PATH, useTaskGraph } from '../hooks/useTaskGraph'
import { useViewport } from './useViewport'
import { useIsMobile } from '../hooks/useIsMobile'
import { computeDisplayLayout } from './taskGraphModel'
import { TaskGraphTooltip } from './TaskGraphTooltip'
import { TaskGraphCanvas } from './TaskGraphCanvas'
import { TaskGraphToolbar } from './TaskGraphToolbar'
import { TaskGraphStatusPane } from './TaskGraphStatusPane'
import { useTaskGraphInteraction } from './useTaskGraphInteraction'
import { useTaskGraphKeyboard } from './useTaskGraphKeyboard'

export function TaskGraphScreen({ projectName, onOpenTasksFile, onSelectTask, selectedTaskId }: { projectName: string; onOpenTasksFile?: () => void; onSelectTask?: (id: string | null) => void; selectedTaskId?: string | null }) {
  const { status, graph, error, warnings, refresh } = useTaskGraph(projectName)
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // Track scroll-container width for width-driven layout (clientWidth excludes the
  // vertical scrollbar, so the SVG fits exactly and never adds a horizontal scrollbar).
  // A callback ref binds the observer whenever the scroll container mounts — including
  // the loading→ready transition, which a mount-time effect would miss (the div does
  // not exist while the loading pane is shown, leaving containerWidth stuck at 0).
  const attachScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    if (!el) return
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth))
    ro.observe(el)
    resizeObserverRef.current = ro
    setContainerWidth(el.clientWidth)
  }, [])

  // Viewport — native vertical scroll for navigation, uniform zoom via scale.
  const viewport = useViewport({ scrollRef })
  const ix = useTaskGraphInteraction(projectName, graph, viewport, isMobile)

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

  // Compute display layout from graph + interaction view state.
  // The workset filter is applied to the rendered set here: tasks whose workset is
  // disabled (archive by default) are dropped before layout, so they never render.
  const displayLayout = useMemo(() => {
    if (!graph) return null
    const worksets = ix.filters.worksets
    const visibleTasks = new Map([...graph.tasks].filter(([, t]) => worksets.has(t.workset)))
    return computeDisplayLayout(
      { tasks: visibleTasks, childIdsByTask: graph.childIdsByTask, rootIds: graph.rootIds, subtreeIdsByTask: graph.subtreeIdsByTask, dependenciesByTask: graph.dependenciesByTask },
      { collapsedTaskIds: ix.collapsedTaskIds, filters: ix.filters.states },
      graph.aggregateStateByTask,
      graph.leafProgressByTask,
      graph.cycleEdgeIds,
      containerWidth,
    )
  }, [graph, ix.collapsedTaskIds, ix.filters, containerWidth])

  // Clear selection when the selected task is no longer in the rendered layout —
  // hidden by any filter (workset, state, or a filtered-out ancestor). Robust to all
  // cases; propagates up via the selection-sync effect so the detail panel clears too.
  const { selection, setSelection } = ix
  useEffect(() => {
    if (selection && displayLayout && !displayLayout.nodes.has(selection)) {
      setSelection(null)
    }
  }, [displayLayout, selection, setSelection])

  // Scroll pending navigate target into view after layout recomputes
  const { pendingPanRef, clearPendingPan } = ix
  useEffect(() => {
    const id = pendingPanRef.current
    if (!id || !displayLayout) return
    const node = displayLayout.nodes.get(id)
    if (node) {
      clearPendingPan()
      viewport.scrollNodeIntoView(node)
    }
  }, [displayLayout, viewport, pendingPanRef, clearPendingPan])

  // Keyboard shortcuts
  useTaskGraphKeyboard(graph, displayLayout, ix.selection, ix.collapsedTaskIds, ix, viewport)

  // Clear tooltip on zoom (scroll clears it via the container's onScroll)
  useEffect(() => {
    ix.clearTooltip()
  }, [viewport.scale]) // eslint-disable-line react-hooks/exhaustive-deps

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
        scale={viewport.scale}
        layout={ix.layout}
        stateFilters={ix.filters.states}
        worksets={ix.filters.worksets}
        searchQuery={ix.searchQuery}
        searchMatchCount={ix.searchMatchIds.size}
        allCollapsed={ix.allCollapsed}
        allExpanded={ix.allExpanded}
        onZoomIn={viewport.zoomIn}
        onZoomOut={viewport.zoomOut}
        onFitToView={viewport.resetZoom}
        onSetLayout={ix.setLayout}
        onToggleState={ix.handleToggleFilter}
        onToggleWorkset={ix.handleToggleWorkset}
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
          <div
            ref={attachScrollRef}
            className="absolute inset-0 overflow-y-scroll overflow-x-auto"
            onScroll={ix.clearTooltip}
          >
            <TaskGraphCanvas
              graph={graph}
              layout={displayLayout}
              searchMatchIds={ix.searchMatchIds}
              highlight={ix.highlight}
              selection={ix.selection}
              scale={viewport.scale}
              collapsedTaskIds={ix.collapsedTaskIds}
              onSelectTask={ix.handleSelectTask}
              onClearSelection={ix.handleClearSelection}
              onToggleCollapse={ix.handleToggleCollapse}
              onPointerEnter={ix.handlePointerEnter}
              onPointerLeave={ix.handlePointerLeave}
            />
          </div>

          {ix.tooltipTarget && (
            <TaskGraphTooltip
              target={ix.tooltipTarget}
              graph={graph}
              scale={viewport.scale}
              containerRef={scrollRef}
            />
          )}
        </div>
      </div>
    </div>
  )
}
