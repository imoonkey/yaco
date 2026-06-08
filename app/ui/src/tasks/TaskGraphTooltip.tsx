import { useRef, useLayoutEffect } from 'react'
import type { TaskGraphModel } from './taskGraphModel'

export type TooltipTarget = {
  id: string
  graphX: number   // center X in graph coords
  graphY: number   // top Y in graph coords
  graphH: number   // height in graph coords
}

function MetaChip({ children, color, mono }: { children: React.ReactNode; color?: string; mono?: boolean }) {
  return (
    <span
      style={{
        fontSize: 'var(--text-ui-xs)',
        lineHeight: 1.4,
        padding: '1px 5px',
        borderRadius: 4,
        color: color ?? 'var(--sol-base01)',
        backgroundColor: 'var(--sol-subtle-bg)',
        fontFamily: mono ? 'var(--font-mono)' : undefined,
      }}
    >
      {children}
    </span>
  )
}

// `containerRef` is the scroll container: its scroll offsets map graph coords to
// the visible viewport, and its client size clamps the tooltip on screen. The
// tooltip is cleared on scroll/zoom, so reading offsets in layout effect is exact.
export function TaskGraphTooltip({ target, graph, scale, containerRef }: {
  target: TooltipTarget
  graph: TaskGraphModel
  scale: number
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const tooltipRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = tooltipRef.current
    const container = containerRef.current
    if (!el || !container) return

    const screenX = target.graphX * scale - container.scrollLeft
    const screenY = target.graphY * scale - container.scrollTop
    const screenBottom = (target.graphY + target.graphH) * scale - container.scrollTop
    const flipped = screenY - 8 < 40

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
  }, [target, scale, containerRef])

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
        background: 'var(--sol-editor-bg)',
        border: '1px solid var(--sol-border)',
        boxShadow: 'var(--elevation-2)',
        padding: '6px 10px',
        maxWidth: 300,
        borderRadius: 5,
        pointerEvents: 'none' as const,
        zIndex: 30,
      }}
    >
      <div style={{ fontSize: 'var(--text-ui-md)', fontWeight: 600, color: 'var(--sol-text-dark)', lineHeight: 1.3 }}>
        {title}
      </div>
      {description && (
        <div style={{
          fontSize: 'var(--text-ui-sm)',
          color: 'var(--sol-text)',
          marginTop: 3,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          lineHeight: 1.4,
        }}>
          {description}
        </div>
      )}
      {progress && (
        <div style={{ fontSize: 'var(--text-ui-xs)', color: 'var(--sol-text-faint)', marginTop: 3, fontWeight: 500 }}>
          {progress}
        </div>
      )}
      {/* Full metadata — always present here so nothing is lost when the node rail collapses */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
        <MetaChip mono>{task.id}</MetaChip>
        <MetaChip color="var(--sol-base01)">{task.priority}</MetaChip>
        <MetaChip color="var(--sol-violet)">{task.workset}</MetaChip>
        {task.agents.map(a => (
          <MetaChip key={a} color="var(--sol-cyan)">{a}</MetaChip>
        ))}
        {task.tags.map(tag => (
          <MetaChip key={tag}>#{tag}</MetaChip>
        ))}
      </div>
    </div>
  )
}
