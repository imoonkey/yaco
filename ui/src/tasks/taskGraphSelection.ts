// Selection traversal and highlight derivation — pure functions, no React dependency

import type { TaskGraphModel } from './taskGraphModel'

export type Selection =
  | null
  | { type: 'task'; id: string }
  | { type: 'milestone'; id: string }

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

  if (selection.type === 'task') {
    const { id } = selection
    const upstream = getUpstream(id, model.dependenciesByTask)
    const downstream = getDownstream(id, model.dependentsByTask)
    const allRelevant = new Set([id, ...upstream, ...downstream])

    const activeEdgeIds = new Set<string>()
    for (const edge of model.layout.edges) {
      if (allRelevant.has(edge.sourceId) && allRelevant.has(edge.targetId)) {
        activeEdgeIds.add(edge.id)
      }
    }

    return {
      activeTaskIds: new Set([id]),
      upstreamTaskIds: upstream,
      downstreamTaskIds: downstream,
      activeEdgeIds,
      dimUnrelated: true,
    }
  }

  // Milestone selection
  const milestoneTaskIds = model.taskIdsByMilestone.get(selection.id) ?? []
  const milestoneSet = new Set(milestoneTaskIds)

  const activeEdgeIds = new Set<string>()
  for (const edge of model.layout.edges) {
    // Edges crossing milestone boundary
    if (milestoneSet.has(edge.sourceId) || milestoneSet.has(edge.targetId)) {
      activeEdgeIds.add(edge.id)
    }
  }

  return {
    activeTaskIds: milestoneSet,
    upstreamTaskIds: new Set(),
    downstreamTaskIds: new Set(),
    activeEdgeIds,
    dimUnrelated: true,
  }
}

// Search: returns matching task IDs (case-insensitive substring match)
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
