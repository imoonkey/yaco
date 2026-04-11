import { useState, useEffect, useCallback, useRef } from 'react'
import { useSSERefresh } from '../../hooks/useSSE'
import { ApiError } from '../../lib/apiError'
import { normalizeTaskMap, type TaskV2, type RawTaskV2 } from '../model/taskModel'
import { toast } from 'sonner'

const API = '/api'
const POLL_INTERVAL = 60_000

type TaskMutations = {
  updateTask: (id: string, patch: Partial<RawTaskV2>) => Promise<void>
  createTask: (id: string, task: RawTaskV2) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  bulkUpdate: (ids: string[], patch: Partial<RawTaskV2>) => Promise<void>
}

export type UseTaskDataResult = {
  tasks: Map<string, TaskV2>
  loading: boolean
  error: Error | null
  refresh: () => void
  mutate: TaskMutations
}

async function fetchApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
  return res.json()
}

export function useTaskData(projectName: string): UseTaskDataResult {
  const [tasks, setTasks] = useState<Map<string, TaskV2>>(new Map())
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const initialLoad = useRef(true)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick(t => t + 1), [])
  useSSERefresh('filetree', refresh)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      if (initialLoad.current) {
        setLoading(true)
        initialLoad.current = false
      }
      try {
        const res = await fetchApi<{ tasks: Record<string, RawTaskV2> }>(
          `/tasks/${encodeURIComponent(projectName)}`
        )
        if (!cancelled) {
          setTasks(normalizeTaskMap(res.tasks))
          setError(null)
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)))
          setLoading(false)
        }
      }
    }

    void load()
    const id = setInterval(load, POLL_INTERVAL)
    return () => { cancelled = true; clearInterval(id) }
  }, [projectName, tick])

  const base = `/tasks/${encodeURIComponent(projectName)}`

  const updateTask = useCallback(async (id: string, patch: Partial<RawTaskV2>) => {
    const prev = new Map(tasks)
    // Optimistic: merge patch into existing task
    const existing = tasks.get(id)
    if (existing) {
      setTasks(new Map(tasks).set(id, { ...existing, ...patch }))
    }
    try {
      await fetchApi(`${base}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    } catch (e) {
      setTasks(prev)
      toast.error(e instanceof Error ? e.message : 'Failed to update task')
    }
  }, [tasks, base])

  const createTask = useCallback(async (id: string, task: RawTaskV2) => {
    const prev = new Map(tasks)
    // Optimistic: add normalized task
    const { normalizeTask } = await import('../model/taskModel')
    setTasks(new Map(tasks).set(id, normalizeTask(id, task)))
    try {
      await fetchApi(`${base}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task),
      })
    } catch (e) {
      setTasks(prev)
      toast.error(e instanceof Error ? e.message : 'Failed to create task')
    }
  }, [tasks, base])

  const deleteTask = useCallback(async (id: string) => {
    const prev = new Map(tasks)
    const next = new Map(tasks)
    next.delete(id)
    setTasks(next)
    try {
      await fetchApi(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    } catch (e) {
      setTasks(prev)
      toast.error(e instanceof Error ? e.message : 'Failed to delete task')
    }
  }, [tasks, base])

  const bulkUpdate = useCallback(async (ids: string[], patch: Partial<RawTaskV2>) => {
    const prev = new Map(tasks)
    const next = new Map(tasks)
    for (const id of ids) {
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, ...patch })
    }
    setTasks(next)
    try {
      await fetchApi(`${base}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, patch }),
      })
    } catch (e) {
      setTasks(prev)
      toast.error(e instanceof Error ? e.message : 'Failed to bulk update tasks')
    }
  }, [tasks, base])

  return {
    tasks,
    loading,
    error,
    refresh,
    mutate: { updateTask, createTask, deleteTask, bulkUpdate },
  }
}
