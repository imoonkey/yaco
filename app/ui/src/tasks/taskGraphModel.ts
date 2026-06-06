// Pure-function graph model: normalize, layout, edge paths
// No React dependency — independently testable

import { PX_PER_UNIT, LEFT_COL_PAD, MIN_BAR } from './taskGraphConstants'
import { computeGanttSchedule } from './ganttSchedule'

export type TaskState = 'ready' | 'running' | 'done' | 'blocked' | 'cancelled'

export type Priority = 'critical' | 'high' | 'normal' | 'low'

export type RawTaskEntry = {
  title: string
  description?: string
  parent: string | null
  depends: string[]
  state: TaskState
  scope?: string[]
  acceptCriteria?: string | string[]
  note?: string | null
  worktree?: string | null
  estimate?: string | null
  workset?: 'active' | 'backlog' | 'archive'
  priority?: Priority
  agent?: string | null
  tags?: string[]
}

export type RawTaskMap = Record<string, RawTaskEntry>

export type TaskGraphTask = {
  id: string
  title: string
  description: string | null
  parent: string | null
  depends: string[]
  state: TaskState
  scope: string[]
  acceptCriteria: string[]
  note: string | null
  depth: number
  hasChildren: boolean
  worktree: string | null
  estimate: string | null
  workset: 'active' | 'backlog' | 'archive'
  priority: Priority
  agent: string | null
  tags: string[]
}

// Layout types — flat indented tree, no nested boxes

export interface LayoutGroup {
  id: string
  guideX: number        // x of vertical guide line
  guideY1: number       // top of guide (bottom of parent card)
  guideY2: number       // bottom of guide (center of last child)
  depth: number
  childIds: string[]
  aggregateState: TaskState
  progress: { done: number; total: number }
}

export interface LayoutNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  parentId: string | null
  hasChildren: boolean
  depth: number
}

export interface LayoutEdge {
  id: string
  sourceId: string
  targetId: string
  path: string
  isCycle: boolean
  isSameLane: boolean
  count: number
  originalEdgeIds?: string[]
}

export interface GraphLayout {
  groups: LayoutGroup[]
  nodes: Map<string, LayoutNode>
  edges: LayoutEdge[]
  visibleOrder: string[]
  visibleChildrenByTask: Map<string, string[]>
  bounds: { width: number; height: number }
  hasCycles: boolean
}

// Pseudo-Gantt layout — extends GraphLayout so selection/keyboard/search/collapse
// keep working unchanged, and adds the time-pane bars + ruler + column widths.

export interface GanttBar {
  x: number
  width: number
  y: number
  state: TaskState
  assumed: boolean
  critical: boolean
  cycle: boolean
  isSummary: boolean
}

export interface GanttLayout extends GraphLayout {
  bars: Map<string, GanttBar>
  ruler: { ticks: { x: number; label: string }[] }
  leftWidth: number
  timeWidth: number
}

export interface TaskGraphModel {
  tasks: Map<string, TaskGraphTask>
  layout: GraphLayout
  dependenciesByTask: Map<string, string[]>
  dependentsByTask: Map<string, string[]>
  childIdsByTask: Map<string, string[]>
  rootIds: string[]
  subtreeIdsByTask: Map<string, string[]>
  aggregateStateByTask: Map<string, TaskState>
  leafProgressByTask: Map<string, { done: number; total: number }>
  cycleEdgeIds: Set<string>
}

// Constants — flat indented tree layout

export const NODE_WIDTH = 280   // minimum card width floor (stacked rows are width-driven)
export const NODE_HEIGHT = 36
export const NODE_GAP = 6
export const INDENT = 24
export const ROOT_GAP = 28       // vertical gap between stacked root sections
export const GRAPH_PADDING = 12
export const DEPENDS_GUTTER = 32 // reserved right-side gutter for dependency arcs
export const ARC_OFFSET = 18

// State priority for sorting
const STATE_PRIORITY: Record<TaskState, number> = {
  blocked: 0,
  ready: 1,
  running: 2,
  done: 3,
  cancelled: 4,
}

// --- Normalization ---

function parseAcceptCriteria(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  return raw
    .split('\n')
    .map(line => line.replace(/^[-\s]*[☐☑]\s*/, '').replace(/^-\s*/, '').trim())
    .filter(Boolean)
}

function getDepth(id: string, raw: RawTaskMap): number {
  let depth = 0
  let current = id
  const visited = new Set<string>()
  while (raw[current]?.parent && raw[raw[current].parent!]) {
    if (visited.has(current)) break
    visited.add(current)
    current = raw[current].parent!
    depth++
  }
  return depth
}

