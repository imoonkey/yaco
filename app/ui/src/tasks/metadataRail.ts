// Metadata rail — a right-aligned strip of metadata badges for a task card.
// Fields are kept in priority order (id > priority > workset > agent) and dropped
// from the RIGHT as the row narrows, so a shrinking card sheds agent first, then
// workset, then priority, then id — id is the stable anchor closest to the title.
// The full metadata set always lives in the tooltip and detail panel, so dropping
// here loses nothing.
//
// Conditional presence (default/common values are hidden to avoid noise):
//   - id      always shown (truncated)
//   - priority shown only when != 'normal'
//   - workset  shown only when != 'active'
//   - agent    shown only when set
// Visibility is width-driven (measured against node.width), not CSS breakpoints.

import type { TaskGraphTask, Priority } from './taskGraphModel'

export const RAIL_GAP = 5
export const RAIL_PADX = 5
export const RAIL_CHAR_W = 5.4   // approx glyph advance at fontSize 9
export const RAIL_MIN_TITLE = 72 // px of title kept before the rail may claim space

export const PRIORITY_COLOR: Record<Priority, string> = {
  critical: 'var(--sol-red)',
  high: 'var(--sol-orange)',
  normal: 'var(--sol-muted)',
  low: 'var(--sol-base1)',
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function railItemWidth(text: string): number {
  return Math.ceil(text.length * RAIL_CHAR_W) + RAIL_PADX * 2
}

export type RailItem = { key: string; text: string; color: string; mono: boolean; width: number; x: number }

export function buildRail(task: TaskGraphTask, leftBound: number, rightBound: number): RailItem[] {
  const candidates: Omit<RailItem, 'x'>[] = []
  const idText = truncate(task.id, 16)
  candidates.push({ key: 'id', text: idText, color: 'var(--sol-base1)', mono: true, width: railItemWidth(idText) })
  if (task.priority !== 'normal') {
    candidates.push({ key: 'priority', text: task.priority, color: PRIORITY_COLOR[task.priority], mono: false, width: railItemWidth(task.priority) })
  }
  if (task.workset !== 'active') {
    candidates.push({ key: 'workset', text: task.workset, color: 'var(--sol-violet)', mono: false, width: railItemWidth(task.workset) })
  }
  if (task.agent) {
    const agentText = truncate(task.agent, 12)
    candidates.push({ key: 'agent', text: agentText, color: 'var(--sol-cyan)', mono: false, width: railItemWidth(agentText) })
  }

  // Greedily keep fields from the front (highest priority) while they fit; the
  // first field that overflows drops itself and everything lower-priority after it.
  const avail = rightBound - leftBound
  const kept: Omit<RailItem, 'x'>[] = []
  let used = 0
  for (const c of candidates) {
    const add = c.width + (kept.length ? RAIL_GAP : 0)
    if (used + add > avail) break
    used += add
    kept.push(c)
  }

  // Right-align the kept group so its last badge ends at rightBound.
  let x = rightBound - used
  return kept.map(c => {
    const item: RailItem = { ...c, x }
    x += c.width + RAIL_GAP
    return item
  })
}
