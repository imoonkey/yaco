import type { LayoutGroup } from './taskGraphModel'
import type { HighlightModel } from './taskGraphSelection'

// Renders a vertical indentation guide line for an expanded group
export function TaskGraphGroup({ group, subtreeIds, highlight }: {
  group: LayoutGroup
  subtreeIds: string[]
  highlight: HighlightModel
}) {
  // No guide line for collapsed groups
  if (group.childIds.length === 0) return null

  const isDimmed = highlight.dimUnrelated &&
    !subtreeIds.some(id => highlight.activeTaskIds.has(id) || highlight.upstreamTaskIds.has(id) || highlight.downstreamTaskIds.has(id))

  return (
    <line
      x1={group.guideX}
      y1={group.guideY1}
      x2={group.guideX}
      y2={group.guideY2}
      stroke={'var(--sol-base2)'}
      strokeWidth={1}
      opacity={isDimmed ? 0.2 : 0.8}
      style={{ transition: 'opacity 150ms ease-out' }}
    />
  )
}
