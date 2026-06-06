// Pure CPM schedule for the Pseudo-Gantt task workspace mode.
// No React dependency — independently testable.
//
// Computes an optimistic execution schedule (x = synthetic units derived from
// `estimate`) over the filter-visible leaf set, with ancestor-inherited and
// group-expanded dependencies, effective-cycle detection, forward/backward CPM
// passes, and group summary bars. See the design doc, §1.

import type { TaskGraphTask } from './taskGraphModel'

// Duration map (tunable). Missing/unknown estimate → m (3), flagged assumed.
export const DURATION: Record<string, number> = { xs: 1, s: 2, m: 3, l: 5, xl: 8 }
export const DEFAULT_DURATION = DURATION.m

export interface GanttEntry {
  start: number
  finish: number
  duration: number
  assumed: boolean
  slack: number
  critical: boolean
  cycle: boolean
  isSummary: boolean
}

export interface GanttSchedule {
  entries: Map<string, GanttEntry>
  makespan: number
}

interface ScheduleInput {
  tasks: Map<string, TaskGraphTask>
  subtreeIdsByTask: Map<string, string[]>
}

function durationOf(task: TaskGraphTask): { duration: number; assumed: boolean } {
  const est = task.estimate
  if (est && Object.hasOwn(DURATION, est)) return { duration: DURATION[est], assumed: false }
  return { duration: DEFAULT_DURATION, assumed: true }
}

const byId = (a: string, b: string) => a.localeCompare(b)

// --- Effective-predecessor graph E over the visible leaf set S ----------------

function buildEffPreds(
  S: string[],
  sSet: Set<string>,
  tasks: Map<string, TaskGraphTask>,
  subtreeIdsByTask: Map<string, string[]>,
): Map<string, Set<string>> {
  const isLeaf = (id: string) => tasks.get(id)?.hasChildren === false

  // leavesOf(d): {d} if a leaf, else the leaves of its subtree (full graph).
  const leavesCache = new Map<string, string[]>()
  function leavesOf(d: string): string[] {
    const cached = leavesCache.get(d)
    if (cached) return cached
    const task = tasks.get(d)
    const leaves = !task
      ? []
      : !task.hasChildren
        ? [d]
        : (subtreeIdsByTask.get(d) ?? [d]).filter(isLeaf)
    leavesCache.set(d, leaves)
    return leaves
  }

  function ancestors(id: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    let cur = tasks.get(id)?.parent ?? null
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      out.push(cur)
      cur = tasks.get(cur)?.parent ?? null
    }
    return out
  }

  const effPreds = new Map<string, Set<string>>()
  for (const L of S) {
    const task = tasks.get(L)!
    // rawPreds(L) = L.depends ∪ ⋃ ancestor.depends
    const rawPreds = new Set<string>(task.depends)
    for (const a of ancestors(L)) {
      for (const dep of tasks.get(a)?.depends ?? []) rawPreds.add(dep)
    }
    // effPreds(L) = (⋃ leavesOf(d)) ∩ S \ {L}
    const preds = new Set<string>()
    for (const d of rawPreds) {
      for (const leaf of leavesOf(d)) {
        if (leaf !== L && sSet.has(leaf)) preds.add(leaf)
      }
    }
    effPreds.set(L, preds)
  }
  return effPreds
}

// --- Kahn topo over E; nodes never emitted are in an effective cycle ----------

function topoOverE(
  S: string[],
  effPreds: Map<string, Set<string>>,
): { order: string[]; cycleNodes: Set<string> } {
  const inDegree = new Map<string, number>()
  const successors = new Map<string, string[]>()
  for (const id of S) {
    inDegree.set(id, 0)
    successors.set(id, [])
  }
  for (const L of S) {
    for (const p of effPreds.get(L)!) {
      successors.get(p)!.push(L)
      inDegree.set(L, inDegree.get(L)! + 1)
    }
  }

  const queue = S.filter(id => inDegree.get(id) === 0).sort(byId)
  const order: string[] = []
  while (queue.length) {
    const node = queue.shift()!
    order.push(node)
    for (const next of successors.get(node)!) {
      const deg = inDegree.get(next)! - 1
      inDegree.set(next, deg)
      if (deg === 0) {
        const idx = queue.findIndex(q => byId(next, q) < 0)
        queue.splice(idx === -1 ? queue.length : idx, 0, next)
      }
    }
  }

  const emitted = new Set(order)
  const cycleNodes = new Set(S.filter(id => !emitted.has(id)))
  // Append cycle nodes (deterministic) so every node is scheduled; back-edges
  // into not-yet-scheduled cycle nodes are ignored by the forward pass below.
  return { order: [...order, ...[...cycleNodes].sort(byId)], cycleNodes }
}

