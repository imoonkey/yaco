import type { LayoutEdge } from './taskGraphModel'
import type { HighlightModel } from './taskGraphSelection'

const COLORS = {
  default: 'var(--sol-base1)',
  upstream: 'var(--sol-orange)',
  downstream: 'var(--sol-cyan)',
  cycle: 'var(--sol-red)',
}

function isActiveEdge(edge: LayoutEdge, highlight: HighlightModel): boolean {
  if (highlight.activeEdgeIds.has(edge.id)) return true
  return edge.originalEdgeIds?.some(id => highlight.activeEdgeIds.has(id)) ?? false
}

function edgeColor(edge: LayoutEdge, highlight: HighlightModel): string {
  if (edge.isCycle) return COLORS.cycle
  if (!highlight.dimUnrelated || !isActiveEdge(edge, highlight)) return COLORS.default

  if (highlight.upstreamTaskIds.has(edge.sourceId)) return COLORS.upstream
  if (highlight.downstreamTaskIds.has(edge.targetId)) return COLORS.downstream
  return COLORS.default
}

function edgeOpacity(edge: LayoutEdge, highlight: HighlightModel): number {
  if (edge.isCycle) return 0.7
  if (!highlight.dimUnrelated) return 0.3
  return isActiveEdge(edge, highlight) ? 1.0 : 0.15
}

function edgeWidth(edge: LayoutEdge, highlight: HighlightModel): number {
  if (!highlight.dimUnrelated) return 1
  return isActiveEdge(edge, highlight) ? 2 : 1
}

function markerRef(edge: LayoutEdge, highlight: HighlightModel): string {
  if (edge.isCycle) return 'url(#arrow-cycle)'
  if (highlight.dimUnrelated && isActiveEdge(edge, highlight)) {
    if (highlight.upstreamTaskIds.has(edge.sourceId)) return 'url(#arrow-upstream)'
    if (highlight.downstreamTaskIds.has(edge.targetId)) return 'url(#arrow-downstream)'
  }
  return 'url(#arrow-default)'
}

function getEdgeMidpoint(path: string): { x: number; y: number } | null {
  const match = path.match(/^M\s+([\d.]+),([\d.]+)\s+C\s+[\d.]+,[\d.]+\s+[\d.]+,[\d.]+\s+([\d.]+),([\d.]+)$/)
  if (!match) return null
  return {
    x: (parseFloat(match[1]) + parseFloat(match[3])) / 2,
    y: (parseFloat(match[2]) + parseFloat(match[4])) / 2,
  }
}

export function TaskGraphEdges({ edges, highlight }: {
  edges: LayoutEdge[]
  highlight: HighlightModel
}) {
  return (
    <g data-layer="edges">
      <defs>
        <marker id="arrow-default" viewBox="0 0 6 6" refX="6" refY="3"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 6 3 L 0 6 z" fill={COLORS.default} />
        </marker>
        <marker id="arrow-upstream" viewBox="0 0 6 6" refX="6" refY="3"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 6 3 L 0 6 z" fill={COLORS.upstream} />
        </marker>
        <marker id="arrow-downstream" viewBox="0 0 6 6" refX="6" refY="3"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 6 3 L 0 6 z" fill={COLORS.downstream} />
        </marker>
        <marker id="arrow-cycle" viewBox="0 0 6 6" refX="6" refY="3"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 6 3 L 0 6 z" fill={COLORS.cycle} />
        </marker>
      </defs>
      {edges.map(edge => {
        const mid = edge.count > 1 ? getEdgeMidpoint(edge.path) : null
        return (
          <g key={edge.id}>
            <path
              d={edge.path}
              fill="none"
              stroke={edgeColor(edge, highlight)}
              strokeWidth={edgeWidth(edge, highlight)}
              opacity={edgeOpacity(edge, highlight)}
              markerEnd={markerRef(edge, highlight)}
              style={{
                transition: 'opacity 150ms ease-out, stroke 150ms ease-out, stroke-width 150ms ease-out',
                d: `path("${edge.path}")`,
              }}
            />
            {mid && (
              <text
                x={mid.x}
                y={mid.y - 4}
                fontSize={10}
                textAnchor="middle"
                fill={'var(--sol-base01)'}
                opacity={edgeOpacity(edge, highlight)}
              >
                ({edge.count})
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}
