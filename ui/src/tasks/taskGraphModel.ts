// Pure-function graph model: normalize, layout, edge paths
// No React dependency — independently testable

export type TaskState = 'ready' | 'running' | 'done' | 'blocked' | 'cancelled'

export type RawTaskEntry = {
  title: string
  description?: string
  parent: string | null
  depends: string[]
  state: TaskState
  scope?: string[]
  acceptCriteria?: string | string[]
  note?: string | null
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
}

// Layout types

export interface LayoutGroup {
  id: string
  x: number
  y: number
  width: number
  height: number
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

// Constants

export const NODE_WIDTH = 200
export const NODE_HEIGHT = 32
export const NODE_GAP = 8
export const GROUP_PADDING_X = 12
export const GROUP_PADDING_TOP = 8
export const GROUP_PADDING_BOTTOM = 10
export const COLUMN_GAP = 64
export const GRAPH_PADDING = 40
export const ARC_OFFSET = 30

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
  width: number
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

  if (rawChildren.length === 0 || isCollapsed) {
    // Leaf or collapsed group — just a header card
    return { id, width: NODE_WIDTH, height: NODE_HEIGHT, isGroup: task.hasChildren, children: [] }
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
    // All children filtered out — render as leaf-like
    return { id, width: NODE_WIDTH, height: NODE_HEIGHT, isGroup: true, children: [] }
  }

  const maxChildWidth = Math.max(...measuredChildren.map(c => c.width))
  const contentWidth = Math.max(NODE_WIDTH, maxChildWidth)
  const groupWidth = contentWidth + 2 * GROUP_PADDING_X

  const childrenHeight = measuredChildren.reduce((sum, c) => sum + c.height, 0) +
    (measuredChildren.length - 1) * NODE_GAP

  const groupHeight = GROUP_PADDING_TOP + NODE_HEIGHT + NODE_GAP + childrenHeight + GROUP_PADDING_BOTTOM

  return { id, width: groupWidth, height: groupHeight, isGroup: true, children: measuredChildren }
}

