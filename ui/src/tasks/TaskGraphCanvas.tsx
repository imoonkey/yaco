import type { GraphLayout, TaskGraphModel } from './taskGraphModel'
import { SOLARIZED_LIGHT } from '../lib/solarizedLight'
import type { HighlightModel } from './taskGraphSelection'
import type { Selection } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { TaskGraphEdges } from './TaskGraphEdges'
import { TaskGraphGroup } from './TaskGraphGroup'
import { TaskGraphNode } from './TaskGraphNode'

export function TaskGraphCanvas({ graph, layout, searchMatchIds, transform, highlight, selection, scale, collapsedTaskIds, handlers, onSelectTask, onClearSelection, onToggleCollapse, onPointerEnter, onPointerLeave }: {
  graph: TaskGraphModel
  layout: GraphLayout
  searchMatchIds: Set<string>
  transform: string
  highlight: HighlightModel
  selection: Selection
  scale: number
  collapsedTaskIds: Set<string>
  handlers: {
    onWheel: (e: React.WheelEvent) => void
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
  }
  onSelectTask: (id: string) => void
  onClearSelection: () => void
  onToggleCollapse: (id: string) => void
  onPointerEnter: (target: TooltipTarget) => void
  onPointerLeave: () => void
}) {
  // Build group lookup for node progress info
  const groupById = new Map(layout.groups.map(g => [g.id, g]))

  return (
    <svg
      className="absolute inset-0 h-full w-full"
      style={{ touchAction: 'none' }}
      onClick={onClearSelection}
      {...handlers}
    >
      <g transform={transform}>
        <style>{`.tg-focusable { outline: none; } .tg-focusable:focus-visible { outline: 2px solid ${SOLARIZED_LIGHT.focusBorder}; outline-offset: 2px; }`}</style>
        {/* Layer 1: Group container frames (shallow-to-deep, skip collapsed groups with no visible children) */}
        <g data-layer="groups">
          {[...layout.groups].sort((a, b) => a.depth - b.depth).map(group => (
            <TaskGraphGroup
              key={group.id}
              group={group}
              subtreeIds={graph.subtreeIdsByTask.get(group.id) ?? [group.id]}
              highlight={highlight}
              onClick={onSelectTask}
            />
          ))}
        </g>

        {/* Layer 2: Dependency edges (display layout already excludes filtered/collapsed nodes) */}
        <TaskGraphEdges edges={layout.edges} highlight={highlight} />

        {/* Layer 3: Task header cards (all visible tasks — leaf + group headers) */}
        <g data-layer="nodes">
          {Array.from(layout.nodes.values()).map(node => {
            const task = graph.tasks.get(node.id)
            if (!task) return null
            const depCount = task.depends.length
            const group = groupById.get(node.id)
            return (
              <TaskGraphNode
                key={node.id}
                node={node}
                task={task}
                group={group}
                highlight={highlight}
                isSelected={selection === node.id}
                isSearchMatch={searchMatchIds.has(node.id)}
                isCollapsed={collapsedTaskIds.has(node.id)}
                depCount={depCount}
                scale={scale}
                onClick={onSelectTask}
                onToggleCollapse={onToggleCollapse}
                onPointerEnter={onPointerEnter}
                onPointerLeave={onPointerLeave}
              />
            )
          })}
        </g>
      </g>
    </svg>
  )
}