export function normalizeTasks(raw: RawTaskMap): { tasks: Map<string, TaskGraphTask>; warnings: string[] } {
  const warnings: string[] = []
  const ids = new Set(Object.keys(raw))

  // Determine which IDs have children
  const childrenOf = new Set<string>()
  for (const entry of Object.values(raw)) {
    if (entry.parent && ids.has(entry.parent)) childrenOf.add(entry.parent)
  }

  const tasks = new Map<string, TaskGraphTask>()
  for (const [id, entry] of Object.entries(raw)) {
    const validDeps = entry.depends.filter(dep => {
      if (!ids.has(dep)) {
        warnings.push(`Task "${id}" depends on unknown task "${dep}"`)
        return false
      }
      return true
    })

    if (entry.parent && !ids.has(entry.parent)) {
      warnings.push(`Task "${id}" has unknown parent "${entry.parent}"`)
    }

    tasks.set(id, {
      id,
      title: entry.title,
      description: entry.description ?? null,
      parent: entry.parent && ids.has(entry.parent) ? entry.parent : null,
      depends: validDeps,
      state: entry.state,
      scope: entry.scope ?? [],
      acceptCriteria: parseAcceptCriteria(entry.acceptCriteria),
      note: entry.note ?? null,
      depth: getDepth(id, raw),
      hasChildren: childrenOf.has(id),
      worktree: entry.worktree ?? null,
      estimate: entry.estimate ?? null,
      workset: entry.workset ?? 'active',
      priority: entry.priority ?? 'normal',
      agent: entry.agent ?? null,
      tags: entry.tags ?? [],
    })
  }

  return { tasks, warnings }
}

// --- Forest building ---

function buildForest(tasks: Map<string, TaskGraphTask>): {
  childIdsByTask: Map<string, string[]>
  rootIds: string[]
} {
  const childIdsByTask = new Map<string, string[]>()
  const rootIds: string[] = []

  for (const [id, task] of tasks) {
    if (!task.parent) {
      rootIds.push(id)
    } else {
      if (!childIdsByTask.has(task.parent)) childIdsByTask.set(task.parent, [])
      childIdsByTask.get(task.parent)!.push(id)
    }
  }

  return { childIdsByTask, rootIds }
}

// --- Subtree metadata (post-order traversal) ---

function computeSubtreeMetadata(
  tasks: Map<string, TaskGraphTask>,
  childIdsByTask: Map<string, string[]>,
  rootIds: string[],
): {
  subtreeIdsByTask: Map<string, string[]>
  aggregateStateByTask: Map<string, TaskState>
  leafProgressByTask: Map<string, { done: number; total: number }>
} {
  const subtreeIdsByTask = new Map<string, string[]>()
  const aggregateStateByTask = new Map<string, TaskState>()
  const leafProgressByTask = new Map<string, { done: number; total: number }>()

  function visit(id: string): void {
    const children = childIdsByTask.get(id) ?? []
    const subtreeIds: string[] = [id]

    for (const childId of children) {
      visit(childId)
      subtreeIds.push(...(subtreeIdsByTask.get(childId) ?? [childId]))
    }
    subtreeIdsByTask.set(id, subtreeIds)

    if (children.length === 0) {
      // Leaf
      const task = tasks.get(id)!
      aggregateStateByTask.set(id, task.state)
      leafProgressByTask.set(id, { done: task.state === 'done' ? 1 : 0, total: 1 })
    } else {
      // Group: aggregate from children
      let done = 0, total = 0
      const childStates: TaskState[] = []
      for (const childId of children) {
        const cp = leafProgressByTask.get(childId) ?? { done: 0, total: 0 }
        done += cp.done
        total += cp.total
        childStates.push(aggregateStateByTask.get(childId) ?? 'cancelled')
      }
      leafProgressByTask.set(id, { done, total })
      aggregateStateByTask.set(id, computeAggregateState(childStates))
    }
  }

  for (const rootId of rootIds) visit(rootId)

  return { subtreeIdsByTask, aggregateStateByTask, leafProgressByTask }
}

function computeAggregateState(states: TaskState[]): TaskState {
  if (states.every(s => s === 'done')) return 'done'
  if (states.some(s => s === 'running')) return 'running'
  if (states.some(s => s === 'blocked')) return 'blocked'
  if (states.some(s => s === 'ready')) return 'ready'
  return 'cancelled'
}

