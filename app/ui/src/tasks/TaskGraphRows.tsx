import type { ReactNode } from 'react'
import type { GraphLayout, LayoutSection, TaskGraphModel } from './taskGraphModel'
import type { HighlightModel, Selection } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { TaskGraphGroup } from './TaskGraphGroup'
import { TaskGraphNode } from './TaskGraphNode'
import { SECTION_FONT_SIZE } from './graphType'

// Workset divider (e.g. "Backlog", "Archive") shown above the first root of a
// non-active workset. Shared by the stacked canvas and the Gantt left column so
// both render the section grouping identically.
export function TaskGraphSectionHeader({ section }: { section: LayoutSection }) {
  const labelWidth = section.label.length * 7 + 20
  const lineY = section.y + 13

  return (
    <g pointerEvents="none" opacity={0.95}>
      <text
        x={section.x}
        y={section.y + 17}
        fontSize={SECTION_FONT_SIZE}
        fontWeight={600}
        fill="var(--sol-text-faint)"
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

// The scaled task-row layers (sections + indent guides + cards) shared by the
// stacked canvas and the Gantt left column, so the left task column is rendered
// by one code path in both modes. `edges` is an optional slot painted between
// the guides and the cards (stacked draws dependency arcs here; Gantt routes its
// finish-to-start links in the separate time pane instead).
export function TaskGraphRows({ graph, layout, searchMatchIds, linkedTaskIds, highlight, selection, scale, collapsedTaskIds, onSelectTask, onOpenTask, onToggleCollapse, onPointerEnter, onPointerLeave, edges }: {
  graph: TaskGraphModel
  layout: GraphLayout
  searchMatchIds: Set<string>
  linkedTaskIds: Set<string>
  highlight: HighlightModel
  selection: Selection
  scale: number
  collapsedTaskIds: Set<string>
  onSelectTask: (id: string) => void
  onOpenTask: (id: string) => void
  onToggleCollapse: (id: string) => void
  onPointerEnter: (target: TooltipTarget) => void
  onPointerLeave: () => void
  edges?: ReactNode
}) {
  const groupById = new Map(layout.groups.map(g => [g.id, g]))

  return (
    <g transform={`scale(${scale})`}>
      <style>{`.tg-focusable { outline: none; } .tg-focusable:focus-visible { outline: 2px solid var(--sol-focus-border); outline-offset: 2px; }`}</style>

      <g data-layer="sections">
        {layout.sections.map(section => (
          <TaskGraphSectionHeader key={section.id} section={section} />
        ))}
      </g>

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

      {edges}

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
              isLinkedToActiveSession={linkedTaskIds.has(node.id)}
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
  )
}
