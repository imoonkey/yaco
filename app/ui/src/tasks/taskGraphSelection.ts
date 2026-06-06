// Selection traversal and highlight derivation — pure functions, no React dependency

import type { TaskGraphModel, TaskGraphTask } from './taskGraphModel'

// Selection is just a task id or null — no separate milestone type
export type Selection = string | null

export type HighlightModel = {
  activeTaskIds: Set<string>
  upstreamTaskIds: Set<string>
  downstreamTaskIds: Set<string>
  directTaskIds: Set<string>
  activeEdgeIds: Set<string>
  directEdgeIds: Set<string>
  dimUnrelated: boolean
}

export const EMPTY_HIGHLIGHT: HighlightModel = {
  activeTaskIds: new Set(),
  upstreamTaskIds: new Set(),
  downstreamTaskIds: new Set(),
  directTaskIds: new Set(),
  activeEdgeIds: new Set(),
  directEdgeIds: new Set(),
  dimUnrelated: false,
}

export function getUpstream(taskId: string, deps: Map<string, string[]>): Set<string> {
  const visited = new Set<string>()
  const stack = [...(deps.get(taskId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    stack.push(...(deps.get(id) ?? []))
  }
  return visited
}

export function getDownstream(taskId: string, dependents: Map<string, string[]>): Set<string> {
  const visited = new Set<string>()
  const stack = [...(dependents.get(taskId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    stack.push(...(dependents.get(id) ?? []))
  }
  return visited
}

export function computeHighlight(selection: Selection, model: TaskGraphModel): HighlightModel {
  if (!selection) return EMPTY_HIGHLIGHT

  const task = model.tasks.get(selection)
  if (!task) return EMPTY_HIGHLIGHT

  if (task.hasChildren) {
    // Group task: highlight subtree + boundary edges
    const subtreeIds = new Set(model.subtreeIdsByTask.get(selection) ?? [selection])

    // Collect upstream/downstream outside subtree
    const upstream = new Set<string>()
    const downstream = new Set<string>()
    for (const tid of subtreeIds) {
      for (const dep of model.dependenciesByTask.get(tid) ?? []) {
        if (!subtreeIds.has(dep)) upstream.add(dep)
      }
      for (const dep of (model.dependentsByTask.get(tid) ?? [])) {
        if (!subtreeIds.has(dep)) downstream.add(dep)
      }
    }

    const activeEdgeIds = new Set<string>()
    for (const edge of model.layout.edges) {
      const srcInSubtree = subtreeIds.has(edge.sourceId)
      const tgtInSubtree = subtreeIds.has(edge.targetId)
      // Edges within subtree or crossing boundary
      if (srcInSubtree || tgtInSubtree) {
        activeEdgeIds.add(edge.id)
        if (edge.originalEdgeIds) {
          for (const eid of edge.originalEdgeIds) activeEdgeIds.add(eid)
        }
      }
    }

    return {
      activeTaskIds: subtreeIds,
      upstreamTaskIds: upstream,
      downstreamTaskIds: downstream,
      // Group boundary neighbours are all one hop from the subtree — treat them as direct.
      directTaskIds: new Set([...upstream, ...downstream]),
      activeEdgeIds,
      directEdgeIds: activeEdgeIds,
      dimUnrelated: true,
    }
  }

  // Leaf task: highlight upstream/downstream dependency closures
  const upstream = getUpstream(selection, model.dependenciesByTask)
  const downstream = getDownstream(selection, model.dependentsByTask)
  const allRelevant = new Set([selection, ...upstream, ...downstream])

  // Direct (one-hop) neighbours get emphasised; transitive ancestors/descendants recede.
  const directTaskIds = new Set<string>([
    ...(model.dependenciesByTask.get(selection) ?? []),
    ...(model.dependentsByTask.get(selection) ?? []),
  ])

  const activeEdgeIds = new Set<string>()
  const directEdgeIds = new Set<string>()
  for (const edge of model.layout.edges) {
    if (allRelevant.has(edge.sourceId) && allRelevant.has(edge.targetId)) {
      activeEdgeIds.add(edge.id)
      if (edge.originalEdgeIds) {
        for (const eid of edge.originalEdgeIds) activeEdgeIds.add(eid)
      }
      // Direct edges are the ones touching the selected task itself.
      if (edge.sourceId === selection || edge.targetId === selection) {
        directEdgeIds.add(edge.id)
        if (edge.originalEdgeIds) {
          for (const eid of edge.originalEdgeIds) directEdgeIds.add(eid)
        }
      }
    }
  }

  return {
    activeTaskIds: new Set([selection]),
    upstreamTaskIds: upstream,
    downstreamTaskIds: downstream,
    directTaskIds,
    activeEdgeIds,
    directEdgeIds,
    dimUnrelated: true,
  }
}

// Tasks linked to the active terminal session — those whose `agents` list contains
// the active session handle. This is a SEPARATE relationship from selection/search/
// dependency highlight: it adds no graph edge and never changes the selection. A dead
// handle can never be the active session, so dead handles never produce a linked set.
export function computeLinkedTaskIds(
  tasks: Map<string, TaskGraphTask>,
  activeSession: string | null | undefined,
): Set<string> {
  const linked = new Set<string>()
  if (!activeSession) return linked
  for (const [id, task] of tasks) {
    if (task.agents.includes(activeSession)) linked.add(id)
  }
  return linked
}

// Search: returns matching task IDs (case-insensitive substring match on all tasks)
export function searchTasks(query: string, model: TaskGraphModel): string[] {
  if (!query.trim()) return []
  const lower = query.toLowerCase()
  const results: string[] = []
  for (const [id, task] of model.tasks) {
    if (task.title.toLowerCase().includes(lower) || id.toLowerCase().includes(lower)) {
      results.push(id)
    }
  }
  return results
}