// --- Topological sort ---

function topoSort(
  nodeIds: string[],
  edges: [string, string][],
  tieBreak: (a: string, b: string) => number,
): { sorted: string[]; hasCycle: boolean; cycleNodes: Set<string> } {
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  for (const id of nodeIds) {
    inDegree.set(id, 0)
    adjacency.set(id, [])
  }
  for (const [from, to] of edges) {
    if (!inDegree.has(from) || !inDegree.has(to)) continue
    adjacency.get(from)!.push(to)
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1)
  }

  const queue = nodeIds.filter(id => inDegree.get(id) === 0).sort(tieBreak)
  const sorted: string[] = []

  while (queue.length) {
    const node = queue.shift()!
    sorted.push(node)
    for (const neighbor of adjacency.get(node) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, deg)
      if (deg === 0) {
        const idx = queue.findIndex(q => tieBreak(neighbor, q) < 0)
        queue.splice(idx === -1 ? queue.length : idx, 0, neighbor)
      }
    }
  }

  const sortedSet = new Set(sorted)
  const cycleNodes = new Set(nodeIds.filter(id => !sortedSet.has(id)))
  return { sorted: [...sorted, ...Array.from(cycleNodes).sort(tieBreak)], hasCycle: cycleNodes.size > 0, cycleNodes }
}

// --- Sibling ordering ---

function orderSiblings(
  siblingIds: string[],
  tasks: Map<string, TaskGraphTask>,
  subtreeIdsByTask: Map<string, string[]>,
  aggregateStateByTask: Map<string, TaskState>,
): string[] {
  // Build reverse lookup: task id → owning sibling id
  const taskToSibling = new Map<string, string>()
  for (const sibId of siblingIds) {
    const subtree = subtreeIdsByTask.get(sibId) ?? [sibId]
    for (const tid of subtree) taskToSibling.set(tid, sibId)
  }

  // Build cross-subtree dependency edges for ordering
  const edges: [string, string][] = []
  const edgeSet = new Set<string>()

  for (const sibId of siblingIds) {
    const subtree = subtreeIdsByTask.get(sibId) ?? [sibId]
    for (const tid of subtree) {
      const task = tasks.get(tid)
      if (!task) continue
      for (const dep of task.depends) {
        const depSibId = taskToSibling.get(dep)
        if (depSibId && depSibId !== sibId) {
          const key = `${depSibId}->${sibId}`
          if (!edgeSet.has(key)) {
            edgeSet.add(key)
            edges.push([depSibId, sibId])
          }
        }
      }
    }
  }

  const { sorted } = topoSort(siblingIds, edges, (a, b) => {
    // Group before leaf
    const aHas = tasks.get(a)?.hasChildren ? 0 : 1
    const bHas = tasks.get(b)?.hasChildren ? 0 : 1
    if (aHas !== bHas) return aHas - bHas
    // Aggregate state priority
    const aState = aggregateStateByTask.get(a) ?? 'cancelled'
    const bState = aggregateStateByTask.get(b) ?? 'cancelled'
    const sp = STATE_PRIORITY[aState] - STATE_PRIORITY[bState]
    if (sp !== 0) return sp
    // Title
    const tp = (tasks.get(a)?.title ?? a).localeCompare(tasks.get(b)?.title ?? b)
    if (tp !== 0) return tp
    // ID fallback
    return a.localeCompare(b)
  })

  return sorted
}

// --- SCC cycle detection (Tarjan's) ---

function findSCCCycleEdges(
  tasks: Map<string, TaskGraphTask>,
): Set<string> {
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let idx = 0
  const sccs: string[][] = []

  function strongConnect(v: string) {
    index.set(v, idx)
    lowlink.set(v, idx)
    idx++
    stack.push(v)
    onStack.add(v)

    const task = tasks.get(v)
    if (task) {
      for (const w of task.depends) {
        if (!tasks.has(w)) continue
        if (!index.has(w)) {
          strongConnect(w)
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!))
        }
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
      } while (w !== v)
      if (scc.length > 1) sccs.push(scc)
    }
  }

  for (const id of tasks.keys()) {
    if (!index.has(id)) strongConnect(id)
  }

  // Mark edges whose both endpoints are in the same SCC
  const taskToSCC = new Map<string, number>()
  for (let i = 0; i < sccs.length; i++) {
    for (const id of sccs[i]) taskToSCC.set(id, i)
  }

  const cycleEdgeIds = new Set<string>()
  for (const [tid, task] of tasks) {
    for (const dep of task.depends) {
      const tidSCC = taskToSCC.get(tid)
      const depSCC = taskToSCC.get(dep)
      if (tidSCC !== undefined && tidSCC === depSCC) {
        cycleEdgeIds.add(`${dep}->${tid}`)
      }
    }
  }

  return cycleEdgeIds
}

