import type { AgentSession } from '../types'

export interface SessionLineageRow {
  session: AgentSession
  depth: number
  hasChildren: boolean
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
    rows.push({ session, depth, hasChildren: childrenByParent.has(session.name) })
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

/**
 * Collect a session and every descendant by name, walking the `parentSession`
 * links of the given list. Returns `[]` when the name is not present.
 *
 * Used by the "Mark subtree read" action to fan an ack out over a parent plus
 * its whole subtree. Cycle-guarded with a visited set so a malformed
 * parent loop terminates. Pure and order-stable (parent first, then children
 * in input order) so it can be unit-tested independently of the manager.
 */
export function collectSubtree(sessions: AgentSession[], rootName: string): string[] {
  const childrenByParent = new Map<string, AgentSession[]>()
  for (const s of sessions) {
    const parent = s.parentSession
    if (parent && parent !== s.name) {
      const siblings = childrenByParent.get(parent) ?? []
      siblings.push(s)
      childrenByParent.set(parent, siblings)
    }
  }

  if (!sessions.some(s => s.name === rootName)) return []

  const collected: string[] = []
  const visited = new Set<string>()
  const walk = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    collected.push(name)
    for (const child of childrenByParent.get(name) ?? []) walk(child.name)
  }
  walk(rootName)
  return collected
}

/**
 * Drop the descendants of any collapsed session, keeping the collapsed parent
 * itself visible. Relies on lineage order: rows are depth-first and a subtree is
 * contiguous, so a single depth threshold tracks "inside a collapsed ancestor".
 * Pure and bucket-safe — apply per render bucket (each holds whole subtrees).
 */
export function filterCollapsedRows(
  rows: SessionLineageRow[],
  collapsed: Set<string>,
): SessionLineageRow[] {
  const out: SessionLineageRow[] = []
  let hiddenBelow = Infinity // hide rows deeper than the nearest collapsed ancestor
  for (const row of rows) {
    if (row.depth > hiddenBelow) continue
    hiddenBelow = collapsed.has(row.session.name) ? row.depth : Infinity
    out.push(row)
  }
  return out
}

export interface SessionLineageBuckets {
  pinned: SessionLineageRow[]
  processing: SessionLineageRow[]
  idle: SessionLineageRow[]
}

/**
 * Build lineage over the whole visible list, then assign each root-anchored
 * subtree to the pinned/active/idle render bucket. A parent and all of its
 * visible descendants stay contiguous in one bucket.
 *
 * Bucket key is a SUBTREE-MAX priority `blocked > processing > idle`: a subtree
 * goes to the active bucket if *any* member is blocked or processing, so a
 * blocked/processing child under an idle parent isn't buried in the idle
 * bucket. Within the active bucket, subtrees rooted at a `blocked` session sort
 * to the top (they need the user). Pinned roots still take precedence over
 * status. Order is otherwise input order.
 */
export function groupSessionLineage(
  sessions: AgentSession[],
  isPinned: (name: string) => boolean,
): SessionLineageBuckets {
  const buckets: SessionLineageBuckets = { pinned: [], processing: [], idle: [] }

  // Split the flat lineage into root-anchored subtrees (each depth-0 row opens one).
  const subtrees: SessionLineageRow[][] = []
  for (const row of buildSessionLineage(sessions)) {
    if (row.depth === 0) subtrees.push([])
    subtrees[subtrees.length - 1].push(row)
  }

  // idle < processing/starting < blocked
  const priority = (s: AgentSession): number =>
    s.status === 'blocked' ? 2 : s.status === 'idle' ? 0 : 1

  const activeBlocked: SessionLineageRow[] = []
  const activeRest: SessionLineageRow[] = []
  for (const subtree of subtrees) {
    const root = subtree[0].session
    if (isPinned(root.name)) {
      buckets.pinned.push(...subtree)
    } else if (Math.max(...subtree.map(r => priority(r.session))) === 0) {
      buckets.idle.push(...subtree)
    } else if (root.status === 'blocked') {
      activeBlocked.push(...subtree)
    } else {
      activeRest.push(...subtree)
    }
  }
  buckets.processing.push(...activeBlocked, ...activeRest)
  return buckets
}