function positionTree(
  item: MeasuredItem,
  x: number,
  y: number,
  depth: number,
  tasks: Map<string, TaskGraphTask>,
  aggregateStateByTask: Map<string, TaskState>,
  leafProgressByTask: Map<string, { done: number; total: number }>,
  collapsedTaskIds: Set<string>,
  outGroups: LayoutGroup[],
  outNodes: Map<string, LayoutNode>,
  outVisibleOrder: string[],
  outVisibleChildren: Map<string, string[]>,
): void {
  const task = tasks.get(item.id)
  if (!task) return

  outVisibleOrder.push(item.id)

  if (item.isGroup && item.children.length > 0) {
    // Group with visible children
    outGroups.push({
      id: item.id,
      x,
      y,
      width: item.width,
      height: item.height,
      depth,
      childIds: item.children.map(c => c.id),
      aggregateState: aggregateStateByTask.get(item.id) ?? 'cancelled',
      progress: leafProgressByTask.get(item.id) ?? { done: 0, total: 0 },
    })

    // Header node at top of group
    outNodes.set(item.id, {
      id: item.id,
      x: x + GROUP_PADDING_X,
      y: y + GROUP_PADDING_TOP,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      parentId: task.parent,
      hasChildren: true,
      depth,
    })

    outVisibleChildren.set(item.id, item.children.map(c => c.id))

    // Position children below header
    let childY = y + GROUP_PADDING_TOP + NODE_HEIGHT + NODE_GAP
    for (const child of item.children) {
      const childX = x + GROUP_PADDING_X
      positionTree(child, childX, childY, depth + 1, tasks, aggregateStateByTask, leafProgressByTask, collapsedTaskIds, outGroups, outNodes, outVisibleOrder, outVisibleChildren)
      childY += child.height + NODE_GAP
    }
  } else {
    // Leaf or collapsed group — just a node
    outNodes.set(item.id, {
      id: item.id,
      x,
      y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      parentId: task.parent,
      hasChildren: task.hasChildren,
      depth,
    })

    // Collapsed group still registers as a group (for container frame)
    if (task.hasChildren && collapsedTaskIds.has(item.id)) {
      outGroups.push({
        id: item.id,
        x,
        y,
        width: item.width,
        height: item.height,
        depth,
        childIds: [],
        aggregateState: aggregateStateByTask.get(item.id) ?? 'cancelled',
        progress: leafProgressByTask.get(item.id) ?? { done: 0, total: 0 },
      })
    }
  }
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

// Find root lane for a task (walk to root)
function getRootLane(id: string, tasks: Map<string, TaskGraphTask>): string {
  let current = id
  const visited = new Set<string>()
  while (true) {
    const task = tasks.get(current)
    if (!task?.parent || visited.has(current)) return current
    visited.add(current)
    current = task.parent
  }
}

// Edge path computation
function computeEdgePath(
  source: LayoutNode,
  target: LayoutNode,
  sameLane: boolean,
): { path: string; isSameLane: boolean } {
  if (sameLane) {
    // Arc to the right
    const sx = source.x + NODE_WIDTH
    const sy = source.y + NODE_HEIGHT / 2
    const tx = target.x + NODE_WIDTH
    const ty = target.y + NODE_HEIGHT / 2
    const depthDiff = Math.abs(source.depth - target.depth)
    const arcOffset = ARC_OFFSET + depthDiff * 10
    return {
      path: `M ${sx},${sy} C ${sx + arcOffset},${sy} ${tx + arcOffset},${ty} ${tx},${ty}`,
      isSameLane: true,
    }
  }

  // Cross-lane: right edge → left edge
  const sx = source.x + NODE_WIDTH
  const sy = source.y + NODE_HEIGHT / 2
  const tx = target.x
  const ty = target.y + NODE_HEIGHT / 2
  const gap = Math.abs(tx - sx)
  const cpOffset = Math.max(gap / 2, 20)
  return {
    path: `M ${sx},${sy} C ${sx + cpOffset},${sy} ${tx - cpOffset},${ty} ${tx},${ty}`,
    isSameLane: false,
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
): GraphLayout {
  const { tasks, childIdsByTask, rootIds, subtreeIdsByTask } = model
  const { collapsedTaskIds, filters } = viewState

  // Compute visible set
  const visibleSet = computeVisibleSet(tasks, childIdsByTask, rootIds, collapsedTaskIds, filters)

  if (visibleSet.size === 0) {
    return { groups: [], nodes: new Map(), edges: [], visibleOrder: [], visibleChildrenByTask: new Map(), bounds: { width: 0, height: 0 }, hasCycles: cycleEdgeIds.size > 0 }
  }

  // Order root-level items
  const visibleRoots = rootIds.filter(id => visibleSet.has(id))
  const orderedRoots = orderSiblings(visibleRoots, tasks, subtreeIdsByTask, aggregateStateByTask)

  // Measure each root tree
  const measuredRoots: MeasuredItem[] = []
  for (const rootId of orderedRoots) {
    const measured = measureTree(rootId, tasks, childIdsByTask, subtreeIdsByTask, aggregateStateByTask, collapsedTaskIds, visibleSet)
    if (measured) measuredRoots.push(measured)
  }

  // Position roots horizontally
  const groups: LayoutGroup[] = []
  const nodes = new Map<string, LayoutNode>()
  const visibleOrder: string[] = []
  const visibleChildrenByTask = new Map<string, string[]>()

  let rootX = GRAPH_PADDING
  for (const root of measuredRoots) {
    // Ensure minimum lane width
    const laneWidth = Math.max(root.width, NODE_WIDTH + 2 * GROUP_PADDING_X)
    positionTree(root, rootX, GRAPH_PADDING, 0, tasks, aggregateStateByTask, leafProgressByTask, collapsedTaskIds, groups, nodes, visibleOrder, visibleChildrenByTask)
    rootX += laneWidth + COLUMN_GAP
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

    const sourceLane = getRootLane(group.sourceId, tasks)
    const targetLane = getRootLane(group.targetId, tasks)
    const sameLane = sourceLane === targetLane

    const { path, isSameLane } = computeEdgePath(sourceNode, targetNode, sameLane)
    const hasCycle = group.edges.some(e => e.isCycle)

    edges.push({
      id: edgeKey,
      sourceId: group.sourceId,
      targetId: group.targetId,
      path,
      isCycle: hasCycle,
      isSameLane,
      count: group.edges.length,
      originalEdgeIds: group.edges.length > 1 ? group.edges.map(e => e.id) : undefined,
    })
  }

  // Bounds
  let maxX = 0, maxY = 0
  for (const node of nodes.values()) {
    maxX = Math.max(maxX, node.x + node.width)
    maxY = Math.max(maxY, node.y + node.height)
  }
  for (const group of groups) {
    maxX = Math.max(maxX, group.x + group.width)
    maxY = Math.max(maxY, group.y + group.height)
  }

  return {
    groups,
    nodes,
    edges,
    visibleOrder,
    visibleChildrenByTask,
    bounds: { width: maxX + GRAPH_PADDING, height: maxY + GRAPH_PADDING },
    hasCycles: cycleEdgeIds.size > 0,
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