// --- Display layout ---

interface MeasuredItem {
  id: string
  height: number
  isGroup: boolean
  children: MeasuredItem[]
}

function measureTree(
  id: string,
  tasks: Map<string, TaskGraphTask>,
  childIdsByTask: Map<string, string[]>,
  subtreeIdsByTask: Map<string, string[]>,
  aggregateStateByTask: Map<string, TaskState>,
  collapsedTaskIds: Set<string>,
  visibleFilter: Set<string>,
): MeasuredItem | null {
  if (!visibleFilter.has(id)) return null

  const task = tasks.get(id)
  if (!task) return null

  const isCollapsed = collapsedTaskIds.has(id) && task.hasChildren
  const rawChildren = childIdsByTask.get(id) ?? []

  // Leaf or collapsed group — just the card
  if (rawChildren.length === 0 || isCollapsed) {
    return { id, height: NODE_HEIGHT, isGroup: task.hasChildren, children: [] }
  }

  // Expanded group: order and measure children
  const visibleChildIds = orderSiblings(
    rawChildren.filter(cid => visibleFilter.has(cid)),
    tasks,
    subtreeIdsByTask,
    aggregateStateByTask,
  )

  const measuredChildren: MeasuredItem[] = []
  for (const cid of visibleChildIds) {
    const child = measureTree(cid, tasks, childIdsByTask, subtreeIdsByTask, aggregateStateByTask, collapsedTaskIds, visibleFilter)
    if (child) measuredChildren.push(child)
  }

  if (measuredChildren.length === 0) {
    return { id, height: NODE_HEIGHT, isGroup: true, children: [] }
  }

  const childrenHeight = measuredChildren.reduce((sum, c) => sum + c.height, 0) +
    (measuredChildren.length - 1) * NODE_GAP
  const height = NODE_HEIGHT + NODE_GAP + childrenHeight

  return { id, height, isGroup: true, children: measuredChildren }
}

function positionTree(
  item: MeasuredItem,
  x: number,
  y: number,
  depth: number,
  rightEdge: number,
  tasks: Map<string, TaskGraphTask>,
  aggregateStateByTask: Map<string, TaskState>,
  leafProgressByTask: Map<string, { done: number; total: number }>,
  collapsedTaskIds: Set<string>,
  outGroups: LayoutGroup[],
  outNodes: Map<string, LayoutNode>,
  outVisibleOrder: string[],
  outVisibleChildren: Map<string, string[]>,
): number {
  // returns the y of the last positioned node (for guide line end)
  const task = tasks.get(item.id)
  if (!task) return y

  outVisibleOrder.push(item.id)

  // Every task is a card at (x, y); width fills to the shared right edge (indentation-driven)
  outNodes.set(item.id, {
    id: item.id,
    x,
    y,
    width: Math.max(NODE_WIDTH, rightEdge - x),
    height: NODE_HEIGHT,
    parentId: task.parent,
    hasChildren: task.hasChildren,
    depth,
  })

  if (item.children.length > 0) {
    // Expanded group — position children below, indented
    outVisibleChildren.set(item.id, item.children.map(c => c.id))

    let childY = y + NODE_HEIGHT + NODE_GAP
    let lastChildEndY = childY
    for (const child of item.children) {
      lastChildEndY = positionTree(child, x + INDENT, childY, depth + 1, rightEdge, tasks, aggregateStateByTask, leafProgressByTask, collapsedTaskIds, outGroups, outNodes, outVisibleOrder, outVisibleChildren)
      childY = lastChildEndY + NODE_GAP
    }

    // Emit guide line from bottom of parent card to center of last child
    const lastChildNode = outNodes.get(item.children[item.children.length - 1].id)
    outGroups.push({
      id: item.id,
      guideX: x + 8,  // align with chevron center
      guideY1: y + NODE_HEIGHT,
      guideY2: lastChildNode ? lastChildNode.y + NODE_HEIGHT / 2 : y + NODE_HEIGHT,
      depth,
      childIds: item.children.map(c => c.id),
      aggregateState: aggregateStateByTask.get(item.id) ?? 'cancelled',
      progress: leafProgressByTask.get(item.id) ?? { done: 0, total: 0 },
    })

    return lastChildEndY
  }

  // Leaf or collapsed group — emit group data without guide line
  if (task.hasChildren) {
    outGroups.push({
      id: item.id,
      guideX: x + 8,
      guideY1: y + NODE_HEIGHT,
      guideY2: y + NODE_HEIGHT,  // zero-length (collapsed)
      depth,
      childIds: [],
      aggregateState: aggregateStateByTask.get(item.id) ?? 'cancelled',
      progress: leafProgressByTask.get(item.id) ?? { done: 0, total: 0 },
    })
  }

  return y + NODE_HEIGHT
}

