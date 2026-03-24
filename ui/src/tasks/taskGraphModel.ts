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
  topLevelId: string | null
  depth: number
  hasChildren: boolean
}

// Layout types

export interface LayoutColumn {
  id: string
  title: string
  x: number
  y: number
  width: number
  height: number
  taskIds: string[]
  progress: { done: number; total: number }
  aggregateState: TaskState
}

export interface LayoutNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  columnId: string
}

export interface LayoutEdge {
  id: string
  sourceId: string
  targetId: string
  path: string
  isCycle: boolean
  isIntraMilestone: boolean
  count: number  // 1 for normal, >1 for deduplicated collapsed edges
  originalEdgeIds?: string[]  // For collapsed edges: IDs of the original edges that were merged
}

export interface GraphLayout {
  columns: LayoutColumn[]
  nodes: Map<string, LayoutNode>
  edges: LayoutEdge[]
  bounds: { width: number; height: number }
  hasCycles: boolean
}

export interface TaskGraphModel {
  tasks: Map<string, TaskGraphTask>
  layout: GraphLayout
  dependenciesByTask: Map<string, string[]>
  dependentsByTask: Map<string, string[]>
  taskIdsByMilestone: Map<string, string[]>
  searchIndex: Map<string, string> // lowercase title → id
}

// Constants

export const COLUMN_WIDTH = 240
export const COLUMN_GAP = 64
export const COLUMN_PADDING = 16
export const HEADER_HEIGHT = 56
export const NODE_WIDTH = 180
export const NODE_HEIGHT = 32
export const NODE_GAP = 8
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

function getTopLevelId(id: string, raw: RawTaskMap): string | null {
  let current = id
  const visited = new Set<string>()
  while (true) {
    const entry = raw[current]
    if (!entry?.parent || !raw[entry.parent]) return current === id ? null : current
    if (visited.has(current)) return current // cycle guard
    visited.add(current)
    current = entry.parent
  }
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
    // Validate depends
    const validDeps = entry.depends.filter(dep => {
      if (!ids.has(dep)) {
        warnings.push(`Task "${id}" depends on unknown task "${dep}"`)
        return false
      }
      return true
    })

    // Validate parent
    if (entry.parent && !ids.has(entry.parent)) {
      warnings.push(`Task "${id}" has unknown parent "${entry.parent}"`)
    }

    const topLevelId = getTopLevelId(id, raw)
    const isTopLevel = !entry.parent || !ids.has(entry.parent)
    const hasChildren = childrenOf.has(id)

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
      topLevelId: isTopLevel ? (hasChildren ? id : null) : topLevelId,
      depth: getDepth(id, raw),
      hasChildren,
    })
  }

  return { tasks, warnings }
}

// --- Layout Algorithm ---

// Kahn's topological sort with tie-breaking
function topoSort(nodeIds: string[], edges: [string, string][], tieBreak: (a: string, b: string) => number): { sorted: string[]; hasCycle: boolean; cycleNodes: Set<string> } {
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

  // Use sorted insertion for tie-breaking
  const queue = nodeIds.filter(id => inDegree.get(id) === 0).sort(tieBreak)
  const sorted: string[] = []

  while (queue.length) {
    const node = queue.shift()!
    sorted.push(node)
    for (const neighbor of adjacency.get(node) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, deg)
      if (deg === 0) {
        // Insert in sorted order
        const idx = queue.findIndex(q => tieBreak(neighbor, q) < 0)
        queue.splice(idx === -1 ? queue.length : idx, 0, neighbor)
      }
    }
  }

  const cycleNodes = new Set(nodeIds.filter(id => !sorted.includes(id)))
  return { sorted: [...sorted, ...Array.from(cycleNodes).sort(tieBreak)], hasCycle: cycleNodes.size > 0, cycleNodes }
}

function getAncestryPath(id: string, tasks: Map<string, TaskGraphTask>): string {
  const parts: string[] = []
  let current = id
  while (tasks.get(current)?.parent) {
    parts.unshift(tasks.get(current)!.parent!)
    current = tasks.get(current)!.parent!
  }
  return parts.join('/')
}

