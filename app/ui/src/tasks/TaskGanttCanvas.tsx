import type { GanttLayout, TaskGraphModel } from './taskGraphModel'
import { NODE_HEIGHT } from './taskGraphModel'
import type { HighlightModel, Selection } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { TaskGraphEdges } from './TaskGraphEdges'
import { TaskGraphGroup } from './TaskGraphGroup'
import { TaskGraphNode } from './TaskGraphNode'
import { TaskGanttRuler, RULER_HEIGHT } from './TaskGanttRuler'
import { STATE_COLORS } from './taskGraphConstants'

// Two-pane Pseudo-Gantt: a frozen left task column (sticky left) + a horizontally
// scrollable time pane with a sticky top ruler. Both panes share the same row `y`
// and the same single scale() transform, so zoom and vertical scroll stay in lock
// step with no manual scroll-sync. A blank corner spacer keeps both panes' rows
// aligned beneath the ruler band.
export function TaskGanttCanvas({ graph, layout, searchMatchIds, highlight, selection, scale, collapsedTaskIds, onSelectTask, onOpenTask, onClearSelection, onToggleCollapse, onPointerEnter, onPointerLeave }: {
  graph: TaskGraphModel
  layout: GanttLayout
  searchMatchIds: Set<string>
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
}) {
  const groupById = new Map(layout.groups.map(g => [g.id, g]))
  const leftW = layout.leftWidth * scale
  const timeW = layout.timeWidth * scale
  const contentH = layout.bounds.height * scale

  return (
    <div className="flex" style={{ width: leftW + timeW, position: 'relative' }}>
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
          <g transform={`scale(${scale})`}>
            <style>{`.tg-focusable { outline: none; } .tg-focusable:focus-visible { outline: 2px solid var(--sol-focus-border); outline-offset: 2px; }`}</style>
            <g data-layer="guides">
              {layout.groups.map(group => (
                <TaskGraphGroup
                  key={group.id}
                  group={group}
                  subtreeIds={graph.subtreeIdsByTask.get(group.id) ?? [group.id]}
                  highlight={highlight}
                />
              ))}
            </g>
            <g data-layer="nodes">
              {Array.from(layout.nodes.values()).map(node => {
                const task = graph.tasks.get(node.id)
                if (!task) return null
                return (
                  <TaskGraphNode
                    key={node.id}
                    node={node}
                    task={task}
                    group={groupById.get(node.id)}
                    highlight={highlight}
                    isSelected={selection === node.id}
                    isSearchMatch={searchMatchIds.has(node.id)}
                    isCollapsed={collapsedTaskIds.has(node.id)}
                    depCount={task.depends.length}
                    scale={scale}
                    onClick={onSelectTask}
                    onOpen={onOpenTask}
                    onToggleCollapse={onToggleCollapse}
                    onPointerEnter={onPointerEnter}
                    onPointerLeave={onPointerLeave}
                  />
                )
              })}
            </g>
          </g>
        </svg>
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
              {Array.from(layout.bars.entries()).map(([id, bar]) => (
                <rect
                  key={id}
                  x={bar.x}
                  y={bar.y + 6}
                  width={bar.width}
                  height={NODE_HEIGHT - 12}
                  rx={3}
                  fill={STATE_COLORS[bar.state] ?? 'var(--sol-base1)'}
                  opacity={0.85}
                />
              ))}
            </g>
          </g>
        </svg>
      </div>
    </div>
  )
}