// Compute visible task set considering filters and collapse
function computeVisibleSet(
  tasks: Map<string, TaskGraphTask>,
  childIdsByTask: Map<string, string[]>,
  rootIds: string[],
  collapsedTaskIds: Set<string>,
  filters: Set<TaskState>,
): Set<string> {
  const visible = new Set<string>()

  function visit(id: string, ancestorCollapsed: boolean): boolean {
    const task = tasks.get(id)
    if (!task) return false

    if (ancestorCollapsed) return false

    const children = childIdsByTask.get(id) ?? []
    const isCollapsed = collapsedTaskIds.has(id) && task.hasChildren
    const passesFilter = filters.has(task.state)

    let hasVisibleDescendant = false
    if (!isCollapsed) {
      for (const childId of children) {
        if (visit(childId, false)) hasVisibleDescendant = true
      }
    }

    if (passesFilter || hasVisibleDescendant) {
      visible.add(id)
      return true
    }

    return false
  }

  for (const rootId of rootIds) visit(rootId, false)
  return visible
}

// Edge path computation — endpoints anchor at each card's own right edge, but every
// real `depends` arc bows past a single global right edge so it clears intervening
// cards (deep rows can overflow the shared edge under the NODE_WIDTH floor).
function computeEdgePath(
  source: LayoutNode,
  target: LayoutNode,
  baseline: number,
  gutter: number,
): string {
  const sx = source.x + source.width
  const sy = source.y + NODE_HEIGHT / 2
  const tx = target.x + target.width
  const ty = target.y + NODE_HEIGHT / 2
  // Bow further out for longer vertical spans so neighbouring arcs separate, capped to the gutter.
  const vertDist = Math.abs(ty - sy)
  const cpx = baseline + Math.min(gutter - 8, ARC_OFFSET + vertDist * 0.08)
  return `M ${sx},${sy} C ${cpx},${sy} ${cpx},${ty} ${tx},${ty}`
}

// Shared row layout — the measureTree + positionTree core used by BOTH the stacked
// and the Pseudo-Gantt modes. Positions every visible card at its indented (x, y);
// callers stretch widths / build edges on top. No tree algorithm is duplicated.
interface RowLayout {
  nodes: Map<string, LayoutNode>
  groups: LayoutGroup[]
  visibleOrder: string[]
  visibleChildrenByTask: Map<string, string[]>
  totalHeight: number
  maxVisibleDepth: number
}

function layoutRows(
  model: {
    tasks: Map<string, TaskGraphTask>
    childIdsByTask: Map<string, string[]>
    rootIds: string[]
    subtreeIdsByTask: Map<string, string[]>
  },
  viewState: {
    collapsedTaskIds: Set<string>
    filters: Set<TaskState>
  },
  aggregateStateByTask: Map<string, TaskState>,
  leafProgressByTask: Map<string, { done: number; total: number }>,
  rightEdge: number,
): RowLayout {
  const { tasks, childIdsByTask, rootIds, subtreeIdsByTask } = model
  const { collapsedTaskIds, filters } = viewState

  const groups: LayoutGroup[] = []
  const nodes = new Map<string, LayoutNode>()
  const visibleOrder: string[] = []
  const visibleChildrenByTask = new Map<string, string[]>()

  const visibleSet = computeVisibleSet(tasks, childIdsByTask, rootIds, collapsedTaskIds, filters)
  if (visibleSet.size === 0) {
    return { nodes, groups, visibleOrder, visibleChildrenByTask, totalHeight: 0, maxVisibleDepth: 0 }
  }

  // Order root-level items, then measure + position each root tree stacked vertically.
  const visibleRoots = rootIds.filter(id => visibleSet.has(id))
  const orderedRoots = orderSiblings(visibleRoots, tasks, subtreeIdsByTask, aggregateStateByTask)

  const measuredRoots: MeasuredItem[] = []
  for (const rootId of orderedRoots) {
    const measured = measureTree(rootId, tasks, childIdsByTask, subtreeIdsByTask, aggregateStateByTask, collapsedTaskIds, visibleSet)
    if (measured) measuredRoots.push(measured)
  }

  let rootY = GRAPH_PADDING
  for (const root of measuredRoots) {
    const endY = positionTree(root, GRAPH_PADDING, rootY, 0, rightEdge, tasks, aggregateStateByTask, leafProgressByTask, collapsedTaskIds, groups, nodes, visibleOrder, visibleChildrenByTask)
    rootY = endY + ROOT_GAP
  }

  let maxY = 0
  let maxVisibleDepth = 0
  for (const node of nodes.values()) {
    maxY = Math.max(maxY, node.y + node.height)
    maxVisibleDepth = Math.max(maxVisibleDepth, node.depth)
  }

  return {
    nodes,
    groups,
    visibleOrder,
    visibleChildrenByTask,
    totalHeight: maxY + GRAPH_PADDING,
    maxVisibleDepth,
  }
}

