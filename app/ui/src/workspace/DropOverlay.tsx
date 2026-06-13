// DropOverlay — the editor-grid body drop surface. Wraps a group's body and, during a
// live pane drag, resolves the pointer to a body zone (`bodyDropZone`) gated by the
// legality matrix (`legalZones`), renders the half/full highlight for that zone, and on
// drop performs the structural move:
//   - an edge zone → a split-drop beside this group
//       · a tab   → `moveTabToSplit` (a fresh group beside this one, the tab moved in)
//       · a group → `moveGroup` beside (the whole group relocated into a new split)
//   - the center  → a merge into this group (a dragged tab joins this group's strip)
//
// Region gating falls out of `legalZones`: a non-center body (a sidebar group) yields an
// empty set for every zone, so the overlay never highlights and the drop is rejected
// (no `preventDefault` → the browser refuses it). A dock payload is likewise illegal on a
// body. The geometry only needs the payload KIND, so a tiny `{ kind }` adapter bridges
// the real `DragPayload` to the pure `DropPayload` shape.
import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useDrag, isPaneDrag } from './WorkspaceDragContext'
import type { GroupPlacement, SplitSide } from './context'
import { bodyDropZone, legalZones, type BodyZone, type Region, type Rect } from './dndGeometry'

// Body-edge zone → the split side the reducer derives an axis from (up/down → column,
// left/right → row).
const SIDE_OF: Record<Exclude<BodyZone, 'center'>, SplitSide> = {
  left: 'left', right: 'right', up: 'above', down: 'below',
}

// The half (edge) / full (center) highlight rect for each zone, as CSS insets.
const ZONE_BOX: Record<BodyZone, CSSProperties> = {
  center: { inset: 0 },
  left: { left: 0, top: 0, bottom: 0, width: '50%' },
  right: { right: 0, top: 0, bottom: 0, width: '50%' },
  up: { left: 0, right: 0, top: 0, height: '50%' },
  down: { left: 0, right: 0, bottom: 0, height: '50%' },
}

const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, width: r.width, height: r.height })

export type DropOverlayProps = {
  /** The group whose body this overlays — the merge / split target. */
  groupId: string
  /** This group's enforced region; the legality gate is empty outside `center`. */
  region: Region
  /** Current tab count — a center merge appends the moved tab after the last. */
  tabCount: number
  onMoveTab: (fromGroupId: string, instanceId: string, toGroupId: string, toIndex: number) => void
  onMoveTabToSplit: (fromGroupId: string, instanceId: string, targetGroupId: string, side: SplitSide) => void
  onMoveGroup: (groupId: string, placement: GroupPlacement) => void
  /** The group body this overlay sits over (absent for an empty group). */
  children?: ReactNode
}

export function DropOverlay(props: DropOverlayProps) {
  const { groupId, region, tabCount, onMoveTab, onMoveTabToSplit, onMoveGroup, children } = props
  const drag = useDrag()
  const ref = useRef<HTMLDivElement>(null)
  const [zone, setZone] = useState<BodyZone | null>(null)

  // Resolve the pointer to a LEGAL body zone, or null (no live payload / wrong mime /
  // an illegal zone for this payload+region). A drop target needs BOTH a live payload
  // AND our pane mime, so a stray foreign/text-plain drag never lights up.
  const resolve = (e: React.DragEvent): BodyZone | null => {
    const payload = drag.peek()
    if (!payload || !isPaneDrag(e) || !ref.current) return null
    const z = bodyDropZone(toRect(ref.current.getBoundingClientRect()), { x: e.clientX, y: e.clientY })
    return legalZones({ kind: payload.kind }, { region, kind: 'body' }).has(z) ? z : null
  }

  const onDragOver = (e: React.DragEvent) => {
    const z = resolve(e)
    if (!z) { setZone(null); return }
    e.preventDefault() // accept the drop
    setZone(z)
  }

  const onDragLeave = (e: React.DragEvent) => {
    if (!ref.current?.contains(e.relatedTarget as Node | null)) setZone(null)
  }

  const onDrop = (e: React.DragEvent) => {
    const z = resolve(e)
    setZone(null)
    if (!z) return
    e.preventDefault()
    const payload = drag.peek()
    if (!payload) return
    if (z === 'center') {
      // Center is legal only for a tab (a group merges via the tab bar's `group` target).
      if (payload.kind === 'tab') onMoveTab(payload.fromGroupId, payload.instanceId, groupId, tabCount)
    } else if (payload.kind === 'tab') {
      onMoveTabToSplit(payload.fromGroupId, payload.instanceId, groupId, SIDE_OF[z])
    } else if (payload.kind === 'group') {
      onMoveGroup(payload.groupId, { kind: 'beside', targetId: groupId, side: SIDE_OF[z] })
    }
    drag.clear()
  }

  return (
    <div
      ref={ref}
      className="relative flex flex-col flex-1 min-w-0 min-h-0"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {zone && drag.payload && (
        <div
          data-testid="drop-zone"
          data-zone={zone}
          aria-hidden="true"
          className="absolute pointer-events-none z-10"
          style={{
            ...ZONE_BOX[zone],
            backgroundColor: 'color-mix(in srgb, var(--sol-accent) 18%, transparent)',
            border: '1px solid var(--sol-accent)',
          }}
        />
      )}
    </div>
  )
}
