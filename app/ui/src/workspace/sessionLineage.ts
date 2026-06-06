import type { AgentSession } from '../types'

export interface SessionLineageRow {
  session: AgentSession
  depth: number
}

/**
 * Flatten an ordered session list into a depth-annotated lineage list.
 *
 * Rules (see design § Terminal Session Cascade):
 * - A session is a root when it has no `parentSession`, or its parent is not
 *   present in this list (e.g. filtered out, or in another render bucket).
 * - Each parent is immediately followed by its visible descendants, depth-first.
 * - Input order is preserved: roots in input order, and children under a parent
 *   in their input order within the sibling set.
 * - Cycles are broken with a visited set; any session not reachable from a root
 *   (a pure cycle) is rendered as a root so nothing is dropped or loops forever.
 *
 * Pure and order-stable so it can be applied per render bucket and unit-tested.
 */
export function buildSessionLineage(sessions: AgentSession[]): SessionLineageRow[] {
  const present = new Set(sessions.map(s => s.name))
  const childrenByParent = new Map<string, AgentSession[]>()
  for (const s of sessions) {
    const parent = s.parentSession
    if (parent && parent !== s.name && present.has(parent)) {
      const siblings = childrenByParent.get(parent) ?? []
      siblings.push(s)
      childrenByParent.set(parent, siblings)
    }
  }

  const rows: SessionLineageRow[] = []
  const visited = new Set<string>()

  const walk = (session: AgentSession, depth: number): void => {
    if (visited.has(session.name)) return
    visited.add(session.name)
    rows.push({ session, depth })
    for (const child of childrenByParent.get(session.name) ?? []) {
      walk(child, depth + 1)
    }
  }

  const isRoot = (s: AgentSession): boolean => {
    const parent = s.parentSession
    return !parent || parent === s.name || !present.has(parent)
  }

  for (const s of sessions) {
    if (isRoot(s)) walk(s, 0)
  }
  // Cycle fallback: sessions only reachable through a cycle never matched a root.
  for (const s of sessions) {
    walk(s, 0)
  }

  return rows
}

export interface SessionLineageBuckets {
  pinned: SessionLineageRow[]
  processing: SessionLineageRow[]
  idle: SessionLineageRow[]
}

/**
 * Build lineage over the whole visible list, then assign each root-anchored
 * subtree to the existing pinned/active/idle render bucket by its ROOT's
 * pin/status. A parent and all of its visible descendants stay contiguous in
 * one bucket even when a child's status or pin state differs — so a processing
 * child of an idle parent renders indented under that parent, not split off as
 * a stray root. Order within each bucket follows the input order.
 */
export function groupSessionLineage(
  sessions: AgentSession[],
  isPinned: (name: string) => boolean,
): SessionLineageBuckets {
  const buckets: SessionLineageBuckets = { pinned: [], processing: [], idle: [] }
  let current = buckets.idle
  for (const row of buildSessionLineage(sessions)) {
    if (row.depth === 0) {
      const root = row.session
      current = isPinned(root.name)
        ? buckets.pinned
        : root.status === 'idle'
          ? buckets.idle
          : buckets.processing
    }
    current.push(row)
  }
  return buckets
}
