import { useCallback } from 'react'
import { SOLARIZED_LIGHT } from '../lib/solarizedLight'
import type { GraphLayout, TaskGraphModel } from './taskGraphModel'
import type { ViewportTransform } from '../hooks/usePanZoom'

const MINIMAP_W = 160
const MINIMAP_H = 100

const STATE_COLORS: Record<string, string> = {
  ready: SOLARIZED_LIGHT.blue,
  running: SOLARIZED_LIGHT.yellow,
  done: SOLARIZED_LIGHT.green,
  blocked: SOLARIZED_LIGHT.red,
  cancelled: SOLARIZED_LIGHT.base1,
}

export function TaskGraphMinimap({ layout, graph, viewport, containerWidth, containerHeight, onPanTo }: {
  layout: GraphLayout
  graph: TaskGraphModel
  viewport: ViewportTransform
  containerWidth: number
  containerHeight: number
  onPanTo: (x: number, y: number) => void
}) {
  const scaleX = layout.bounds.width ? MINIMAP_W / layout.bounds.width : 1
  const scaleY = layout.bounds.height ? MINIMAP_H / layout.bounds.height : 1
  const minimapScale = Math.min(scaleX, scaleY)

  const handleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const graphX = mx / minimapScale
    const graphY = my / minimapScale
    onPanTo(graphX, graphY)
  }, [minimapScale, onPanTo])

  if (!layout.bounds.width || !layout.bounds.height) return null

  const vpX = (-viewport.tx / viewport.scale) * minimapScale
  const vpY = (-viewport.ty / viewport.scale) * minimapScale
  const vpW = (containerWidth / viewport.scale) * minimapScale
  const vpH = (containerHeight / viewport.scale) * minimapScale

  return (
    <div
      className="absolute bottom-4 right-4 rounded overflow-hidden"
      style={{
        width: MINIMAP_W,
        height: MINIMAP_H,
        backgroundColor: SOLARIZED_LIGHT.base2,
        border: `1px solid ${SOLARIZED_LIGHT.border}`,
        opacity: 0.85,
      }}
    >
      <svg width={MINIMAP_W} height={MINIMAP_H} onClick={handleClick} style={{ cursor: 'crosshair' }}>
        {/* Edges as thin lines */}
        {layout.edges.map(edge => {
          const source = layout.nodes.get(edge.sourceId)
          const target = layout.nodes.get(edge.targetId)
          if (!source || !target) return null
          return (
            <line
              key={edge.id}
              x1={(source.x + source.width / 2) * minimapScale}
              y1={(source.y + source.height / 2) * minimapScale}
              x2={(target.x + target.width / 2) * minimapScale}
              y2={(target.y + target.height / 2) * minimapScale}
              stroke={SOLARIZED_LIGHT.base1}
              strokeWidth={0.5}
              opacity={0.4}
            />
          )
        })}

        {/* Nodes as dots */}
        {Array.from(layout.nodes.values()).map(node => {
          const task = graph.tasks.get(node.id)
          return (
            <circle
              key={node.id}
              cx={(node.x + node.width / 2) * minimapScale}
              cy={(node.y + node.height / 2) * minimapScale}
              r={2}
              fill={STATE_COLORS[task?.state ?? 'cancelled'] ?? SOLARIZED_LIGHT.base1}
            />
          )
        })}

        {/* Viewport rect */}
        <rect
          x={vpX}
          y={vpY}
          width={Math.max(vpW, 8)}
          height={Math.max(vpH, 6)}
          fill={SOLARIZED_LIGHT.blue}
          fillOpacity={0.15}
          stroke={SOLARIZED_LIGHT.blue}
          strokeWidth={1}
        />
      </svg>
    </div>
  )
}
