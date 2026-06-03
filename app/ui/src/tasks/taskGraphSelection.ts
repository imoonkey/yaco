// Selection traversal and highlight derivation — pure functions, no React dependency

import type { TaskGraphModel } from './taskGraphModel'

// Selection is just a task id or null — no separate milestone type
export type Selection = string | null

export type HighlightModel = {
  activeTaskIds: Set<string>
  upstreamTaskIds: Set<string>
  downstreamTaskIds: Set<string>
  activeEdgeIds: Set<string>
  dimUnrelated: boolean
}

export const EMPTY_HIGHLIGHT: HighlightModel = {
  activeTaskIds: new Set(),
  upstreamTaskIds: new Set(),
  downstreamTaskIds: new Set(),
  activeEdgeIds: new Set(),
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
      activeEdgeIds,
      dimUnrelated: true,
    }
  }

  // Leaf task: highlight upstream/downstream dependency closures
  const upstream = getUpstream(selection, model.dependenciesByTask)
  const downstream = getDownstream(selection, model.dependentsByTask)
  const allRelevant = new Set([selection, ...upstream, ...downstream])

  const activeEdgeIds = new Set<string>()
  for (const edge of model.layout.edges) {
    if (allRelevant.has(edge.sourceId) && allRelevant.has(edge.targetId)) {
      activeEdgeIds.add(edge.id)
      if (edge.originalEdgeIds) {
        for (const eid of edge.originalEdgeIds) activeEdgeIds.add(eid)
      }
    }
  }

  return {
    activeTaskIds: new Set([selection]),
    upstreamTaskIds: upstream,
    downstreamTaskIds: downstream,
    activeEdgeIds,
    dimUnrelated: true,
  }
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
