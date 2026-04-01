import { useRef, useLayoutEffect } from 'react'
import { SOLARIZED_LIGHT } from '../lib/solarizedLight'
import type { TaskGraphModel } from './taskGraphModel'
import type { ViewportTransform } from '../hooks/usePanZoom'

export type TooltipTarget = {
  id: string
  graphX: number   // center X in graph coords
  graphY: number   // top Y in graph coords
  graphH: number   // height in graph coords
}

export function TaskGraphTooltip({ target, graph, viewportTransform, containerRef }: {
  target: TooltipTarget
  graph: TaskGraphModel
  viewportTransform: ViewportTransform
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const tooltipRef = useRef<HTMLDivElement>(null)

  const { tx, ty, scale } = viewportTransform
  const screenX = target.graphX * scale + tx
  const screenY = target.graphY * scale + ty
  const screenBottom = (target.graphY + target.graphH) * scale + ty

  const flipped = screenY - 8 < 40

  useLayoutEffect(() => {
    const el = tooltipRef.current
    const container = containerRef.current
    if (!el || !container) return

    const cw = container.clientWidth
    const ch = container.clientHeight
    const tw = el.offsetWidth
    const th = el.offsetHeight

    let left = screenX - tw / 2
    left = Math.max(4, Math.min(left, cw - tw - 4))

    let top: number
    if (flipped) {
      top = screenBottom + 8
      top = Math.min(top, ch - th - 4)
    } else {
      top = screenY - 8 - th
      top = Math.max(4, top)
    }

    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [screenX, screenY, screenBottom, flipped, containerRef])

  const task = graph.tasks.get(target.id)
  if (!task) return null

  const title = task.title
  const description = task.description
  const progress = task.hasChildren
    ? (() => {
        const subtree = graph.subtreeIdsByTask.get(target.id) ?? []
        const leaves = subtree.filter(id => {
          const t = graph.tasks.get(id)
          return t && !t.hasChildren
        })
        const done = leaves.filter(id => graph.tasks.get(id)?.state === 'done').length
        return `${done}/${leaves.length} tasks done`
      })()
    : null

  return (
    <div
      ref={tooltipRef}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        background: SOLARIZED_LIGHT.base3,
        border: `1px solid ${SOLARIZED_LIGHT.border}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        padding: '8px 12px',
        maxWidth: 320,
        borderRadius: 6,
        pointerEvents: 'none' as const,
        zIndex: 30,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: SOLARIZED_LIGHT.base02 }}>
        {title}
      </div>
      {description && (
        <div style={{
          fontSize: 12,
          color: SOLARIZED_LIGHT.base00,
          marginTop: 4,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}>
          {description}
        </div>
      )}
      {progress && (
        <div style={{ fontSize: 11, color: SOLARIZED_LIGHT.base1, marginTop: 4 }}>
          {progress}
        </div>
      )}
    </div>
  )
}
