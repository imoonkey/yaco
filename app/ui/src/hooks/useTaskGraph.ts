import { useState, useEffect, useRef, useCallback } from 'react'
import { API } from './useApi'
import { useSSERefresh } from './useSSE'
import { buildTaskGraphModel, type RawTaskMap, type TaskGraphModel } from '../tasks/taskGraphModel'

export const TASKS_FILE_PATH = 'plan/tasks/inbox/tasks.json'

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

  // Ordered fetch results without cancellation. `seqRef` stamps each fetch as it
  // starts; `committedRef` is the highest stamp already applied. A fetch commits the
  // moment it resolves UNLESS a newer fetch already committed — so the first response
  // paints the graph immediately, and rapid `filetree` refreshes can only move the
  // data forward. The previous approach put the SSE tick in the effect deps, so every
  // refresh restarted the effect and cancelled the in-flight fetch; under filetree
  // churn (e.g. on workspace re-open) the request kept restarting and the task view
  // never repainted in time. Mirrors usePolling's seq guard in useApi.
  const seqRef = useRef(0)
  const committedRef = useRef(0)
  // True once a good graph has painted for the CURRENT project (reset on project
  // change). The seq guard above orders GOOD results; this extends the same
  // "refreshes only move data forward" invariant to failures: a transient
  // error/missing from a later refetch must NOT roll the painted graph back to an
  // error pane. On the tree engine the task view mounts amid an always-on
  // `filetree` SSE burst, so the graph is refetched repeatedly right after it
  // paints; a single hiccup (`yaco task list` failing, or a 404 while the project
  // registry is mid-rewrite) would otherwise blank the panel — and the e2e's 4s
  // auto-restore probe then fails, its fallback Meta+Shift+t closing the tab.
  const committedGoodRef = useRef(false)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const res = await fetch(`${API}/tasks/${encodeURIComponent(projectName)}`)
      if (seq <= committedRef.current) return
      if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
          // 'missing' is a real state on the initial load, but a transient 404
          // during churn must not unpaint an already-good graph.
          if (committedGoodRef.current) return
          setGraph(null)
          setWarnings([])
          setError(null)
          setStatus('missing')
          return
        }
        throw new Error(`${res.status} ${res.statusText}`)
      }
      const data = await res.json() as { tasks: RawTaskMap }
      if (seq <= committedRef.current) return

      const { model, warnings: w } = buildTaskGraphModel(data.tasks)
      committedRef.current = seq
      committedGoodRef.current = true
      setGraph(model)
      setWarnings(w)
      setError(null)
      setStatus('ready')
    } catch (e) {
      // A failed fetch is not data: never roll back a painted graph, and never
      // advance committedRef (doing so would also block a good in-flight fetch
      // with a lower seq from committing). Surface the error only on initial load.
      if (committedGoodRef.current || seq <= committedRef.current) return
      setGraph(null)
      setWarnings([])
      setError(e as Error)
      setStatus('error')
    }
  }, [projectName])

  // SSE refreshes call load() directly — they never restart the effect, so an
  // in-flight fetch finishes and commits instead of being cancelled.
  useSSERefresh('filetree', () => { void load() })

  useEffect(() => {
    // New project (or mount): supersede any prior in-flight fetch so its late result
    // cannot overwrite this project's data, and clear the good-graph latch so the
    // first failure for this project still surfaces an error/missing pane.
    committedRef.current = seqRef.current
    committedGoodRef.current = false
    // load() sets state only after its await — no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    const id = setInterval(() => { void load() }, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [load])

  return { status, graph, data: graph, error, loading: status === 'loading', warnings, refresh: load }
}
