import { SOLARIZED_LIGHT } from '../lib/solarizedLight'
import type { LayoutGroup } from './taskGraphModel'
import type { HighlightModel } from './taskGraphSelection'

const STATE_COLORS: Record<string, string> = {
  ready: SOLARIZED_LIGHT.blue,
  running: SOLARIZED_LIGHT.yellow,
  done: SOLARIZED_LIGHT.green,
  blocked: SOLARIZED_LIGHT.red,
  cancelled: SOLARIZED_LIGHT.base1,
}

// Depth-based styling (Solarized Light palette)
function getDepthStyle(depth: number) {
  if (depth === 0) return { bgOpacity: 1, borderOpacity: 1, accentOpacity: 0.6 }
  if (depth === 1) return { bgOpacity: 0.95, borderOpacity: 0.7, accentOpacity: 0.5 }
  return { bgOpacity: 0.90, borderOpacity: 0.5, accentOpacity: 0.4 }
}

export function TaskGraphGroup({ group, subtreeIds, highlight, isSelected, onClick }: {
  group: LayoutGroup
  subtreeIds: string[]
  highlight: HighlightModel
  isSelected: boolean
  onClick: (id: string) => void
}) {
  const stateColor = STATE_COLORS[group.aggregateState] ?? SOLARIZED_LIGHT.base1
  const depthStyle = getDepthStyle(group.depth)

  const isDimmed = highlight.dimUnrelated &&
    !subtreeIds.some(id => highlight.activeTaskIds.has(id) || highlight.upstreamTaskIds.has(id) || highlight.downstreamTaskIds.has(id))

  const dimFactor = isDimmed ? 0.4 : 1

  return (
    <>
      {/* Container background */}
      <rect
        x={group.x}
        y={group.y}
        width={group.width}
        height={group.height}
        rx={8}
        fill={SOLARIZED_LIGHT.base3}
        fillOpacity={depthStyle.bgOpacity * dimFactor}
        stroke={isSelected ? SOLARIZED_LIGHT.focusBorder : SOLARIZED_LIGHT.border}
        strokeWidth={isSelected ? 2 : 1}
        strokeOpacity={depthStyle.borderOpacity * dimFactor}
        onClick={(e) => { e.stopPropagation(); onClick(group.id) }}
        style={{ cursor: 'pointer', transition: 'opacity 150ms ease-out' }}
      />
      {/* State accent on left border */}
      <rect
        x={group.x}
        y={group.y + 8}
        width={4}
        height={Math.max(group.height - 16, 0)}
        rx={2}
        fill={stateColor}
        opacity={depthStyle.accentOpacity * dimFactor}
        style={{ transition: 'opacity 150ms ease-out' }}
      />
    </>
  )
}