export function computeGanttSchedule(
  input: ScheduleInput,
  visibleSet: Set<string>,
): GanttSchedule {
  const { tasks, subtreeIdsByTask } = input
  const entries = new Map<string, GanttEntry>()

  // S = filter-visible leaves.
  const S = [...visibleSet].filter(id => tasks.get(id)?.hasChildren === false)
  if (S.length === 0) return { entries, makespan: 0 }
  const sSet = new Set(S)

  const effPreds = buildEffPreds(S, sSet, tasks, subtreeIdsByTask)
  const { order, cycleNodes } = topoOverE(S, effPreds)

  const duration = new Map<string, number>()
  const assumed = new Map<string, boolean>()
  for (const L of S) {
    const d = durationOf(tasks.get(L)!)
    duration.set(L, d.duration)
    assumed.set(L, d.assumed)
  }

  // Forward pass — earliest start in topo order.
  const start = new Map<string, number>()
  const finish = new Map<string, number>()
  let makespan = 0
  for (const L of order) {
    let s = 0
    for (const p of effPreds.get(L)!) {
      const pf = finish.get(p)
      if (pf !== undefined) s = Math.max(s, pf)
    }
    const f = s + duration.get(L)!
    start.set(L, s)
    finish.set(L, f)
    makespan = Math.max(makespan, f)
  }

  // effSuccs(L) = { t : L ∈ effPreds(t) }
  const effSuccs = new Map<string, Set<string>>()
  for (const L of S) effSuccs.set(L, new Set())
  for (const L of S) {
    for (const p of effPreds.get(L)!) effSuccs.get(p)!.add(L)
  }

  // Backward pass — latest finish in reverse topo order.
  const slack = new Map<string, number>()
  const latestStart = new Map<string, number>()
  for (let i = order.length - 1; i >= 0; i--) {
    const L = order[i]
    let lf = makespan
    let hasSucc = false
    for (const t of effSuccs.get(L)!) {
      const ls = latestStart.get(t)
      if (ls === undefined) continue // back-edge into a not-yet-processed cycle node
      lf = hasSucc ? Math.min(lf, ls) : ls
      hasSucc = true
    }
    const ls = lf - duration.get(L)!
    latestStart.set(L, ls)
    slack.set(L, ls - start.get(L)!)
  }

  // Leaf entries.
  for (const L of S) {
    const isCycle = cycleNodes.has(L)
    const sl = slack.get(L)!
    entries.set(L, {
      start: start.get(L)!,
      finish: finish.get(L)!,
      duration: duration.get(L)!,
      assumed: assumed.get(L)!,
      slack: sl,
      critical: !isCycle && sl === 0,
      cycle: isCycle,
      isSummary: false,
    })
  }

  // Group summaries — over each visible group's scheduled visible descendant leaves.
  for (const id of visibleSet) {
    const task = tasks.get(id)
    if (!task?.hasChildren) continue
    const leaves = (subtreeIdsByTask.get(id) ?? []).filter(x => sSet.has(x))
    if (leaves.length === 0) continue // no scheduled visible leaves → no bar

    let gStart = Infinity
    let gFinish = 0
    let gSlack = Infinity
    let gCritical = false
    let gCycle = false
    for (const leaf of leaves) {
      const e = entries.get(leaf)!
      gStart = Math.min(gStart, e.start)
      gFinish = Math.max(gFinish, e.finish)
      gSlack = Math.min(gSlack, e.slack)
      gCritical = gCritical || e.critical
      gCycle = gCycle || e.cycle
    }
    entries.set(id, {
      start: gStart,
      finish: gFinish,
      duration: gFinish - gStart,
      assumed: false,
      slack: gSlack,
      critical: gCritical,
      cycle: gCycle,
      isSummary: true,
    })
  }

  return { entries, makespan }
}
