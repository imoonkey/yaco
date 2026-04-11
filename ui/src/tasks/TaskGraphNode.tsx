import type { LayoutNode, TaskGraphTask, LayoutGroup } from './taskGraphModel'
import { NODE_WIDTH, NODE_HEIGHT } from './taskGraphModel'
import type { HighlightModel } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { STATE_COLORS } from './taskGraphConstants'

function StateDot({ state, cx, cy }: { state: string; cx: number; cy: number }) {
  const color = STATE_COLORS[state] ?? 'var(--sol-base1)'
  const r = 3

  if (state === 'done') {
    return <circle cx={cx} cy={cy} r={r} fill={color} />
  }
  if (state === 'running') {
    return (
      <>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={1.5} />
        <path d={`M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} Z`} fill={color} />
      </>
    )
  }
  if (state === 'blocked') {
    return <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="2 2" />
  }
  if (state === 'cancelled') {
    return (
      <>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={1.5} />
        <line x1={cx - r + 1} y1={cy} x2={cx + r - 1} y2={cy} stroke={color} strokeWidth={1.5} />
      </>
    )
  }
  // ready
  return <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={1.5} />
}

function getNodeOpacity(node: LayoutNode, highlight: HighlightModel): number {
  if (!highlight.dimUnrelated) return 1
  const { id } = node
  if (highlight.activeTaskIds.has(id) || highlight.upstreamTaskIds.has(id) || highlight.downstreamTaskIds.has(id)) return 1
  return 0.4
}

function getNodeFill(node: LayoutNode, highlight: HighlightModel): string {
  if (highlight.upstreamTaskIds.has(node.id)) return 'var(--sol-orange)'
  if (highlight.downstreamTaskIds.has(node.id)) return 'var(--sol-cyan)'
  return 'var(--sol-bg)'
}

function getNodeFillOpacity(node: LayoutNode, highlight: HighlightModel): number {
  if (highlight.upstreamTaskIds.has(node.id) || highlight.downstreamTaskIds.has(node.id)) return 0.15
  return 1
}

export function TaskGraphNode({ node, task, group, highlight, isSelected, isSearchMatch, isCollapsed, depCount, scale, onClick, onToggleCollapse, onPointerEnter, onPointerLeave }: {
  node: LayoutNode
  task: TaskGraphTask
  group?: LayoutGroup
  highlight: HighlightModel
  isSelected: boolean
  isSearchMatch: boolean
  isCollapsed: boolean
  depCount: number
  scale: number
  onClick: (id: string) => void
  onToggleCollapse: (id: string) => void
  onPointerEnter: (target: TooltipTarget) => void
  onPointerLeave: () => void
}) {
  const opacity = getNodeOpacity(node, highlight)
  const showLabels = scale >= 0.5

  const strokeColor = isSearchMatch ? 'var(--sol-violet)' : isSelected ? 'var(--sol-focus-border)' : 'var(--sol-border)'
  const strokeW = isSearchMatch || isSelected ? 2 : 1

  // Group affordances: chevron and progress
  const hasGroupAffordances = task.hasChildren
  const chevronWidth = hasGroupAffordances ? 16 : 0
  const progressText = group ? `${group.progress.done}/${group.progress.total}` : ''

  return (
    <g
      tabIndex={0}
      role="button"
      aria-label={`Task: ${task.title}, status: ${task.state}`}
      onClick={(e) => { e.stopPropagation(); onClick(node.id) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          onClick(node.id)
        }
      }}
      onPointerEnter={() => onPointerEnter({
        id: node.id,
        graphX: node.x + node.width / 2,
        graphY: node.y,
        graphH: node.height,
      })}
      onPointerLeave={onPointerLeave}
      style={{ cursor: 'pointer', transition: 'opacity 150ms ease-out' }}
      className="tg-focusable"
      opacity={opacity}
    >
      {/* Node background */}
      <rect
        x={node.x}
        y={node.y}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={6}
        fill={getNodeFill(node, highlight)}
        fillOpacity={getNodeFillOpacity(node, highlight)}
        stroke={strokeColor}
        strokeWidth={strokeW}
        filter={isSelected ? 'drop-shadow(0 1px 3px rgba(0,0,0,0.2))' : undefined}
      />

      {/* Search match glow ring */}
      {isSearchMatch && (
        <rect
          x={node.x - 3}
          y={node.y - 3}
          width={NODE_WIDTH + 6}
          height={NODE_HEIGHT + 6}
          rx={9}
          fill="none"
          stroke={'var(--sol-violet)'}
          strokeWidth={1.5}
          strokeDasharray="4 2"
          opacity={0.6}
        />
      )}

      {/* Collapse chevron for group tasks */}
      {hasGroupAffordances && (
        <g
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(node.id) }}
          style={{ cursor: 'pointer' }}
        >
          <rect x={node.x} y={node.y} width={16} height={NODE_HEIGHT} fill="transparent" />
          <text
            x={node.x + 8}
            y={node.y + 22}
            fontSize={9}
            textAnchor="middle"
            fill={'var(--sol-base1)'}
          >
            {isCollapsed ? '\u25B8' : '\u25BE'}
          </text>
        </g>
      )}

      {/* Clip path for text overflow */}
      <clipPath id={`clip-${node.id}`}>
        <rect
          x={node.x + chevronWidth + 22}
          y={node.y}
          width={NODE_WIDTH - chevronWidth - 22 - 6}
          height={NODE_HEIGHT}
        />
      </clipPath>

      {/* State dot */}
      <StateDot state={task.state} cx={node.x + chevronWidth + 12} cy={node.y + 18} />

      {/* Title */}
      <text
        x={node.x + chevronWidth + 24}
        y={node.y + 22}
        fontSize={13}
        fontWeight={600}
        fill={'var(--sol-text-dark)'}
        opacity={showLabels ? 1 : 0}
        style={{ transition: 'opacity 150ms ease-out' }}
        clipPath={`url(#clip-${node.id})`}
      >
        {task.title}
      </text>

      {/* Meta line: agent handle + progress for groups, dep count for leaves */}
      {hasGroupAffordances && progressText && (
        <text
          x={node.x + chevronWidth + 24}
          y={node.y + 38}
          fontSize={10}
          fontWeight={500}
          fill={'var(--sol-muted)'}
          opacity={showLabels ? 1 : 0}
          style={{ transition: 'opacity 150ms ease-out' }}
        >
          {progressText} done
        </text>
      )}

      {/* Dependency count badge (leaf tasks only) */}
      {!hasGroupAffordances && depCount > 0 && (
        <text
          x={node.x + chevronWidth + 24}
          y={node.y + 38}
          fontSize={10}
          fontWeight={500}
          fill={'var(--sol-muted)'}
          opacity={showLabels ? 1 : 0}
          style={{ transition: 'opacity 150ms ease-out' }}
        >
          {depCount} {depCount === 1 ? 'dep' : 'deps'}
        </text>
      )}
    </g>
  )
}