export function computeDisplayLayout(
  model: {
    tasks: Map<string, TaskGraphTask>
    childIdsByTask: Map<string, string[]>
    rootIds: string[]
    subtreeIdsByTask: Map<string, string[]>
    dependenciesByTask: Map<string, string[]>
  },
  viewState: {
    collapsedTaskIds: Set<string>
    filters: Set<TaskState>
  },
  aggregateStateByTask: Map<string, TaskState>,
  leafProgressByTask: Map<string, { done: number; total: number }>,
  cycleEdgeIds: Set<string>,
  containerWidth = 0,
): GraphLayout {
  const { tasks } = model

  // Stacked rows fill the container width; reserve the right gutter for dependency arcs.
  const rightEdge = Math.max(
    GRAPH_PADDING + NODE_WIDTH,
    containerWidth - GRAPH_PADDING - DEPENDS_GUTTER,
  )

  const { nodes, groups, visibleOrder, visibleChildrenByTask, totalHeight } = layoutRows(
    model, viewState, aggregateStateByTask, leafProgressByTask, rightEdge,
  )

  if (nodes.size === 0) {
    return { groups: [], nodes: new Map(), edges: [], visibleOrder: [], visibleChildrenByTask: new Map(), bounds: { width: 0, height: 0 }, hasCycles: cycleEdgeIds.size > 0 }
  }

  // Single global right edge across all visible cards. Under the NODE_WIDTH floor a deep
  // row can overflow `rightEdge`, so the bow baseline must be the true max, not `rightEdge`.
  let globalRight = rightEdge
  for (const node of nodes.values()) {
    globalRight = Math.max(globalRight, node.x + node.width)
  }

  // Compute edges
  const edges: LayoutEdge[] = []
  const edgeGroups = new Map<string, { edges: { id: string; isCycle: boolean }[]; sourceId: string; targetId: string }>()

  for (const [tid, task] of tasks) {
    for (const dep of task.depends) {
      // Resolve to visible anchors
      const sourceAnchor = resolveVisibleAnchor(dep, nodes, tasks)
      const targetAnchor = resolveVisibleAnchor(tid, nodes, tasks)
      if (!sourceAnchor || !targetAnchor || sourceAnchor === targetAnchor) continue

      const key = `${sourceAnchor}->${targetAnchor}`
      const edgeId = `${dep}->${tid}`
      const isCycle = cycleEdgeIds.has(edgeId)

      if (!edgeGroups.has(key)) {
        edgeGroups.set(key, { edges: [], sourceId: sourceAnchor, targetId: targetAnchor })
      }
      edgeGroups.get(key)!.edges.push({ id: edgeId, isCycle })
    }
  }

  for (const [edgeKey, group] of edgeGroups) {
    const sourceNode = nodes.get(group.sourceId)
    const targetNode = nodes.get(group.targetId)
    if (!sourceNode || !targetNode) continue

    const path = computeEdgePath(sourceNode, targetNode, globalRight, DEPENDS_GUTTER)
    const hasCycle = group.edges.some(e => e.isCycle)

    edges.push({
      id: edgeKey,
      sourceId: group.sourceId,
      targetId: group.targetId,
      path,
      isCycle: hasCycle,
      isSameLane: false,
      count: group.edges.length,
      originalEdgeIds: group.edges.length > 1 ? group.edges.map(e => e.id) : undefined,
    })
  }

  return {
    groups,
    nodes,
    edges,
    visibleOrder,
    visibleChildrenByTask,
    bounds: { width: Math.max(containerWidth, globalRight + DEPENDS_GUTTER + GRAPH_PADDING), height: totalHeight },
    hasCycles: cycleEdgeIds.size > 0,
  }
}

