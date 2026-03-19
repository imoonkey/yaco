import { useState, useEffect, useCallback } from 'react'
import type { Project, Workstream, ProgressEntry, AgentSession, FileNode, GitChange } from '../types'

const API = '/api'

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

/** Generic polling hook */
function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number): { data: T | null; error: Error | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await fetcher()
        if (!cancelled) { setData(result); setError(null) }
      } catch (e) {
        if (!cancelled) setError(e as Error)
      }
    }
    load()
    const id = setInterval(load, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [fetcher, intervalMs, tick])

  return { data, error, refresh }
}

export function useProjects() {
  const fetcher = useCallback(() => fetchJson<Project[]>('/projects'), [])
  return usePolling(fetcher, 30_000)
}

export function useWorkstreams() {
  const fetcher = useCallback(() => fetchJson<Workstream[]>('/workstreams'), [])
  return usePolling(fetcher, 5_000)
}

export function useProgress() {
  const fetcher = useCallback(() => fetchJson<ProgressEntry[]>('/progress'), [])
  return usePolling(fetcher, 3_000)
}

export function useSessions() {
  const fetcher = useCallback(() => fetchJson<AgentSession[]>('/sessions'), [])
  return usePolling(fetcher, 3_000)
}

export function useFileTree(projectName: string | null) {
  const fetcher = useCallback(
    () => projectName ? fetchJson<FileNode[]>(`/files/${encodeURIComponent(projectName)}`) : Promise.resolve([]),
    [projectName]
  )
  return usePolling(fetcher, 30_000)
}

export function useFileContent(projectName: string | null, filePath: string | null) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!projectName || !filePath) { setContent(null); return }
    let cancelled = false
    setLoading(true)
    fetchJson<{ content: string }>(`/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`)
      .then(r => { if (!cancelled) setContent(r.content) })
      .catch(() => { if (!cancelled) setContent(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectName, filePath])

  return { content, loading }
}

export async function dismissProgress(project: string, workstream: string, id: string): Promise<void> {
  await postJson(`/progress/${encodeURIComponent(project)}/${encodeURIComponent(workstream)}/${encodeURIComponent(id)}/dismiss`)
}

export async function updateWorkstreamStatus(project: string, workstreamId: string, status: string): Promise<void> {
  await postJson(`/workstreams/${encodeURIComponent(project)}/${encodeURIComponent(workstreamId)}/status`, { status })
}

export async function addProject(name: string, path: string): Promise<void> {
  await postJson('/projects', { name, path })
}

export async function startSession(provider: 'claude' | 'codex', projectPath: string): Promise<void> {
  const name = `${provider}-${Date.now().toString(36)}`
  await postJson('/sessions/start', { provider, name, cwd: projectPath })
}

export async function saveFileContent(projectName: string, filePath: string, content: string): Promise<void> {
  const res = await fetch(`${API}/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
}

// --- Git ---

export function useGitStatus(projectName: string | null) {
  const fetcher = useCallback(
    () => projectName ? fetchJson<GitChange[]>(`/git/${encodeURIComponent(projectName)}/status`) : Promise.resolve([]),
    [projectName]
  )
  return usePolling(fetcher, 5_000)
}

export async function fetchGitDiff(projectName: string, filePath: string): Promise<string> {
  const r = await fetchJson<{ diff: string }>(`/git/${encodeURIComponent(projectName)}/diff?path=${encodeURIComponent(filePath)}`)
  return r.diff
}
