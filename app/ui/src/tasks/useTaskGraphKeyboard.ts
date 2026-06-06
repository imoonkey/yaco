import { useEffect } from 'react'
import type { TaskGraphModel, GraphLayout } from './taskGraphModel'
import type { Selection } from './taskGraphSelection'
import type { TaskGraphInteraction } from './useTaskGraphInteraction'

function isInputLikeElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

export function useTaskGraphKeyboard(
  graph: TaskGraphModel | null,
  displayLayout: GraphLayout | null,
  selection: Selection,
  collapsedTaskIds: Set<string>,
  interaction: Pick<TaskGraphInteraction, 'setSelection' | 'handleNavigate' | 'handleToggleCollapse' | 'handleCollapseAll' | 'handleExpandAll' | 'clearTooltip'>,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isInputLikeElement(document.activeElement)) return

      if (e.key === 'Escape') {
        interaction.setSelection(null)
        interaction.clearTooltip()
        return
      }

      // Collapse shortcuts
      if (e.key === 'c' && !e.shiftKey && selection && graph?.tasks.get(selection)?.hasChildren) {
        interaction.handleToggleCollapse(selection)
        return
      }
      if (e.key === 'C' && e.shiftKey) {
        interaction.handleCollapseAll()
        return
      }
      if (e.key === 'E' && e.shiftKey) {
        interaction.handleExpandAll()
        return
      }

      if (!displayLayout) return

      // Tab: DFS traversal
      if (e.key === 'Tab') {
        e.preventDefault()
        const order = displayLayout.visibleOrder
        if (order.length === 0) return
        if (!selection) {
          interaction.handleNavigate(order[0])
        } else {
          const idx = order.indexOf(selection)
          const next = e.shiftKey
            ? (idx <= 0 ? order.length - 1 : idx - 1)
            : ((idx + 1) % order.length)
          interaction.handleNavigate(order[next])
        }
        return
      }

      if (!selection || !graph) return

      const order = displayLayout.visibleOrder
      const task = graph.tasks.get(selection)
      if (!task) return

      // ArrowUp/ArrowDown: previous/next in DFS visible order
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const idx = order.indexOf(selection)
        if (idx === -1) return
        const next = e.key === 'ArrowUp' ? idx - 1 : idx + 1
        if (next >= 0 && next < order.length) {
          interaction.handleNavigate(order[next])
        }
        return
      }

      // ArrowLeft: collapse or go to parent
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (task.hasChildren && !collapsedTaskIds.has(selection)) {
          interaction.handleToggleCollapse(selection)
        } else if (task.parent) {
          interaction.handleNavigate(task.parent)
        } else {
          const rootIdx = graph.rootIds.indexOf(selection)
          if (rootIdx > 0) interaction.handleNavigate(graph.rootIds[rootIdx - 1])
        }
        return
      }

      // ArrowRight: expand or go to first child
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (task.hasChildren && collapsedTaskIds.has(selection)) {
          interaction.handleToggleCollapse(selection)
        } else {
          const visChildren = displayLayout.visibleChildrenByTask.get(selection) ?? []
          if (visChildren.length > 0) {
            interaction.handleNavigate(visChildren[0])
          } else if (!task.parent) {
            const rootIdx = graph.rootIds.indexOf(selection)
            if (rootIdx !== -1 && rootIdx < graph.rootIds.length - 1) interaction.handleNavigate(graph.rootIds[rootIdx + 1])
          }
        }
        return
      }

      // Home / End
      if (e.key === 'Home') {
        e.preventDefault()
        if (order.length > 0) interaction.handleNavigate(order[0])
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        if (order.length > 0) interaction.handleNavigate(order[order.length - 1])
        return
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [graph, displayLayout, selection, interaction, collapsedTaskIds])
}
