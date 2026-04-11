import { useState, useEffect, useCallback } from 'react'
import { useSSERefresh } from '../../hooks/useSSE'
import { ApiError } from '../../lib/apiError'
import type { RawTaskV2 } from '../model/taskModel'

const API = '/api'
const POLL_INTERVAL = 60_000

export type ArchivedTaskGroup = {
  file: string
  date: string
  tasks: Record<string, RawTaskV2>
}

export type UseArchiveDataResult = {
  archives: ArchivedTaskGroup[]
  loading: boolean
  error: Error | null
  refresh: () => void
}

export function useArchiveData(projectName: string): UseArchiveDataResult {
  const [archives, setArchives] = useState<ArchivedTaskGroup[]>([])
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick(t => t + 1), [])
  useSSERefresh('filetree', refresh)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(
          `${API}/tasks/${encodeURIComponent(projectName)}/archive`
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new ApiError(res.status, body)
        }
        const data: { archives: ArchivedTaskGroup[] } = await res.json()
        if (!cancelled) {
          setArchives(data.archives)
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

  return { archives, loading, error, refresh }
}
