import { useState, useMemo, useCallback, useRef } from 'react'
import type { TaskV2 } from '../model/taskModel'

export type SortColumn = 'id' | 'title' | 'state' | 'priority' | 'agent' | 'scope' | 'parent'
export type SortDirection = 'asc' | 'desc'

export type ListGroup = {
  parentId: string | null
  parentTitle: string
  tasks: TaskV2[]
  doneCount: number
  totalCount: number
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 }
const STATE_ORDER: Record<string, number> = { blocked: 0, ready: 1, running: 2, done: 3, cancelled: 4 }

function compare(col: SortColumn, dir: SortDirection, a: TaskV2, b: TaskV2): number {
  const m = dir === 'asc' ? 1 : -1
  switch (col) {
    case 'id': return m * a.id.localeCompare(b.id, undefined, { numeric: true })
    case 'title': return m * a.title.localeCompare(b.title)
    case 'state': return m * ((STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9))
    case 'priority': return m * ((PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9))
    case 'agent': return m * (a.agent ?? '').localeCompare(b.agent ?? '')
    case 'scope': return m * (a.scope.length - b.scope.length)
    case 'parent': return m * (a.parent ?? '').localeCompare(b.parent ?? '')
  }
}

export function useTaskList(
  tasks: Map<string, TaskV2>,
  filteredTaskIds: Set<string>,
) {
  const [sortCol, setSortCol] = useState<SortColumn>('id')
  const [sortDir, setSortDir] = useState<SortDirection>('asc')
  const [groupByParent, setGroupByParent] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const lastClickedRef = useRef<string | null>(null)

  const toggleSort = useCallback((col: SortColumn) => {
    setSortCol(prev => {
      if (prev === col) {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc')
        return col
      }
      setSortDir('asc')
      return col
    })
  }, [])

  const sortedTasks = useMemo(() => {
    const arr: TaskV2[] = []
    for (const [id, task] of tasks) {
      if (filteredTaskIds.has(id)) arr.push(task)
    }
    arr.sort((a, b) => compare(sortCol, sortDir, a, b))
    return arr
  }, [tasks, filteredTaskIds, sortCol, sortDir])

  const groups = useMemo((): ListGroup[] | null => {
    if (!groupByParent) return null
    const map = new Map<string | null, TaskV2[]>()
    for (const task of sortedTasks) {
      const pid = task.parent
      if (!map.has(pid)) map.set(pid, [])
      map.get(pid)!.push(task)
    }
    const result: ListGroup[] = []
    for (const [pid, groupTasks] of map) {
      const parent = pid ? tasks.get(pid) : null
      result.push({
        parentId: pid,
        parentTitle: parent?.title ?? 'Ungrouped',
        tasks: groupTasks,
        doneCount: groupTasks.filter(t => t.state === 'done').length,
        totalCount: groupTasks.length,
      })
    }
    return result
  }, [sortedTasks, groupByParent, tasks])

  /** Returns selection action based on modifier keys */
  const computeSelection = useCallback((
    taskId: string,
    currentMultiIds: Set<string>,
    shiftKey: boolean,
    metaKey: boolean,
  ): { action: 'select'; id: string } | { action: 'multi'; ids: Set<string> } => {
    if (metaKey) {
      const next = new Set(currentMultiIds)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      lastClickedRef.current = taskId
      return { action: 'multi', ids: next }
    }
    if (shiftKey && lastClickedRef.current) {
      const ids = sortedTasks.map(t => t.id)
      const from = ids.indexOf(lastClickedRef.current)
      const to = ids.indexOf(taskId)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        const next = new Set(currentMultiIds)
        for (let i = lo; i <= hi; i++) next.add(ids[i])
        return { action: 'multi', ids: next }
      }
    }
    lastClickedRef.current = taskId
    return { action: 'select', id: taskId }
  }, [sortedTasks])

  return {
    sortCol,
    sortDir,
    toggleSort,
    groupByParent,
    setGroupByParent,
    sortedTasks,
    groups,
    editingTaskId,
    setEditingTaskId,
    computeSelection,
  }
}