// Step 1: Build milestone buckets
function buildMilestoneBuckets(tasks: Map<string, TaskGraphTask>): Map<string, string[]> {
  const buckets = new Map<string, string[]>()

  for (const [id, task] of tasks) {
    // Top-level with children = milestone header (not a node)
    if (!task.parent && task.hasChildren) continue

    // Determine which bucket
    let milestoneId: string
    if (!task.parent) {
      milestoneId = '__ungrouped__'
    } else {
      milestoneId = task.topLevelId ?? '__ungrouped__'
    }

    if (!buckets.has(milestoneId)) buckets.set(milestoneId, [])
    buckets.get(milestoneId)!.push(id)
  }

  return buckets
}

// Step 2: Order milestone columns
function orderMilestones(buckets: Map<string, string[]>, tasks: Map<string, TaskGraphTask>): { sorted: string[]; hasCycle: boolean; cycleNodes: Set<string> } {
  const milestoneIds = Array.from(buckets.keys())

  // Build task-to-milestone lookup
  const taskToMilestone = new Map<string, string>()
  for (const [msId, taskIds] of buckets) {
    for (const tid of taskIds) taskToMilestone.set(tid, msId)
  }

  // Derive inter-milestone edges from task-level depends
  const edges: [string, string][] = []
  const edgeSet = new Set<string>()
  for (const [msId, taskIds] of buckets) {
    for (const tid of taskIds) {
      const task = tasks.get(tid)
      if (!task) continue
      for (const dep of task.depends) {
        const depMs = taskToMilestone.get(dep)
        if (depMs && depMs !== msId) {
          const key = `${depMs}->${msId}`
          if (!edgeSet.has(key)) {
            edgeSet.add(key)
            edges.push([depMs, msId])
          }
        }
      }
    }
  }

  // Also include milestone-level depends (top-level tasks with children)
  for (const msId of milestoneIds) {
    if (msId === '__ungrouped__') continue
    const msTask = tasks.get(msId)
    if (!msTask) continue
    for (const dep of msTask.depends) {
      // dep could be another milestone or a task within a milestone
      let depMs: string | undefined
      if (buckets.has(dep)) {
        depMs = dep
      } else {
        depMs = taskToMilestone.get(dep)
      }
      if (depMs && depMs !== msId) {
        const key = `${depMs}->${msId}`
        if (!edgeSet.has(key)) {
          edgeSet.add(key)
          edges.push([depMs, msId])
        }
      }
    }
  }

  const titleOf = (id: string) => tasks.get(id)?.title ?? id
  return topoSort(milestoneIds, edges, (a, b) => {
    if (a === '__ungrouped__') return 1
    if (b === '__ungrouped__') return -1
    return titleOf(a).localeCompare(titleOf(b))
  })
}

// Step 3: Order tasks within columns
function orderTasksInColumn(taskIds: string[], tasks: Map<string, TaskGraphTask>): { sorted: string[]; hasCycle: boolean; cycleNodes: Set<string> } {
  const edges: [string, string][] = []
  const idSet = new Set(taskIds)
  for (const tid of taskIds) {
    const task = tasks.get(tid)
    if (!task) continue
    for (const dep of task.depends) {
      if (idSet.has(dep)) edges.push([dep, tid])
    }
  }

  return topoSort(taskIds, edges, (a, b) => {
    const ta = tasks.get(a)!
    const tb = tasks.get(b)!
    // State priority
    const sp = STATE_PRIORITY[ta.state] - STATE_PRIORITY[tb.state]
    if (sp !== 0) return sp
    // Shallower depth first
    const dp = ta.depth - tb.depth
    if (dp !== 0) return dp
    // Ancestry path groups siblings
    const ap = getAncestryPath(a, tasks).localeCompare(getAncestryPath(b, tasks))
    if (ap !== 0) return ap
    // Title alphabetical
    const tp = ta.title.localeCompare(tb.title)
    if (tp !== 0) return tp
    // ID fallback
    return a.localeCompare(b)
  })
}

// Aggregate state for a set of tasks
function computeAggregateState(taskIds: string[], tasks: Map<string, TaskGraphTask>): TaskState {
  const states = taskIds.map(id => tasks.get(id)?.state ?? 'cancelled')
  if (states.every(s => s === 'done')) return 'done'
  if (states.some(s => s === 'running')) return 'running'
  if (states.some(s => s === 'blocked')) return 'blocked'
  if (states.some(s => s === 'ready')) return 'ready'
  return 'cancelled'
}

