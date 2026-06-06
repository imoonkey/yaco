import type { GanttBar } from './taskGraphModel'
import { NODE_HEIGHT } from './taskGraphModel'
import type { HighlightModel } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { RULER_HEIGHT } from './TaskGanttRuler'
import {
  STATE_COLORS,
  BAR_INSET_Y,
  BAR_RADIUS,
  BAR_BASE_OPACITY,
  CRITICAL_OUTLINE_COLOR,
  CRITICAL_OUTLINE_WIDTH,
  CYCLE_COLOR,
  HATCH_PATTERN_ID,
  SUMMARY_BAR_HEIGHT,
  SUMMARY_CAP_SIZE,
  SUMMARY_BAR_OPACITY,
} from './taskGraphConstants'

// Effective-cycle tasks (`bar.cycle`) render red, not state-colored. The schedule also
// excludes cycle nodes from `critical`, so they never pick up the critical outline.
type Bar = GanttBar

// Row-level dim mirrors TaskGraphNode (direct = full, transitive = receded, unrelated =
// faded), with one addition: the critical chain stays prominent regardless of selection.
function barOpacity(id: string, bar: Bar, highlight: HighlightModel): number {
  if (!highlight.dimUnrelated) return 1
  if (highlight.activeTaskIds.has(id) || highlight.directTaskIds.has(id) || bar.critical) return 1
  if (highlight.upstreamTaskIds.has(id) || highlight.downstreamTaskIds.has(id)) return 0.55
  return 0.22
}

// Leaf bar — a solid rounded rect colored by task state. Assumed estimates overlay a
// diagonal hatch; critical-path bars gain an accent outline; selection adds a left accent.
function LeafBar({ bar, fill, showCritical, isSelected }: {
  bar: Bar
  fill: string
  showCritical: boolean
  isSelected: boolean
}) {
  const top = bar.y + BAR_INSET_Y
  const height = NODE_HEIGHT - BAR_INSET_Y * 2
  return (
    <>
      <rect
        x={bar.x}
        y={top}
        width={bar.width}
        height={height}
        rx={BAR_RADIUS}
        fill={fill}
        fillOpacity={BAR_BASE_OPACITY}
        stroke={showCritical ? CRITICAL_OUTLINE_COLOR : undefined}
        strokeWidth={showCritical ? CRITICAL_OUTLINE_WIDTH : 0}
      />
      {bar.assumed && (
        <rect
          x={bar.x}
          y={top}
          width={bar.width}
          height={height}
          rx={BAR_RADIUS}
          fill={`url(#${HATCH_PATTERN_ID})`}
          pointerEvents="none"
        />
      )}
      {isSelected && (
        <rect
          x={bar.x}
          y={top}
          width={2.5}
          height={height}
          rx={1.25}
          fill="var(--sol-accent)"
          pointerEvents="none"
        />
      )}
    </>
  )
}

// Summary (group) bar — a thin, lighter span with downward end-cap wedges so it reads as
// a bracket over its descendants rather than a task. No hatch (summaries are never assumed).
function SummaryBar({ bar, fill, showCritical }: { bar: Bar; fill: string; showCritical: boolean }) {
  const top = bar.y + NODE_HEIGHT / 2 - SUMMARY_BAR_HEIGHT / 2
  const right = bar.x + bar.width
  const capBottom = top + SUMMARY_BAR_HEIGHT + SUMMARY_CAP_SIZE
  return (
    <>
      <rect
        x={bar.x}
        y={top}
        width={bar.width}
        height={SUMMARY_BAR_HEIGHT}
        rx={1}
        fill={fill}
        fillOpacity={SUMMARY_BAR_OPACITY}
        stroke={showCritical ? CRITICAL_OUTLINE_COLOR : undefined}
        strokeWidth={showCritical ? CRITICAL_OUTLINE_WIDTH : 0}
      />
      <path d={`M ${bar.x} ${top} L ${bar.x + SUMMARY_CAP_SIZE} ${top} L ${bar.x} ${capBottom} Z`} fill={fill} />
      <path d={`M ${right} ${top} L ${right - SUMMARY_CAP_SIZE} ${top} L ${right} ${capBottom} Z`} fill={fill} />
    </>
  )
}

// Shared <defs> for the bar layer — the assumed-estimate hatch pattern, defined once and
// referenced by id from every assumed bar. Rendered once by the canvas time pane.
export function GanttBarDefs() {
  return (
    <defs>
      <pattern id={HATCH_PATTERN_ID} patternUnits="userSpaceOnUse" width={5} height={5} patternTransform="rotate(45)">
        <line x1={0} y1={0} x2={0} y2={5} stroke="var(--sol-editor-bg)" strokeWidth={2.4} opacity={0.6} />
      </pattern>
    </defs>
  )
}

export function TaskGanttBar({ id, bar, leftWidth, highlight, isSelected, onClick, onOpen, onPointerEnter, onPointerLeave }: {
  id: string
  bar: Bar
  leftWidth: number   // unscaled width of the frozen left pane — offsets the tooltip into content space
  highlight: HighlightModel
  isSelected: boolean
  onClick: (id: string) => void
  onOpen: (id: string) => void
  onPointerEnter: (target: TooltipTarget) => void
  onPointerLeave: () => void
}) {
  const isCycle = bar.cycle
  const fill = isCycle ? CYCLE_COLOR : STATE_COLORS[bar.state] ?? 'var(--sol-base1)'
  const showCritical = bar.critical && !isCycle

  return (
    <g
      data-task-id={id}
      onClick={(e) => { e.stopPropagation(); onClick(id) }}
      onDoubleClick={(e) => { e.stopPropagation(); onOpen(id) }}
      onPointerEnter={() => onPointerEnter({
        id,
        graphX: leftWidth + bar.x + bar.width / 2,
        // Bars sit below the fixed ruler band; offset so the tooltip lands on the bar.
        graphY: RULER_HEIGHT + bar.y,
        graphH: NODE_HEIGHT,
      })}
      onPointerLeave={onPointerLeave}
      style={{ cursor: 'pointer', transition: 'opacity 150ms ease-out' }}
      opacity={barOpacity(id, bar, highlight)}
    >
      {bar.isSummary
        ? <SummaryBar bar={bar} fill={fill} showCritical={showCritical} />
        : <LeafBar bar={bar} fill={fill} showCritical={showCritical} isSelected={isSelected} />}
    </g>
  )
}