// --- Pseudo-Gantt layout ---

export function computeGanttLayout(
  model: {
    tasks: Map<string, TaskGraphTask>
    childIdsByTask: Map<string, string[]>
    rootIds: string[]
    subtreeIdsByTask: Map<string, string[]>
    dependenciesByTask: Map<string, string[]>
  },
  viewState: {
    collapsedTaskIds: Set<string>
    filters: Set<TaskState>
  },
  aggregateStateByTask: Map<string, TaskState>,
  leafProgressByTask: Map<string, { done: number; total: number }>,
  cycleEdgeIds: Set<string>,
): GanttLayout {
  const { tasks, childIdsByTask, rootIds, subtreeIdsByTask } = model
  const { filters } = viewState

  // Depth probe — `maxVisibleDepth` is structural (independent of the right edge), so a
  // throwaway pass fixes `leftWidth` before the real pass shares that column right edge.
  const probe = layoutRows(model, viewState, aggregateStateByTask, leafProgressByTask, GRAPH_PADDING + NODE_WIDTH)
  const leftWidth = GRAPH_PADDING + probe.maxVisibleDepth * INDENT + NODE_WIDTH + LEFT_COL_PAD

  const { nodes, groups, visibleOrder, visibleChildrenByTask, totalHeight } = layoutRows(
    model, viewState, aggregateStateByTask, leafProgressByTask, leftWidth,
  )

  if (nodes.size === 0) {
    return {
      groups: [], nodes: new Map(), edges: [], visibleOrder: [], visibleChildrenByTask: new Map(),
      bounds: { width: 0, height: 0 }, hasCycles: cycleEdgeIds.size > 0,
      bars: new Map(), ruler: { ticks: [] }, leftWidth, timeWidth: 0,
    }
  }

  // Schedule over the filter-visible leaf set. Collapse does NOT change the scheduled set
  // (it only hides rows), so a collapsed group's summary bar stays meaningful.
  const scheduleVisible = computeVisibleSet(tasks, childIdsByTask, rootIds, new Set(), filters)
  const schedule = computeGanttSchedule({ tasks, subtreeIdsByTask }, scheduleVisible)

  // Time-pane bars (origin x=0) — one per visible row that has a schedule entry.
  const bars = new Map<string, GanttBar>()
  for (const id of visibleOrder) {
    const entry = schedule.entries.get(id)
    const node = nodes.get(id)
    if (!entry || !node) continue
    bars.set(id, {
      x: entry.start * PX_PER_UNIT,
      width: Math.max(MIN_BAR, entry.duration * PX_PER_UNIT),
      y: node.y,
      state: aggregateStateByTask.get(id) ?? 'ready',
      assumed: entry.assumed,
      critical: entry.critical,
      cycle: entry.cycle,
      isSummary: entry.isSummary,
    })
  }

  // Edges — real `depends` only, routed FINISH-TO-START as cubic beziers (left→right).
  // View-local: an endpoint may only render if it has a leaf in the schedule set S. A
  // predecessor hidden by the STATE filter is not in S — it must NOT resurface as an edge
  // through a visible ancestor that merely carries a summary bar over its OTHER leaves.
  // (Collapse keeps leaves in S, so a collapsed group's summary anchor stays legitimate.)
  const scheduledLeaves = new Set([...scheduleVisible].filter(id => tasks.get(id)?.hasChildren === false))
  const hasScheduledLeaf = (id: string): boolean => {
    const task = tasks.get(id)
    if (!task) return false
    if (!task.hasChildren) return scheduledLeaves.has(id)
    return (subtreeIdsByTask.get(id) ?? []).some(x => scheduledLeaves.has(x))
  }

  const edgeGroups = new Map<string, { ids: { id: string; isCycle: boolean }[]; sourceId: string; targetId: string }>()
  for (const [tid, task] of tasks) {
    if (!hasScheduledLeaf(tid)) continue
    for (const dep of task.depends) {
      if (!hasScheduledLeaf(dep)) continue
      const sourceAnchor = resolveVisibleAnchor(dep, nodes, tasks)
      const targetAnchor = resolveVisibleAnchor(tid, nodes, tasks)
      if (!sourceAnchor || !targetAnchor || sourceAnchor === targetAnchor) continue
      if (!bars.has(sourceAnchor) || !bars.has(targetAnchor)) continue

      const key = `${sourceAnchor}->${targetAnchor}`
      const edgeId = `${dep}->${tid}`
      if (!edgeGroups.has(key)) edgeGroups.set(key, { ids: [], sourceId: sourceAnchor, targetId: targetAnchor })
      edgeGroups.get(key)!.ids.push({ id: edgeId, isCycle: cycleEdgeIds.has(edgeId) })
    }
  }

  const edges: LayoutEdge[] = []
  for (const [key, group] of edgeGroups) {
    const src = bars.get(group.sourceId)!
    const tgt = bars.get(group.targetId)!
    const sx = src.x + src.width
    const sy = src.y + NODE_HEIGHT / 2
    const tx = tgt.x
    const ty = tgt.y + NODE_HEIGHT / 2
    // Back-edges (sx > tx, from raw `depends` cycles or a summary source that overruns the
    // target) would route right-to-left with negative bezier control coords. FS arcs are
    // forward-only; omit them. The cycle's other (forward) arc still renders red via isCycle.
    if (sx > tx) continue
    const k = Math.max(MIN_BAR, (tx - sx) / 2)
    edges.push({
      id: key,
      sourceId: group.sourceId,
      targetId: group.targetId,
      path: `M ${sx},${sy} C ${sx + k},${sy} ${tx - k},${ty} ${tx},${ty}`,
      isCycle: group.ids.some(e => e.isCycle),
      isSameLane: false,
      count: group.ids.length,
      originalEdgeIds: group.ids.map(e => e.id), // ALWAYS populated (even count===1)
    })
  }

  // Ruler — one tick per optimistic unit in 0..ceil(makespan).
  const ticks: { x: number; label: string }[] = []
  for (let unit = 0; unit <= Math.ceil(schedule.makespan); unit++) {
    ticks.push({ x: unit * PX_PER_UNIT, label: String(unit) })
  }

  return {
    groups,
    nodes,
    edges,
    visibleOrder,
    visibleChildrenByTask,
    bounds: { width: leftWidth, height: totalHeight },
    hasCycles: cycleEdgeIds.size > 0,
    bars,
    ruler: { ticks },
    leftWidth,
    timeWidth: schedule.makespan * PX_PER_UNIT + LEFT_COL_PAD,
  }
}

