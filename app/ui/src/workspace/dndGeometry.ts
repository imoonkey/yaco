// Drop-zone + legality geometry for panel drag-and-drop — pure math, no React, no
// DOM. The interaction layer (drag context, drop overlays) feeds in measured rects
// and a pointer; these functions answer "where does it land" and "is it allowed".
//
// Two halves:
//   - GEOMETRY: tabInsertIndex / sidebarInsertIndex (insertion index along a strip),
//     bodyDropZone (which third-band of a group body), edgeZone (a far-edge strip).
//   - LEGALITY: legalZones(payload, target) encodes the region constraint matrix —
//     the visual gate that decides which zones may render. The normalize funnel in
//     panelLayoutModel is the second, authoritative gate; this is the first.
//
// Local types only. `dnd-drop-center` adapts the real DragPayload (from
// WorkspaceDragContext) to the minimal `DropPayload` shape these pure fns need.

// --- Coordinates ------------------------------------------------------------

/** A measured rect in viewport pixels (e.g. `getBoundingClientRect`). */
export type Rect = { x: number; y: number; width: number; height: number }

/** A pointer position in the same coordinate space as the rects. */
export type Point = { x: number; y: number }

// --- Drag / drop descriptors (minimal, local) -------------------------------

/** What is being dragged. The real payload carries more (ids, panel); the geometry
 *  only needs the kind to decide legality. */
export type DragKind = 'tab' | 'group' | 'dock'

export type DropPayload = { kind: DragKind }

/** The three enforced layout regions (see `regionsOf` in panelLayoutModel). */
export type Region = 'left' | 'center' | 'right'

/** The kind of surface under the pointer:
 *  - `group`  — a group's tab bar / the group as a whole (reorder / merge).
 *  - `body`   — a group's body area (edge splits + center merge).
 *  - `sidebar`— a sidebar column (dock insert, or right-group merge).
 *  - `edge`   — a thin far-edge strip (create / extend a sidebar). */
export type TargetKind = 'group' | 'body' | 'sidebar' | 'edge'

export type DropTarget = { region: Region; kind: TargetKind }

// --- Zones ------------------------------------------------------------------

/** Every drop zone the overlays can render. `left`/`right`/`up`/`down` split a group
 *  body toward that edge; `center` merges into a group (body center, whole-group
 *  drop, or right-sidebar merge); `tab` inserts into a tab strip; `sidebar` inserts a
 *  dock among a column; `edge` creates/extends a sidebar at a far edge. */
export type Zone =
  | 'left' | 'right' | 'up' | 'down'
  | 'center'
  | 'tab'
  | 'sidebar'
  | 'edge'

/** The zones a group body resolves to: four edge splits + a center merge. */
export type BodyZone = 'left' | 'right' | 'up' | 'down' | 'center'

/** Far edge a thin edge strip points to. */
export type EdgeSide = 'left' | 'right'

// --- Geometry ---------------------------------------------------------------

/** Insertion index into a horizontal tab strip: the count of tabs whose horizontal
 *  midpoint is at or left of `x`. 0 = before the first tab, `tabRects.length` =
 *  after the last. */
export function tabInsertIndex(tabRects: readonly Rect[], x: number): number {
  let i = 0
  while (i < tabRects.length && x >= tabRects[i].x + tabRects[i].width / 2) i++
  return i
}

/** Insertion index into a vertical item list (a sidebar column): the count of items
 *  whose vertical midpoint is at or above `y`. */
export function sidebarInsertIndex(itemRects: readonly Rect[], y: number): number {
  let i = 0
  while (i < itemRects.length && y >= itemRects[i].y + itemRects[i].height / 2) i++
  return i
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Which zone of a group body `point` falls in. The central third-square (the inner
 *  `[1/3, 2/3]` on both axes) is `center` (merge); everywhere else resolves to the
 *  nearest of the four edges (a 33% edge band per side). A degenerate rect → `center`. */
export function bodyDropZone(rect: Rect, point: Point): BodyZone {
  if (rect.width <= 0 || rect.height <= 0) return 'center'
  const fx = clamp01((point.x - rect.x) / rect.width)
  const fy = clamp01((point.y - rect.y) / rect.height)
  if (fx >= 1 / 3 && fx <= 2 / 3 && fy >= 1 / 3 && fy <= 2 / 3) return 'center'
  const dist = { left: fx, right: 1 - fx, up: fy, down: 1 - fy }
  const min = Math.min(dist.left, dist.right, dist.up, dist.down)
  if (min === dist.left) return 'left'
  if (min === dist.right) return 'right'
  if (min === dist.up) return 'up'
  return 'down'
}

/** Width (px) of the far-edge strip that reveals/extends a sidebar. */
export const EDGE_BAND_PX = 24

/** Which far edge of the root `point` is within `EDGE_BAND_PX` of, or `null` when it
 *  is in neither strip (or vertically outside the root). The left strip wins a tie in
 *  a pathologically narrow root. */
export function edgeZone(rootRect: Rect, point: Point): EdgeSide | null {
  if (point.y < rootRect.y || point.y > rootRect.y + rootRect.height) return null
  const fromLeft = point.x - rootRect.x
  const fromRight = rootRect.x + rootRect.width - point.x
  if (fromLeft >= 0 && fromLeft <= EDGE_BAND_PX) return 'left'
  if (fromRight >= 0 && fromRight <= EDGE_BAND_PX) return 'right'
  return null
}

// --- Legality matrix --------------------------------------------------------

const SPLIT_ZONES: readonly Zone[] = ['left', 'right', 'up', 'down']

/** The legal zones for dropping `payload` on `target` — the visual face of the four
 *  region constraints (left = docks only; right = docks + ≤1 group; docks never in
 *  center; groups never in a left/right body). An empty set means an illegal drop:
 *  no zone renders and the drop is rejected.
 *
 *  Matrix (rows = payload kind, columns = target):
 *    center group : tab→{tab}  group→{center}                 dock→∅
 *    center body  : tab→{splits,center}  group→{splits}       dock→∅
 *    sidebar      : dock→{sidebar}; right also tab/group→{center}; left tab/group→∅
 *    edge         : dock→{edge}; right also tab/group→{edge};   left tab/group→∅ */
export function legalZones(payload: DropPayload, target: DropTarget): Set<Zone> {
  const { kind: pk } = payload
  const { region, kind } = target
  switch (kind) {
    case 'group':
      // A group's tab bar / the whole group — center grid only (the right group is
      // reached via the `sidebar` target, which merges).
      if (region !== 'center') return new Set()
      if (pk === 'tab') return new Set(['tab'])
      if (pk === 'group') return new Set(['center'])
      return new Set()
    case 'body':
      // A group body in the center grid: a tab can split any edge or merge center; a
      // group can only split (a whole-group merge goes through the `group` target).
      if (region !== 'center') return new Set()
      if (pk === 'tab') return new Set([...SPLIT_ZONES, 'center'])
      if (pk === 'group') return new Set(SPLIT_ZONES)
      return new Set()
    case 'sidebar':
      // Docks insert into either sidebar; a tab/group merges into the right sidebar's
      // one group, never the docks-only left.
      if (pk === 'dock') return new Set(['sidebar'])
      return region === 'right' ? new Set(['center']) : new Set()
    case 'edge':
      // A dock can reveal/extend either edge; a tab/group can only create the right
      // sidebar (the left holds no groups).
      if (pk === 'dock') return new Set(['edge'])
      return region === 'right' ? new Set(['edge']) : new Set()
  }
}
