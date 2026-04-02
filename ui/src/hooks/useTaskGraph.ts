import { useState, useEffect, useRef } from 'react'
import { API, useSSETick } from './useApi'
import { buildTaskGraphModel, type RawTaskMap, type TaskGraphModel } from '../tasks/taskGraphModel'

export const TASKS_FILE_PATH = 'doc/todo/tasks.json'

export type UseTaskGraphResult = {
  status: 'loading' | 'ready' | 'missing' | 'error'
  graph: TaskGraphModel | null
  data: TaskGraphModel | null
  error: Error | null
  loading: boolean
  warnings: string[]
  refresh: () => void
}

const POLL_INTERVAL = 60_000

export function useTaskGraph(projectName: string): UseTaskGraphResult {
  const [graph, setGraph] = useState<TaskGraphModel | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  const { tick, refresh } = useSSETick('filetree')
  const initialLoad = useRef(true)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      if (initialLoad.current) {
        setStatus('loading')
        initialLoad.current = false
      }
      try {
        const res = await fetch(
          `${API}/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(TASKS_FILE_PATH)}`
        )
        if (!res.ok) {
          if (res.status === 403 || res.status === 404) {
            if (!cancelled) {
              setGraph(null)
              setWarnings([])
              setError(null)
              setStatus('missing')
            }
            return
          }
          throw new Error(`${res.status} ${res.statusText}`)
        }
        const data = await res.json() as { content: string }
        const raw: RawTaskMap = JSON.parse(data.content)

        const { model, warnings: w } = buildTaskGraphModel(raw)
        if (!cancelled) {
          setGraph(model)
          setWarnings(w)
          setError(null)
          setStatus('ready')
        }
      } catch (e) {
        if (!cancelled) {
          setGraph(null)
          setWarnings([])
          setError(e as Error)
          setStatus('error')
        }
      }
    }

    void load()
    const id = setInterval(load, POLL_INTERVAL)
    return () => { cancelled = true; clearInterval(id) }
  }, [projectName, tick])

  return { status, graph, data: graph, error, loading: status === 'loading', warnings, refresh }
}
