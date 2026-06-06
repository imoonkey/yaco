import type { LayoutNode, TaskGraphTask, LayoutGroup, Priority } from './taskGraphModel'
import { NODE_HEIGHT } from './taskGraphModel'
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

// --- Metadata rail ---------------------------------------------------------
// A right-aligned strip of metadata badges. Fields are kept in priority order
// (id > priority > workset > agent) and dropped from the RIGHT as the row
// narrows, so a shrinking card sheds agent first, then workset, then priority,
// then id — id is the stable anchor closest to the title. The full metadata set
// always lives in the tooltip and detail panel, so dropping here loses nothing.
//
// Conditional presence (default/common values are hidden to avoid noise):
//   - id      always shown (truncated)
//   - priority shown only when != 'normal'
//   - workset  shown only when != 'active'
//   - agent    shown only when set
// Visibility is width-driven (measured against node.width), not CSS breakpoints.

const RAIL_GAP = 5
const RAIL_PADX = 5
const RAIL_CHAR_W = 5.4   // approx glyph advance at fontSize 9
const RAIL_MIN_TITLE = 72 // px of title kept before the rail may claim space

const PRIORITY_COLOR: Record<Priority, string> = {
  critical: 'var(--sol-red)',
  high: 'var(--sol-orange)',
  normal: 'var(--sol-muted)',
  low: 'var(--sol-base1)',
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function railItemWidth(text: string): number {
  return Math.ceil(text.length * RAIL_CHAR_W) + RAIL_PADX * 2
}

type RailItem = { key: string; text: string; color: string; mono: boolean; width: number; x: number }

function buildRail(task: TaskGraphTask, leftBound: number, rightBound: number): RailItem[] {
  const candidates: Omit<RailItem, 'x'>[] = []
  const idText = truncate(task.id, 16)
  candidates.push({ key: 'id', text: idText, color: 'var(--sol-base1)', mono: true, width: railItemWidth(idText) })
  if (task.priority !== 'normal') {
    candidates.push({ key: 'priority', text: task.priority, color: PRIORITY_COLOR[task.priority], mono: false, width: railItemWidth(task.priority) })
  }
  if (task.workset !== 'active') {
    candidates.push({ key: 'workset', text: task.workset, color: 'var(--sol-violet)', mono: false, width: railItemWidth(task.workset) })
  }
  if (task.agent) {
    const agentText = truncate(task.agent, 12)
    candidates.push({ key: 'agent', text: agentText, color: 'var(--sol-cyan)', mono: false, width: railItemWidth(agentText) })
  }

  // Greedily keep fields from the front (highest priority) while they fit; the
  // first field that overflows drops itself and everything lower-priority after it.
  const avail = rightBound - leftBound
  const kept: Omit<RailItem, 'x'>[] = []
  let used = 0
  for (const c of candidates) {
    const add = c.width + (kept.length ? RAIL_GAP : 0)
    if (used + add > avail) break
    used += add
    kept.push(c)
  }

  // Right-align the kept group so its last badge ends at rightBound.
  let x = rightBound - used
  return kept.map(c => {
    const item: RailItem = { ...c, x }
    x += c.width + RAIL_GAP
    return item
  })
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

  // Metadata rail — right-aligned, between the title and the existing right
  // label (progress/dep count) and clear of the right dependency gutter.
  const titleClipX = node.x + chevronWidth + 22 + estimateWidth
  const rightLabelX = node.x + node.width - rightLabelWidth
  const rail = buildRail(task, titleClipX + RAIL_MIN_TITLE, rightLabelX - RAIL_GAP)
  const clipRight = rail.length ? rail[0].x - RAIL_GAP : rightLabelX
  const titleClipWidth = Math.max(0, clipRight - titleClipX)
  const railTextY = node.y + NODE_HEIGHT / 2 + 3

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
        width={node.width}
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
          x={node.x + node.width - 3}
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
          width={node.width + 6}
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
          letterSpacing="0.03em"
          style={{ transition: 'opacity 150ms ease-out', textTransform: 'uppercase' }}
        >
          {task.estimate}
        </text>
      )}

      {/* Clip path for text overflow */}
      <clipPath id={`clip-${node.id}`}>
        <rect
          x={titleClipX}
          y={node.y}
          width={titleClipWidth}
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
          x={node.x + node.width - 10}
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
          x={node.x + node.width - 10}
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

      {/* Metadata rail — id / priority / workset / agent badges, width-driven */}
      {rail.map(item => (
        <g key={item.key} opacity={showLabels ? 1 : 0} style={{ transition: 'opacity 150ms ease-out' }}>
          <rect
            x={item.x}
            y={node.y + NODE_HEIGHT / 2 - 8}
            width={item.width}
            height={16}
            rx={4}
            fill={item.color}
            fillOpacity={0.12}
          />
          <text
            x={item.x + item.width / 2}
            y={railTextY}
            textAnchor="middle"
            fontSize={9}
            fontWeight={600}
            fill={item.color}
            fontFamily={item.mono ? 'var(--font-mono)' : undefined}
            letterSpacing={item.mono ? '0' : '0.02em'}
          >
            {item.text}
          </text>
        </g>
      ))}
    </g>
  )
}
