import { useMemo, useState, useCallback } from 'react'
import type { TaskV2, TaskState } from '../model/taskModel'
import type { TaskMutations } from './useTaskData'

type BoardColumns = {
  blocked: TaskV2[]
  ready: TaskV2[]
  running: TaskV2[]
  done: TaskV2[]
}

const PRIORITY_ORDER = { critical: 0, high: 1, normal: 2, low: 3 } as const

function sortBlocked(a: TaskV2, b: TaskV2): number {
  return b.depends.length - a.depends.length || a.title.localeCompare(b.title)
}

function sortReady(a: TaskV2, b: TaskV2): number {
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.title.localeCompare(b.title)
}

function sortRunning(a: TaskV2, b: TaskV2): number {
  const aa = a.agent ?? ''
  const ba = b.agent ?? ''
  return aa.localeCompare(ba) || a.title.localeCompare(b.title)
}

function sortDone(a: TaskV2, b: TaskV2): number {
  const au = a.updated ?? a.created ?? ''
  const bu = b.updated ?? b.created ?? ''
  return bu.localeCompare(au)
}

const SORTERS: Record<keyof BoardColumns, (a: TaskV2, b: TaskV2) => number> = {
  blocked: sortBlocked,
  ready: sortReady,
  running: sortRunning,
  done: sortDone,
}

export function useTaskBoard(
  tasks: Map<string, TaskV2>,
  filteredTaskIds: Set<string>,
  mutate: TaskMutations,
) {
  const [dragTaskId, setDragTaskId] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<TaskState | null>(null)

  // Compute parent IDs (tasks that have children)
  const parentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const task of tasks.values()) {
      if (task.parent) ids.add(task.parent)
    }
    return ids
  }, [tasks])

  const columns = useMemo(() => {
    const cols: BoardColumns = { blocked: [], ready: [], running: [], done: [] }

    for (const [id, task] of tasks) {
      if (!filteredTaskIds.has(id)) continue
      if (parentIds.has(id)) continue // skip non-leaf
      if (task.state === 'cancelled') continue
      const col = cols[task.state as keyof BoardColumns]
      if (col) col.push(task)
    }

    for (const key of Object.keys(cols) as (keyof BoardColumns)[]) {
      cols[key].sort(SORTERS[key])
    }

    return cols
  }, [tasks, filteredTaskIds, parentIds])

  const onDragStart = useCallback((taskId: string) => {
    setDragTaskId(taskId)
  }, [])

  const onDragEnd = useCallback(() => {
    setDragTaskId(null)
    setDragOverColumn(null)
  }, [])

  const onDragEnterColumn = useCallback((state: TaskState) => {
    setDragOverColumn(state)
  }, [])

  const onDragLeaveColumn = useCallback(() => {
    setDragOverColumn(null)
  }, [])

  const onDropOnColumn = useCallback(async (targetState: TaskState, taskId: string) => {
    setDragTaskId(null)
    setDragOverColumn(null)
    const task = tasks.get(taskId)
    if (!task || task.state === targetState) return
    await mutate.updateTask(taskId, { state: targetState })
  }, [tasks, mutate])

  return {
    columns,
    parentIds,
    dragTaskId,
    dragOverColumn,
    onDragStart,
    onDragEnd,
    onDragEnterColumn,
    onDragLeaveColumn,
    onDropOnColumn,
  }
}
