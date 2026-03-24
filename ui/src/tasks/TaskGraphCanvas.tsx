import type { GraphLayout, TaskGraphModel, TaskGraphTask } from './taskGraphModel'
import { SOLARIZED_LIGHT } from '../lib/solarizedLight'
import type { HighlightModel } from './taskGraphSelection'
import type { Selection } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { TaskGraphEdges } from './TaskGraphEdges'
import { TaskGraphMilestone } from './TaskGraphMilestone'
import { TaskGraphNode } from './TaskGraphNode'

export function TaskGraphCanvas({ graph, layout, hiddenNodeIds, searchMatchIds, transform, highlight, selection, scale, collapsedMilestones, handlers, onSelectTask, onSelectMilestone, onClearSelection, onToggleCollapse, onPointerEnter, onPointerLeave }: {
  graph: TaskGraphModel
  layout: GraphLayout
  hiddenNodeIds: Set<string>
  searchMatchIds: Set<string>
  transform: string
  highlight: HighlightModel
  selection: Selection
  scale: number
  collapsedMilestones: Set<string>
  handlers: {
    onWheel: (e: React.WheelEvent) => void
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
  }
  onSelectTask: (id: string) => void
  onSelectMilestone: (id: string) => void
  onClearSelection: () => void
  onToggleCollapse: (id: string) => void
  onPointerEnter: (target: TooltipTarget) => void
  onPointerLeave: () => void
}) {
  // Build tasks map for milestone progress bar
  const tasks = graph.tasks as Map<string, TaskGraphTask>
  // Milestone IDs are always visible — don't filter edges targeting them
  const milestoneIds = new Set(layout.columns.map(c => c.id))

  return (
    <svg
      className="absolute inset-0 h-full w-full"
      style={{ touchAction: 'none' }}
      onClick={onClearSelection}
      {...handlers}
    >
      <g transform={transform}>
        <style>{`.tg-focusable:focus-visible { outline: 2px solid ${SOLARIZED_LIGHT.focusBorder}; outline-offset: 2px; }`}</style>
        {/* Layer 1: Milestone backgrounds */}
        <g data-layer="milestones">
          {layout.columns.map(col => (
            <TaskGraphMilestone
              key={col.id}
              column={col}
              tasks={tasks}
              highlight={highlight}
              isSelected={selection?.type === 'milestone' && selection.id === col.id}
              isCollapsed={collapsedMilestones.has(col.id)}
              onClick={onSelectMilestone}
              onToggleCollapse={onToggleCollapse}
              onPointerEnter={onPointerEnter}
              onPointerLeave={onPointerLeave}
            />
          ))}
        </g>

        {/* Layer 2: Dependency edges (hide edges touching hidden nodes, but not milestone endpoints) */}
        <TaskGraphEdges edges={layout.edges.filter(e => {
          const sourceHidden = hiddenNodeIds.has(e.sourceId) && !milestoneIds.has(e.sourceId)
          const targetHidden = hiddenNodeIds.has(e.targetId) && !milestoneIds.has(e.targetId)
          return !sourceHidden && !targetHidden
        })} highlight={highlight} />

        {/* Layer 3: Task nodes (hide filtered-out and collapsed nodes) */}
        <g data-layer="nodes">
          {Array.from(layout.nodes.values()).map(node => {
            if (hiddenNodeIds.has(node.id)) return null
            const task = graph.tasks.get(node.id)
            if (!task) return null
            const depCount = task.depends.length
            return (
              <TaskGraphNode
                key={node.id}
                node={node}
                task={task}
                highlight={highlight}
                isSelected={selection?.type === 'task' && selection.id === node.id}
                isSearchMatch={searchMatchIds.has(node.id)}
                depCount={depCount}
                scale={scale}
                onClick={onSelectTask}
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