// Step 5: Compute edge paths
function computeEdgePath(
  source: LayoutNode,
  target: LayoutNode,
  sourceCol: LayoutColumn,
  targetCol: LayoutColumn,
): { path: string; isIntraMilestone: boolean } {
  const isIntra = sourceCol.id === targetCol.id

  if (isIntra) {
    // Arc to the right of nodes
    const sx = source.x + NODE_WIDTH
    const sy = source.y + NODE_HEIGHT / 2
    const tx = target.x + NODE_WIDTH
    const ty = target.y + NODE_HEIGHT / 2
    const cp1x = sx + ARC_OFFSET
    const cp1y = sy
    const cp2x = tx + ARC_OFFSET
    const cp2y = ty
    return {
      path: `M ${sx},${sy} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${tx},${ty}`,
      isIntraMilestone: true,
    }
  }

  // Cross-milestone: right edge of source → left edge of target
  const sx = source.x + NODE_WIDTH
  const sy = source.y + NODE_HEIGHT / 2
  const tx = target.x
  const ty = target.y + NODE_HEIGHT / 2
  const gap = targetCol.x - (sourceCol.x + COLUMN_WIDTH)
  const cp1x = sx + Math.max(gap / 2, 20)
  const cp1y = sy
  const cp2x = tx - Math.max(gap / 2, 20)
  const cp2y = ty
  return {
    path: `M ${sx},${sy} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${tx},${ty}`,
    isIntraMilestone: false,
  }
}

