import type { GraphLayout, LayoutSection, TaskGraphModel } from './taskGraphModel'
import type { HighlightModel } from './taskGraphSelection'
import type { Selection } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { TaskGraphEdges } from './TaskGraphEdges'
import { TaskGraphGroup } from './TaskGraphGroup'
import { TaskGraphNode } from './TaskGraphNode'

function TaskGraphSectionHeader({ section }: { section: LayoutSection }) {
  const labelWidth = section.label.length * 7 + 20
  const lineY = section.y + 13

  return (
    <g pointerEvents="none" opacity={0.95}>
      <text
        x={section.x}
        y={section.y + 17}
        fontSize={11}
        fontWeight={600}
        fill="var(--sol-muted)"
        letterSpacing="0"
      >
        {section.label}
      </text>
      <line
        x1={section.x + labelWidth}
        y1={lineY}
        x2={section.x + section.width}
        y2={lineY}
        stroke="var(--sol-border)"
        strokeWidth={1}
        opacity={0.55}
      />
    </g>
  )
}

export function TaskGraphCanvas({ graph, layout, searchMatchIds, highlight, selection, scale, collapsedTaskIds, onSelectTask, onOpenTask, onClearSelection, onToggleCollapse, onPointerEnter, onPointerLeave }: {
  graph: TaskGraphModel
  layout: GraphLayout
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
  // Build group lookup for node progress info
  const groupById = new Map(layout.groups.map(g => [g.id, g]))

  // The SVG is sized to the scaled layout bounds so the scroll container
  // navigates it natively (vertical scroll); zoom is a uniform scale.
  return (
    <svg
      className="block"
      width={layout.bounds.width * scale}
      height={layout.bounds.height * scale}
      onClick={onClearSelection}
    >
      <g transform={`scale(${scale})`}>
        <style>{`.tg-focusable { outline: none; } .tg-focusable:focus-visible { outline: 2px solid var(--sol-focus-border); outline-offset: 2px; }`}</style>
        {/* Layer 1: Workset section headers */}
        <g data-layer="sections">
          {layout.sections.map(section => (
            <TaskGraphSectionHeader key={section.id} section={section} />
          ))}
        </g>

        {/* Layer 2: Indentation guide lines */}
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

        {/* Layer 3: Dependency edges */}
        <TaskGraphEdges edges={layout.edges} highlight={highlight} />

        {/* Layer 4: Task cards (all visible tasks) */}
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
  )
}
