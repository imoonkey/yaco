import { SOLARIZED_LIGHT } from '../lib/solarizedLight'
import type { LayoutColumn, TaskGraphTask } from './taskGraphModel'
import { HEADER_HEIGHT } from './taskGraphModel'
import type { HighlightModel } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'

const STATE_COLORS: Record<string, string> = {
  ready: SOLARIZED_LIGHT.blue,
  running: SOLARIZED_LIGHT.yellow,
  done: SOLARIZED_LIGHT.green,
  blocked: SOLARIZED_LIGHT.red,
  cancelled: SOLARIZED_LIGHT.base1,
}

function MilestoneProgressBar({ column, tasks, x, y, width }: {
  column: LayoutColumn
  tasks: Map<string, TaskGraphTask>
  x: number
  y: number
  width: number
}) {
  const total = column.taskIds.length
  if (total === 0) return null

  const counts: Record<string, number> = { done: 0, running: 0, ready: 0, blocked: 0, cancelled: 0 }
  for (const tid of column.taskIds) {
    const state = tasks.get(tid)?.state ?? 'cancelled'
    counts[state] = (counts[state] ?? 0) + 1
  }

  let offsetX = 0
  const segments: { state: string; w: number }[] = []
  for (const state of ['done', 'running', 'ready', 'blocked', 'cancelled']) {
    if (counts[state] > 0) {
      const w = (counts[state] / total) * width
      segments.push({ state, w })
    }
  }

  return (
    <g>
      {/* Background */}
      <rect x={x} y={y} width={width} height={3} rx={1.5} fill={SOLARIZED_LIGHT.base2} opacity={0.5} />
      {/* Segments */}
      {segments.map(seg => {
        const sx = x + offsetX
        offsetX += seg.w
        return (
          <rect
            key={seg.state}
            x={sx}
            y={y}
            width={seg.w}
            height={3}
            rx={1.5}
            fill={STATE_COLORS[seg.state]}
            opacity={0.8}
            style={{ transition: 'width 300ms ease-out' }}
          />
        )
      })}
    </g>
  )
}

export function TaskGraphMilestone({ column, tasks, highlight, isSelected, isCollapsed, onClick, onToggleCollapse, onPointerEnter, onPointerLeave }: {
  column: LayoutColumn
  tasks: Map<string, TaskGraphTask>
  highlight: HighlightModel
  isSelected: boolean
  isCollapsed: boolean
  onClick: (id: string) => void
  onToggleCollapse: (id: string) => void
  onPointerEnter: (target: TooltipTarget) => void
  onPointerLeave: () => void
}) {
  const stateColor = STATE_COLORS[column.aggregateState] ?? SOLARIZED_LIGHT.base1
  const isDimmed = highlight.dimUnrelated && !isSelected &&
    !column.taskIds.some(id => highlight.activeTaskIds.has(id) || highlight.upstreamTaskIds.has(id) || highlight.downstreamTaskIds.has(id))

  const hasChildren = column.taskIds.length > 0
  const displayHeight = isCollapsed ? HEADER_HEIGHT : column.height

  const handleTooltipEnter = () => {
    onPointerEnter({
      id: column.id,
      type: 'milestone',
      graphX: column.x + column.width / 2,
      graphY: column.y,
      graphH: HEADER_HEIGHT,
    })
  }

  return (
    <>
      {/* Column background */}
      <rect
        x={column.x}
        y={column.y}
        width={column.width}
        rx={8}
        fill={SOLARIZED_LIGHT.base3}
        stroke={isSelected ? SOLARIZED_LIGHT.focusBorder : SOLARIZED_LIGHT.border}
        strokeWidth={isSelected ? 2 : 1}
        opacity={isDimmed ? 0.4 : 1}
        style={{ height: displayHeight, transition: 'height 200ms ease-out, opacity 150ms ease-out' }}
      />
      {/* State accent on left border — inset to stay within rounded corners */}
      <rect
        x={column.x}
        y={column.y + 8}
        width={4}
        rx={2}
        fill={stateColor}
        opacity={isDimmed ? 0.2 : 0.6}
        style={{ height: displayHeight - 16, transition: 'height 200ms ease-out, opacity 150ms ease-out' }}
      />
      {/* Clickable header group with keyboard access */}
      <g
        tabIndex={0}
        role="button"
        aria-label={`Milestone: ${column.title}, ${column.progress.done} of ${column.progress.total} done`}
        onClick={(e) => { e.stopPropagation(); onClick(column.id) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onClick(column.id)
          }
        }}
        onPointerEnter={handleTooltipEnter}
        onPointerLeave={onPointerLeave}
        style={{ cursor: 'pointer' }}
        className="tg-focusable"
      >
        {/* Header background */}
        <rect
          x={column.x}
          y={column.y}
          width={column.width}
          height={HEADER_HEIGHT}
          rx={8}
          fill={SOLARIZED_LIGHT.base2}
          opacity={isDimmed ? 0.4 : 1}
          style={{ transition: 'opacity 150ms ease-out' }}
        />
        {/* Round only top corners — overlay to flatten bottom */}
        {!isCollapsed && (
          <rect
            x={column.x}
            y={column.y + HEADER_HEIGHT - 8}
            width={column.width}
            height={8}
            fill={SOLARIZED_LIGHT.base2}
            opacity={isDimmed ? 0.4 : 1}
            style={{ transition: 'opacity 150ms ease-out' }}
          />
        )}

        {/* Chevron — focusable collapse toggle */}
        {hasChildren && (
          <g
            tabIndex={0}
            role="button"
            aria-label={isCollapsed ? 'Expand milestone' : 'Collapse milestone'}
            className="tg-focusable"
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(column.id) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onToggleCollapse(column.id)
              }
            }}
            style={{ cursor: 'pointer' }}
          >
            {/* Invisible hit rect — SVG <g> only captures events on painted children */}
            <rect
              x={column.x + 2}
              y={column.y + 6}
              width={22}
              height={22}
              fill="transparent"
            />
            <text
              x={column.x + 12}
              y={column.y + 22}
              fontSize={10}
              fill={SOLARIZED_LIGHT.base1}
            >
              {isCollapsed ? '\u25B6' : '\u25BC'}
            </text>
          </g>
        )}

        {/* Clip path for milestone title */}
        <clipPath id={`clip-ms-${column.id}`}>
          <rect x={column.x + (hasChildren ? 24 : 10)} y={column.y} width={column.width - (hasChildren ? 24 : 10) - 50} height={HEADER_HEIGHT} />
        </clipPath>

        {/* Title */}
        <text
          x={column.x + (hasChildren ? 26 : 12)}
          y={column.y + 22}
          fontSize={13}
          fontWeight={600}
          fill={SOLARIZED_LIGHT.base01}
          opacity={isDimmed ? 0.4 : 1}
          style={{ transition: 'opacity 150ms ease-out' }}
          clipPath={`url(#clip-ms-${column.id})`}
        >
          {column.title}
        </text>
        {/* Progress text */}
        <text
          x={column.x + column.width - 12}
          y={column.y + 22}
          fontSize={11}
          textAnchor="end"
          fill={SOLARIZED_LIGHT.base1}
          opacity={isDimmed ? 0.3 : 0.8}
          style={{ transition: 'opacity 150ms ease-out' }}
        >
          {column.progress.done}/{column.progress.total}
        </text>

        {/* Progress bar */}
        <MilestoneProgressBar
          column={column}
          tasks={tasks}
          x={column.x + 4}
          y={column.y + HEADER_HEIGHT - 6}
          width={column.width - 8}
        />
      </g>
    </>
  )
}