export function computeLayout(tasks: Map<string, TaskGraphTask>): GraphLayout {
  // Step 1: Build milestone buckets
  const buckets = buildMilestoneBuckets(tasks)

  if (buckets.size === 0) {
    return { columns: [], nodes: new Map(), edges: [], bounds: { width: 0, height: 0 }, hasCycles: false }
  }

  // Step 2: Order milestone columns
  const { sorted: milestoneOrder, hasCycle, cycleNodes: milestoneCycleNodes } = orderMilestones(buckets, tasks)

  // Step 3: Order tasks within each column, collecting intra-milestone cycle info
  const orderedBuckets = new Map<string, string[]>()
  const intraCycleNodes = new Set<string>()
  let hasIntraCycles = false
  for (const msId of milestoneOrder) {
    const taskIds = buckets.get(msId) ?? []
    const { sorted, hasCycle: colHasCycle, cycleNodes: colCycleNodes } = orderTasksInColumn(taskIds, tasks)
    orderedBuckets.set(msId, sorted)
    if (colHasCycle) {
      hasIntraCycles = true
      for (const n of colCycleNodes) intraCycleNodes.add(n)
    }
  }

  // Step 4: Assign coordinates
  const columns: LayoutColumn[] = []
  const nodes = new Map<string, LayoutNode>()
  const columnById = new Map<string, LayoutColumn>()

  milestoneOrder.forEach((msId, colIndex) => {
    const taskIds = orderedBuckets.get(msId) ?? []
    const x = GRAPH_PADDING + colIndex * (COLUMN_WIDTH + COLUMN_GAP)
    const y = GRAPH_PADDING
    const height = HEADER_HEIGHT + COLUMN_PADDING + Math.max(taskIds.length, 1) * (NODE_HEIGHT + NODE_GAP)
    const doneCount = taskIds.filter(id => tasks.get(id)?.state === 'done').length

    const col: LayoutColumn = {
      id: msId,
      title: msId === '__ungrouped__' ? 'Ungrouped' : (tasks.get(msId)?.title ?? msId),
      x,
      y,
      width: COLUMN_WIDTH,
      height,
      taskIds,
      progress: { done: doneCount, total: taskIds.length },
      aggregateState: computeAggregateState(taskIds, tasks),
    }
    columns.push(col)
    columnById.set(msId, col)

    // Position nodes within column
    taskIds.forEach((tid, rowIndex) => {
      nodes.set(tid, {
        id: tid,
        x: x + (COLUMN_WIDTH - NODE_WIDTH) / 2,
        y: y + HEADER_HEIGHT + COLUMN_PADDING + rowIndex * (NODE_HEIGHT + NODE_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        columnId: msId,
      })
    })
  })

  // Build task-to-milestone lookup for cycle detection
  const taskToMilestone = new Map<string, string>()
  for (const [msId, taskIds] of orderedBuckets) {
    for (const tid of taskIds) taskToMilestone.set(tid, msId)
  }

  // Step 5: Compute edge paths
  const edges: LayoutEdge[] = []
  for (const [tid, task] of tasks) {
    const targetNode = nodes.get(tid)
    if (!targetNode) continue
    const targetCol = columnById.get(targetNode.columnId)
    if (!targetCol) continue

    for (const depId of task.depends) {
      const sourceNode = nodes.get(depId)
      if (!sourceNode) continue
      const sourceCol = columnById.get(sourceNode.columnId)
      if (!sourceCol) continue

      const { path, isIntraMilestone } = computeEdgePath(sourceNode, targetNode, sourceCol, targetCol)

      // Cycle detection: inter-milestone (both in milestone cycle set) or intra-milestone (both in column cycle set)
      const sourceMs = taskToMilestone.get(depId)
      const targetMs = taskToMilestone.get(tid)
      const isInterCycle = !!(sourceMs && targetMs && milestoneCycleNodes.has(sourceMs) && milestoneCycleNodes.has(targetMs))
      const isIntraCycle = !!(sourceMs === targetMs && intraCycleNodes.has(depId) && intraCycleNodes.has(tid))
      const isCycle = isInterCycle || isIntraCycle

      edges.push({
        id: `${depId}->${tid}`,
        sourceId: depId,
        targetId: tid,
        path,
        isCycle,
        isIntraMilestone,
        count: 1,
      })
    }
  }

  // Edges from milestone-level depends (milestone tasks with children that carry depends)
  for (const col of columns) {
    if (col.id === '__ungrouped__') continue
    const msTask = tasks.get(col.id)
    if (!msTask) continue
    for (const depId of msTask.depends) {
      // Resolve source node: if dep is a task node, use it directly;
      // if dep is a milestone, use its last task as the source
      let sourceNodeId: string | undefined
      if (nodes.has(depId)) {
        sourceNodeId = depId
      } else {
        const depCol = columnById.get(depId)
        if (depCol && depCol.taskIds.length > 0) {
          sourceNodeId = depCol.taskIds[depCol.taskIds.length - 1]
        }
      }
      if (!sourceNodeId) continue

      // Target: first task in this milestone
      const firstTaskId = col.taskIds[0]
      if (!firstTaskId) continue

      const edgeId = `${depId}->${col.id}`
      if (edges.some(e => e.id === edgeId)) continue

      const sourceNode = nodes.get(sourceNodeId)!
      const targetNode = nodes.get(firstTaskId)!
      const sourceCol = columnById.get(sourceNode.columnId)!
      const targetCol = col

      const { path, isIntraMilestone } = computeEdgePath(sourceNode, targetNode, sourceCol, targetCol)

      const sourceMs = taskToMilestone.get(sourceNodeId)
      const isInterCycle = !!(sourceMs && milestoneCycleNodes.has(sourceMs) && milestoneCycleNodes.has(col.id))

      edges.push({
        id: edgeId,
        sourceId: sourceNodeId,
        targetId: firstTaskId,
        path,
        isCycle: isInterCycle,
        isIntraMilestone,
        count: 1,
      })
    }
  }
  const colCount = columns.length
  const maxColHeight = Math.max(...columns.map(c => c.height))
  const bounds = {
    width: colCount > 0 ? GRAPH_PADDING * 2 + colCount * COLUMN_WIDTH + (colCount - 1) * COLUMN_GAP : 0,
    height: GRAPH_PADDING * 2 + maxColHeight,
  }

  return { columns, nodes, edges, bounds, hasCycles: hasCycle || hasIntraCycles }
}

// --- Collapsed layout transform ---

export function computeCollapsedLayout(
  layout: GraphLayout,
  collapsedIds: Set<string>,
): GraphLayout {
  if (collapsedIds.size === 0) return layout

  // Build node → column lookup from original layout
  const nodeToColumn = new Map<string, string>()
  for (const [id, node] of layout.nodes) {
    nodeToColumn.set(id, node.columnId)
  }

  const columnById = new Map<string, LayoutColumn>()
  for (const col of layout.columns) columnById.set(col.id, col)

  // 1. Adjust column heights
  const columns = layout.columns.map(col =>
    collapsedIds.has(col.id)
      ? { ...col, height: HEADER_HEIGHT }
      : col
  )
  const adjustedColumnById = new Map<string, LayoutColumn>()
  for (const col of columns) adjustedColumnById.set(col.id, col)

  // 2. Filter nodes — remove nodes in collapsed columns
  const nodes = new Map<string, LayoutNode>()
  for (const [id, node] of layout.nodes) {
    if (!collapsedIds.has(node.columnId)) nodes.set(id, node)
  }

  // 3. Reroute + deduplicate edges
  const edgeGroups = new Map<string, { edges: LayoutEdge[]; effectiveSource: string; effectiveTarget: string }>()

  for (const edge of layout.edges) {
    const sourceCol = nodeToColumn.get(edge.sourceId)
    const targetCol = nodeToColumn.get(edge.targetId)
    const sourceCollapsed = sourceCol ? collapsedIds.has(sourceCol) : false
    const targetCollapsed = targetCol ? collapsedIds.has(targetCol) : false

    // Skip intra-milestone edges within same collapsed milestone
    if (sourceCollapsed && targetCollapsed && sourceCol === targetCol) continue

    const effectiveSource = sourceCollapsed && sourceCol ? sourceCol : edge.sourceId
    const effectiveTarget = targetCollapsed && targetCol ? targetCol : edge.targetId

    const key = `${effectiveSource}->${effectiveTarget}`
    if (!edgeGroups.has(key)) {
      edgeGroups.set(key, { edges: [], effectiveSource, effectiveTarget })
    }
    edgeGroups.get(key)!.edges.push(edge)
  }

  // Build collapsed edges with computed paths
  const edges: LayoutEdge[] = []
  for (const [key, group] of edgeGroups) {
    const { effectiveSource, effectiveTarget } = group

    // Compute anchor points
    let sx: number, sy: number, sourceColObj: LayoutColumn
    const srcCol = adjustedColumnById.get(effectiveSource)
    if (srcCol) {
      // Source is a collapsed milestone
      sx = srcCol.x + COLUMN_WIDTH
      sy = srcCol.y + HEADER_HEIGHT / 2
      sourceColObj = srcCol
    } else {
      const srcNode = layout.nodes.get(effectiveSource)!
      sx = srcNode.x + NODE_WIDTH
      sy = srcNode.y + NODE_HEIGHT / 2
      sourceColObj = adjustedColumnById.get(srcNode.columnId)!
    }

    let tx: number, ty: number, targetColObj: LayoutColumn
    const tgtCol = adjustedColumnById.get(effectiveTarget)
    if (tgtCol) {
      // Target is a collapsed milestone
      tx = tgtCol.x
      ty = tgtCol.y + HEADER_HEIGHT / 2
      targetColObj = tgtCol
    } else {
      const tgtNode = layout.nodes.get(effectiveTarget)!
      tx = tgtNode.x
      ty = tgtNode.y + NODE_HEIGHT / 2
      targetColObj = adjustedColumnById.get(tgtNode.columnId)!
    }

    // Cross-milestone bezier path
    const gap = targetColObj.x - (sourceColObj.x + COLUMN_WIDTH)
    const cp1x = sx + Math.max(gap / 2, 20)
    const cp2x = tx - Math.max(gap / 2, 20)
    const path = `M ${sx},${sy} C ${cp1x},${sy} ${cp2x},${ty} ${tx},${ty}`

    const hasCycle = group.edges.some(e => e.isCycle)

    edges.push({
      id: key,
      sourceId: effectiveSource,
      targetId: effectiveTarget,
      path,
      isCycle: hasCycle,
      isIntraMilestone: false,
      count: group.edges.length,
      originalEdgeIds: group.edges.map(e => e.id),
    })
  }

  // 4. Recompute bounds
  const maxColHeight = Math.max(...columns.map(c => c.height))
  const bounds = {
    width: layout.bounds.width,
    height: GRAPH_PADDING * 2 + maxColHeight,
  }

  return { columns, nodes, edges, bounds, hasCycles: layout.hasCycles }
}

// --- Build full model ---

export function buildTaskGraphModel(raw: RawTaskMap): { model: TaskGraphModel; warnings: string[] } {
  const { tasks, warnings } = normalizeTasks(raw)
  const layout = computeLayout(tasks)

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

  // Build milestone → task IDs map
  const taskIdsByMilestone = new Map<string, string[]>()
  for (const col of layout.columns) {
    taskIdsByMilestone.set(col.id, col.taskIds)
  }

  // Build search index
  const searchIndex = new Map<string, string>()
  for (const [id, task] of tasks) {
    searchIndex.set(task.title.toLowerCase(), id)
  }

  return {
    model: { tasks, layout, dependenciesByTask, dependentsByTask, taskIdsByMilestone, searchIndex },
    warnings,
  }
}