function resolveVisibleAnchor(
  id: string,
  nodes: Map<string, LayoutNode>,
  tasks: Map<string, TaskGraphTask>,
): string | null {
  let current = id
  const visited = new Set<string>()
  while (current) {
    if (nodes.has(current)) return current
    if (visited.has(current)) return null
    visited.add(current)
    const task = tasks.get(current)
    if (!task?.parent) return null
    current = task.parent
  }
  return null
}

// --- Build full model ---

export function buildTaskGraphModel(raw: RawTaskMap): { model: TaskGraphModel; warnings: string[] } {
  const { tasks, warnings } = normalizeTasks(raw)

  const { childIdsByTask, rootIds } = buildForest(tasks)
  const { subtreeIdsByTask, aggregateStateByTask, leafProgressByTask } = computeSubtreeMetadata(tasks, childIdsByTask, rootIds)

  // Build adjacency maps
  const dependenciesByTask = new Map<string, string[]>()
  const dependentsByTask = new Map<string, string[]>()
  for (const [id, task] of tasks) {
    dependenciesByTask.set(id, task.depends)
    for (const dep of task.depends) {
      if (!dependentsByTask.has(dep)) dependentsByTask.set(dep, [])
      dependentsByTask.get(dep)!.push(id)
    }
  }

  // Cycle detection
  const cycleEdgeIds = findSCCCycleEdges(tasks)

  // Initial layout with all states visible, nothing collapsed
  const allStates = new Set<TaskState>(['ready', 'running', 'done', 'blocked', 'cancelled'])
  const layout = computeDisplayLayout(
    { tasks, childIdsByTask, rootIds, subtreeIdsByTask, dependenciesByTask },
    { collapsedTaskIds: new Set(), filters: allStates },
    aggregateStateByTask,
    leafProgressByTask,
    cycleEdgeIds,
  )

  return {
    model: {
      tasks,
      layout,
      dependenciesByTask,
      dependentsByTask,
      childIdsByTask,
      rootIds,
      subtreeIdsByTask,
      aggregateStateByTask,
      leafProgressByTask,
      cycleEdgeIds,
    },
    warnings,
  }
}
