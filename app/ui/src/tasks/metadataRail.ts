// Metadata rail — a right-aligned strip of metadata badges for a task card.
// Fields are kept in display order (id > agent > priority) and dropped from the
// RIGHT as the row narrows, so a shrinking card sheds priority first, then agent,
// then id — id is the stable anchor closest to the title.
// The full metadata set always lives in the tooltip and detail panel, so dropping
// here loses nothing.
//
// Tags are SECONDARY to the title: the caller only offers the rail whatever space
// is left after the full title fits (see TaskGraphNode). Within that space every
// badge is all-or-nothing — a field shows its full text or is dropped; nothing is
// ever truncated. Badges share identical geometry and monospace typography; only
// the color differs per field.
//
// Conditional presence (default/common values are hidden to avoid noise):
//   - id       always a candidate
//   - agent    shown only when set
//   - priority shown only when != 'normal'
// Visibility is width-driven (measured against the leftover space), not breakpoints.

import type { TaskGraphTask, Priority } from './taskGraphModel'
import { RAIL_CHAR_W } from './graphType'

export const RAIL_GAP = 5
export const RAIL_PADX = 5           // symmetric horizontal padding inside each badge

export const PRIORITY_COLOR: Record<Priority, string> = {
  critical: 'var(--sol-red)',
  high: 'var(--sol-orange)',
  normal: 'var(--sol-muted)',
  low: 'var(--sol-base1)',
}

function railItemWidth(text: string): number {
  return Math.ceil(text.length * RAIL_CHAR_W) + RAIL_PADX * 2
}

export type RailItem = { key: string; text: string; color: string; width: number; x: number }

export function buildRail(task: TaskGraphTask, leftBound: number, rightBound: number): RailItem[] {
  const avail = rightBound - leftBound
  if (avail <= 0) return []

  // Full-text candidates in display order; widths come from the full text.
  const candidates: Omit<RailItem, 'x'>[] = []
  candidates.push({ key: 'id', text: task.id, color: 'var(--sol-base1)', width: railItemWidth(task.id) })
  if (task.agents.length > 0) {
    const text = task.agents.join(' ')
    candidates.push({ key: 'agent', text, color: 'var(--sol-cyan)', width: railItemWidth(text) })
  }
  if (task.priority !== 'normal') {
    candidates.push({ key: 'priority', text: task.priority, color: PRIORITY_COLOR[task.priority], width: railItemWidth(task.priority) })
  }

  // Greedily keep full-width badges from the front (highest priority) while they
  // fit; the first field that overflows drops itself and everything after it. A
  // badge that cannot fit in full is dropped entirely — never truncated.
  const kept: Omit<RailItem, 'x'>[] = []
  let used = 0
  for (const c of candidates) {
    const add = c.width + (kept.length ? RAIL_GAP : 0)
    if (used + add > avail) break
    used += add
    kept.push(c)
  }
  if (kept.length === 0) return []

  // Right-align the kept group so its last badge ends at rightBound.
  let x = rightBound - used
  return kept.map(c => {
    const item: RailItem = { ...c, x }
    x += c.width + RAIL_GAP
    return item
  })
}
