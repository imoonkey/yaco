// Metadata rail — a right-aligned strip of metadata badges for a task card.
// Fields are kept in display order (id > agent > priority > workset) and dropped
// from the RIGHT as the row narrows, so a shrinking card sheds workset first, then
// priority, then agent, then id — id is the stable anchor closest to the title.
// The full metadata set always lives in the tooltip and detail panel, so dropping
// here loses nothing.
//
// Every badge is rendered with identical geometry and typography (monospace, equal
// padding); only the color differs per field. Field text is WIDTH-DRIVEN: a badge
// shows its full text when it fits, so a wide row never shows a clipped "id…" with
// empty space beside it. The id truncates (with an ellipsis) only when it is wider
// than the space the rail has; below a small minimum the rail hides entirely so the
// title keeps the room.
//
// Conditional presence (default/common values are hidden to avoid noise):
//   - id       always shown (full when it fits, otherwise width-fitted)
//   - agent    shown only when set
//   - priority shown only when != 'normal'
//   - workset  shown only when != 'active'
// Visibility is width-driven (measured against node.width), not CSS breakpoints.

import type { TaskGraphTask, Priority } from './taskGraphModel'

export const RAIL_FONT_SIZE = 10.5 // badge text size
export const RAIL_CHAR_W = 6.3      // monospace glyph advance at RAIL_FONT_SIZE (≈ size*0.6)
export const RAIL_GAP = 5
export const RAIL_PADX = 5           // symmetric horizontal padding inside each badge
export const RAIL_MIN_TITLE = 150    // px of title kept before the rail may claim space
export const RAIL_MIN_BADGE = 42     // smallest id badge worth showing; below this the rail hides

export const PRIORITY_COLOR: Record<Priority, string> = {
  critical: 'var(--sol-red)',
  high: 'var(--sol-orange)',
  normal: 'var(--sol-muted)',
  low: 'var(--sol-base1)',
}

function railItemWidth(text: string): number {
  return Math.ceil(text.length * RAIL_CHAR_W) + RAIL_PADX * 2
}

// Largest prefix of `text` (with a trailing ellipsis when shortened) whose badge
// fits in `maxWidth`. Returns '' when not even a one-character badge fits.
function fitText(text: string, maxWidth: number): string {
  if (railItemWidth(text) <= maxWidth) return text
  for (let n = text.length - 1; n >= 1; n--) {
    const candidate = text.slice(0, n) + '…'
    if (railItemWidth(candidate) <= maxWidth) return candidate
  }
  return ''
}

export type RailItem = { key: string; text: string; color: string; width: number; x: number }

export function buildRail(task: TaskGraphTask, leftBound: number, rightBound: number): RailItem[] {
  const avail = rightBound - leftBound
  if (avail <= 0) return []

  // Full-text candidates in display order; widths come from the full text so a
  // badge expands to show everything when the row is wide.
  const candidates: Omit<RailItem, 'x'>[] = []
  candidates.push({ key: 'id', text: task.id, color: 'var(--sol-base1)', width: railItemWidth(task.id) })
  if (task.agent) {
    candidates.push({ key: 'agent', text: task.agent, color: 'var(--sol-cyan)', width: railItemWidth(task.agent) })
  }
  if (task.priority !== 'normal') {
    candidates.push({ key: 'priority', text: task.priority, color: PRIORITY_COLOR[task.priority], width: railItemWidth(task.priority) })
  }
  if (task.workset !== 'active') {
    candidates.push({ key: 'workset', text: task.workset, color: 'var(--sol-violet)', width: railItemWidth(task.workset) })
  }

  // Greedily keep full-width badges from the front (highest priority) while they
  // fit; the first field that overflows drops itself and everything after it.
  const kept: Omit<RailItem, 'x'>[] = []
  let used = 0
  for (const c of candidates) {
    const add = c.width + (kept.length ? RAIL_GAP : 0)
    if (used + add > avail) break
    used += add
    kept.push(c)
  }

  // The id alone is wider than the rail's space: show a width-fitted id rather
  // than nothing — unless even that would be too small to read.
  if (kept.length === 0) {
    const idText = fitText(task.id, avail)
    const width = railItemWidth(idText)
    if (!idText || width < RAIL_MIN_BADGE) return []
    return [{ key: 'id', text: idText, color: 'var(--sol-base1)', width, x: rightBound - width }]
  }

  // Right-align the kept group so its last badge ends at rightBound.
  let x = rightBound - used
  return kept.map(c => {
    const item: RailItem = { ...c, x }
    x += c.width + RAIL_GAP
    return item
  })
}
