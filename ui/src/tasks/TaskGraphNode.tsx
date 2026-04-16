import type { LayoutNode, TaskGraphTask, LayoutGroup } from './taskGraphModel'
import { NODE_WIDTH, NODE_HEIGHT } from './taskGraphModel'
import type { HighlightModel } from './taskGraphSelection'
import type { TooltipTarget } from './TaskGraphTooltip'
import { STATE_COLORS, getWorktreeColor } from './taskGraphConstants'

function StateDot({ state, cx, cy }: { state: string; cx: number; cy: number }) {
  const color = STATE_COLORS[state] ?? 'var(--sol-base1)'
  const r = 3.5

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
    return (
      <>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={1.5} />
        <line x1={cx - r * 0.6} y1={cy - r * 0.6} x2={cx + r * 0.6} y2={cy + r * 0.6} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      </>
    )
  }
  if (state === 'cancelled') {
    return (
      <>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={1.5} />
        <line x1={cx - r * 0.6} y1={cy} x2={cx + r * 0.6} y2={cy} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
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

function getNodeFill(node: LayoutNode, highlight: HighlightModel, worktree: string | null): string {
  if (highlight.upstreamTaskIds.has(node.id)) return 'var(--sol-orange)'
  if (highlight.downstreamTaskIds.has(node.id)) return 'var(--sol-cyan)'
  if (worktree) return getWorktreeColor(worktree)
  return 'var(--sol-editor-bg)'
}

function getNodeFillOpacity(node: LayoutNode, highlight: HighlightModel, worktree: string | null): number {
  if (highlight.upstreamTaskIds.has(node.id) || highlight.downstreamTaskIds.has(node.id)) return 0.12
  if (worktree) return 0.1
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
  const showLabels = scale >= 0.45

  const strokeColor = isSearchMatch ? 'var(--sol-violet)' : isSelected ? 'var(--sol-accent)' : 'var(--sol-border)'
  const strokeW = isSearchMatch || isSelected ? 1.5 : 1

  // Group affordances: chevron and progress
  const hasGroupAffordances = task.hasChildren
  const chevronWidth = hasGroupAffordances ? 18 : 0
  const estimateWidth = task.estimate ? 11 : 0
  const progressText = group ? `${group.progress.done}/${group.progress.total}` : ''
  const hasRightLabel = (hasGroupAffordances && !!progressText) || (!hasGroupAffordances && depCount > 0)
  const rightLabelWidth = hasRightLabel ? 32 : 6

  // Single-line: vertically centered
  const titleY = node.y + NODE_HEIGHT / 2 + 4.5

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
        fill={getNodeFill(node, highlight, task.worktree)}
        fillOpacity={getNodeFillOpacity(node, highlight, task.worktree)}
        stroke={strokeColor}
        strokeWidth={strokeW}
      />

      {/* Worktree indicator — right accent bar */}
      {task.worktree && (
        <rect
          x={node.x + NODE_WIDTH - 3}
          y={node.y + 6}
          width={2.5}
          height={NODE_HEIGHT - 12}
          rx={1.25}
          fill={getWorktreeColor(task.worktree)}
          opacity={showLabels ? 0.7 : 0}
          style={{ transition: 'opacity 150ms ease-out' }}
        />
      )}

      {/* Selected indicator — subtle left accent */}
      {isSelected && (
        <rect
          x={node.x}
          y={node.y + 6}
          width={2.5}
          height={NODE_HEIGHT - 12}
          rx={1.25}
          fill={'var(--sol-accent)'}
        />
      )}

      {/* Search match ring */}
      {isSearchMatch && (
        <rect
          x={node.x - 3}
          y={node.y - 3}
          width={NODE_WIDTH + 6}
          height={NODE_HEIGHT + 6}
          rx={9}
          fill="none"
          stroke={'var(--sol-violet)'}
          strokeWidth={1}
          strokeDasharray="4 3"
          opacity={0.5}
        />
      )}

      {/* Collapse chevron for group tasks */}
      {hasGroupAffordances && (
        <g
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(node.id); onClick(node.id) }}
          style={{ cursor: 'pointer' }}
        >
          <rect x={node.x} y={node.y} width={18} height={NODE_HEIGHT} fill="transparent" rx={6} />
          <path
            d={isCollapsed
              ? `M ${node.x + 7} ${node.y + NODE_HEIGHT / 2 - 3.5} l 4.5 3.5 -4.5 3.5`
              : `M ${node.x + 5.5} ${node.y + NODE_HEIGHT / 2 - 2.5} l 3.5 4.5 3.5 -4.5`
            }
            fill="none"
            stroke={'var(--sol-base1)'}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}

      {/* State dot — left edge accent */}
      <StateDot state={task.state} cx={node.x + chevronWidth + 12} cy={node.y + NODE_HEIGHT / 2} />

      {/* Estimate badge — after state dot */}
      {task.estimate && (
        <text
          x={node.x + chevronWidth + 22}
          y={titleY}
          fontSize={9}
          fontWeight={700}
          fill={'var(--sol-muted)'}
          opacity={showLabels ? 0.7 : 0}
          textTransform="uppercase"
          letterSpacing="0.03em"
          style={{ transition: 'opacity 150ms ease-out', textTransform: 'uppercase' }}
        >
          {task.estimate}
        </text>
      )}

      {/* Clip path for text overflow */}
      <clipPath id={`clip-${node.id}`}>
        <rect
          x={node.x + chevronWidth + 22 + estimateWidth}
          y={node.y}
          width={NODE_WIDTH - chevronWidth - 22 - estimateWidth - rightLabelWidth}
          height={NODE_HEIGHT}
        />
      </clipPath>

      {/* Title — single line */}
      <text
        x={node.x + chevronWidth + 24 + estimateWidth}
        y={titleY}
        fontSize={13}
        fontWeight={500}
        fill={'var(--sol-text-dark)'}
        opacity={showLabels ? 1 : 0}
        letterSpacing="-0.01em"
        style={{ transition: 'opacity 150ms ease-out' }}
        clipPath={`url(#clip-${node.id})`}
      >
        {task.title}
      </text>

      {/* Right-aligned: progress for groups, dep count for leaves */}
      {hasGroupAffordances && progressText && (
        <text
          x={node.x + NODE_WIDTH - 10}
          y={titleY}
          fontSize={10}
          fontWeight={500}
          textAnchor="end"
          fill={'var(--sol-muted)'}
          opacity={showLabels ? 0.85 : 0}
          style={{ transition: 'opacity 150ms ease-out' }}
        >
          {progressText}
        </text>
      )}

      {!hasGroupAffordances && depCount > 0 && (
        <text
          x={node.x + NODE_WIDTH - 10}
          y={titleY}
          fontSize={10}
          fontWeight={500}
          textAnchor="end"
          fill={'var(--sol-muted)'}
          opacity={showLabels ? 0.75 : 0}
          style={{ transition: 'opacity 150ms ease-out' }}
        >
          {depCount}
        </text>
      )}
    </g>
  )
}
