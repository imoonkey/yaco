import { useCallback, useState } from 'react'
import type { GanttLayout, TaskGraphModel } from './taskGraphModel'
import type { HighlightModel, Selection } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { TaskGraphEdges } from './TaskGraphEdges'
import { TaskGraphRows } from './TaskGraphRows'
import { TaskGanttBar, GanttBarDefs } from './TaskGanttBar'
import { TaskGanttRuler, RULER_HEIGHT } from './TaskGanttRuler'

// Width of the gutter between the two panes. The 3px resize handle is centered in
// it, so the leftover space on each side is the breathing room between the task
// cards / time grid and the divider.
const DIVIDER_GUTTER = 19

// Two-pane Pseudo-Gantt: a frozen left task column (sticky left) + a horizontally
// scrollable time pane with a sticky top ruler. Both panes share the same row `y`
// and the same single scale() transform, so zoom and vertical scroll stay in lock
// step with no manual scroll-sync. A blank corner spacer keeps both panes' rows
// aligned beneath the ruler band. The left column reuses the same row renderer as
// the stacked canvas, so cards, indent guides, and workset section dividers render
// identically; a draggable divider (the app's VResizeHandle style) between the
// panes resizes that column.
export function TaskGanttCanvas({ graph, layout, searchMatchIds, linkedTaskIds, highlight, selection, scale, collapsedTaskIds, onSelectTask, onOpenTask, onClearSelection, onToggleCollapse, onPointerEnter, onPointerLeave, onResizeLeftWidth }: {
  graph: TaskGraphModel
  layout: GanttLayout
  searchMatchIds: Set<string>
  linkedTaskIds: Set<string>
  highlight: HighlightModel
  selection: Selection
  scale: number
  collapsedTaskIds: Set<string>
  onSelectTask: (id: string) => void
  onOpenTask: (id: string) => void
  onClearSelection: () => void
  onToggleCollapse: (id: string) => void
  onPointerEnter: (target: TooltipTarget) => void
  onPointerLeave: () => void
  onResizeLeftWidth: (unscaledWidth: number) => void
}) {
  const leftW = layout.leftWidth * scale
  const timeW = layout.timeWidth * scale
  const contentH = layout.bounds.height * scale
  const fullH = RULER_HEIGHT * scale + contentH
  const [dragging, setDragging] = useState(false)

  // Drag the divider: screen-pixel delta is converted back to unscaled layout
  // units (computeGanttLayout clamps below the auto floor so cards never clip).
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = layout.leftWidth
    setDragging(true)
    const onMove = (ev: MouseEvent) => onResizeLeftWidth(startWidth + (ev.clientX - startX) / scale)
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [layout.leftWidth, scale, onResizeLeftWidth])

  return (
    <div className="flex" style={{ width: leftW + DIVIDER_GUTTER + timeW, position: 'relative' }}>
      {/* Left frozen task column — stays put during horizontal scroll. */}
      <div className="shrink-0" style={{ position: 'sticky', left: 0, zIndex: 2, width: leftW }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 3, height: RULER_HEIGHT * scale, backgroundColor: 'var(--sol-header-bg)', borderBottom: '1px solid var(--sol-border)' }} />
        <svg
          className="block"
          width={leftW}
          height={contentH}
          onClick={onClearSelection}
          style={{ backgroundColor: 'var(--sol-editor-bg)' }}
        >
          <TaskGraphRows
            graph={graph}
            layout={layout}
            searchMatchIds={searchMatchIds}
            linkedTaskIds={linkedTaskIds}
            highlight={highlight}
            selection={selection}
            scale={scale}
            collapsedTaskIds={collapsedTaskIds}
            onSelectTask={onSelectTask}
            onOpenTask={onOpenTask}
            onToggleCollapse={onToggleCollapse}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
          />
        </svg>
      </div>

      {/* Resizable divider gutter — sticky just past the frozen column, so it stays
          at the column edge during horizontal scroll. The 3px handle is centered,
          leaving margin on both sides. Matches the app's VResizeHandle. */}
      <div
        className="shrink-0 flex justify-center"
        style={{ position: 'sticky', left: leftW, zIndex: 3, width: DIVIDER_GUTTER, height: fullH, backgroundColor: 'var(--sol-editor-bg)' }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          data-testid="gantt-divider"
          onMouseDown={onDividerMouseDown}
          className="resize-handle-v shrink-0 cursor-col-resize relative"
          style={{ width: 3, backgroundColor: dragging ? 'var(--sol-accent)' : 'var(--sol-border)', transition: 'background-color var(--transition-fast)' }}
        />
      </div>

      {/* Time pane — bars + FS links over a synthetic-unit grid; scrolls horizontally. */}
      <div className="shrink-0" style={{ position: 'relative', width: timeW }}>
        <TaskGanttRuler ticks={layout.ruler.ticks} scale={scale} timeWidth={layout.timeWidth} />
        <svg className="block" width={timeW} height={contentH} onClick={onClearSelection}>
          <g transform={`scale(${scale})`}>
            <g data-layer="gridlines">
              {layout.ruler.ticks.map(tick => (
                <line
                  key={tick.label}
                  x1={tick.x}
                  y1={0}
                  x2={tick.x}
                  y2={layout.bounds.height}
                  stroke="var(--sol-border)"
                  strokeWidth={1}
                  opacity={0.15}
                />
              ))}
            </g>

            <TaskGraphEdges edges={layout.edges} highlight={highlight} />

            <g data-layer="bars">
              <GanttBarDefs />
              {Array.from(layout.bars.entries()).map(([id, bar]) => (
                <TaskGanttBar
                  key={id}
                  id={id}
                  bar={bar}
                  leftWidth={layout.leftWidth + DIVIDER_GUTTER / scale}
                  highlight={highlight}
                  isSelected={selection === id}
                  onClick={onSelectTask}
                  onOpen={onOpenTask}
                  onPointerEnter={onPointerEnter}
                  onPointerLeave={onPointerLeave}
                />
              ))}
            </g>
          </g>
        </svg>
      </div>
    </div>
  )
}
