import type { GraphLayout, TaskGraphModel } from './taskGraphModel'
import type { HighlightModel } from './taskGraphSelection'
import type { Selection } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { TaskGraphEdges } from './TaskGraphEdges'
import { TaskGraphRows } from './TaskGraphRows'

export function TaskGraphCanvas({ graph, layout, searchMatchIds, linkedTaskIds, highlight, selection, scale, collapsedTaskIds, onSelectTask, onOpenTask, onClearSelection, onToggleCollapse, onPointerEnter, onPointerLeave }: {
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
  onClearSelection: () => void
  onToggleCollapse: (id: string) => void
  onPointerEnter: (target: TooltipTarget) => void
  onPointerLeave: () => void
}) {
  // The SVG is sized to the scaled layout bounds so the scroll container
  // navigates it natively (vertical scroll); zoom is a uniform scale. The row
  // layers (sections/guides/cards) are shared with the Gantt left column;
  // dependency arcs are painted between the guides and the cards.
  return (
    <svg
      className="block"
      width={layout.bounds.width * scale}
      height={layout.bounds.height * scale}
      onClick={onClearSelection}
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
        edges={<TaskGraphEdges edges={layout.edges} highlight={highlight} />}
      />
    </svg>
  )
}
