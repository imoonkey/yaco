import { useState, useEffect, useCallback } from 'react'
import type { Project, Workstream, ProgressEntry, AgentSession, FileNode, GitChange, SessionProvider } from '../types'
import { useSSERefresh } from './useSSE'

export const API = '/api'
const FILE_TREE_FALLBACK_MS = 60_000
const fileTreeCache = new Map<string, FileNode[]>()
const fileTreeInflight = new Map<string, Promise<FileNode[]>>()

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

async function fetchFileTree(projectName: string): Promise<FileNode[]> {
  const existing = fileTreeInflight.get(projectName)
  if (existing) return existing

  const request = fetchJson<FileNode[]>(`/files/${encodeURIComponent(projectName)}`)
    .then((tree) => {
      fileTreeCache.set(projectName, tree)
      return tree
    })
    .finally(() => {
      fileTreeInflight.delete(projectName)
    })

  fileTreeInflight.set(projectName, request)
  return request
}

/** Generic polling hook with optional SSE-triggered refresh */
function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, sseChannel?: string): { data: T | null; error: Error | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick(t => t + 1), [])

  // Wire SSE refresh signal to immediate re-fetch
  useSSERefresh(sseChannel ?? '', refresh)

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
  return usePolling(fetcher, 60_000, 'projects')
}

export function useWorkstreams() {
  const fetcher = useCallback(() => fetchJson<Workstream[]>('/workstreams'), [])
  return usePolling(fetcher, 30_000, 'workstreams')
}

export function useProgress() {
  const fetcher = useCallback(() => fetchJson<ProgressEntry[]>('/progress'), [])
  return usePolling(fetcher, 30_000, 'progress')
}

export function useSessions(projectName?: string | null) {
  const fetcher = useCallback(
    () => fetchJson<AgentSession[]>(projectName ? `/sessions?project=${encodeURIComponent(projectName)}` : '/sessions'),
    [projectName]
  )
  return usePolling(fetcher, 30_000, 'sessions')
}

export function useFileTree(projectName: string | null) {
  const [data, setData] = useState<FileNode[] | null>(() => (
    projectName ? (fileTreeCache.get(projectName) ?? null) : []
  ))
  const [error, setError] = useState<Error | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick(t => t + 1), [])

  // SSE-triggered refresh for file tree changes
  useSSERefresh('filetree', refresh)

  useEffect(() => {
    if (!projectName) {
      setData([])
      setError(null)
      return
    }

    setData(fileTreeCache.get(projectName) ?? null)
    setError(null)
  }, [projectName])

  useEffect(() => {
    if (!projectName) return

    let cancelled = false
    const load = async () => {
      try {
        const result = await fetchFileTree(projectName)
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e as Error)
      }
    }

    const refreshOnForeground = () => {
      if (!document.hidden) void load()
    }

    void load()
    const id = window.setInterval(() => { void load() }, FILE_TREE_FALLBACK_MS)
    window.addEventListener('focus', refreshOnForeground)
    document.addEventListener('visibilitychange', refreshOnForeground)

    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', refreshOnForeground)
      document.removeEventListener('visibilitychange', refreshOnForeground)
    }
  }, [projectName, tick])

  return { data, error, refresh }
}

export function useFileContent(projectName: string | null, filePath: string | null) {
  const [content, setContent] = useState<string | null>(null)
  const [revision, setRevision] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!projectName || !filePath) { setContent(null); setRevision(null); return }
    let cancelled = false
    setLoading(true)
    fetchJson<{ content: string; revision: number }>(`/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`)
      .then(r => { if (!cancelled) { setContent(r.content); setRevision(r.revision) } })
      .catch(() => { if (!cancelled) { setContent(null); setRevision(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectName, filePath])

  return { content, revision, loading }
}

export async function dismissProgress(project: string, workstream: string, id: string): Promise<void> {
  const ws = workstream || '_'
  await postJson(`/progress/${encodeURIComponent(project)}/${encodeURIComponent(ws)}/${encodeURIComponent(id)}/dismiss`)
}

export async function updateWorkstreamStatus(project: string, workstreamId: string, status: string): Promise<void> {
  await postJson(`/workstreams/${encodeURIComponent(project)}/${encodeURIComponent(workstreamId)}/status`, { status })
}

export async function addProject(name: string, path: string): Promise<void> {
  await postJson('/projects', { name, path })
}

export async function reorderProjects(order: string[]): Promise<Project[]> {
  return postJson<Project[]>('/projects/reorder', { order })
}

export async function startSession(provider: SessionProvider, projectPath: string): Promise<string> {
  const name = provider === 'shell' ? undefined : `${provider}-${Date.now().toString(36)}`
  const result = await postJson<{ ok: true; name: string }>('/sessions/start', { provider, name, cwd: projectPath })
  return result.name
}

export async function closeSession(name: string): Promise<void> {
  await postJson(`/sessions/${encodeURIComponent(name)}/close`)
}

export async function saveFileContent(projectName: string, filePath: string, content: string, baseRevision?: number): Promise<{ revision: number }> {
  const res = await fetch(`${API}/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseRevision }),
  })
  if (res.status === 409) {
    const body = await res.json() as { error: string; currentRevision: number }
    const err = new Error('revision conflict') as Error & { status: number; currentRevision: number }
    err.status = 409
    err.currentRevision = body.currentRevision
    throw err
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export async function createFile(projectName: string, path: string): Promise<void> {
  await postJson(`/files/${encodeURIComponent(projectName)}/create-file`, { path })
}

export async function createDir(projectName: string, path: string): Promise<void> {
  await postJson(`/files/${encodeURIComponent(projectName)}/create-dir`, { path })
}

export async function moveFile(projectName: string, sourcePath: string, destDir: string): Promise<string> {
  const r = await postJson<{ newPath: string }>(`/files/${encodeURIComponent(projectName)}/move`, { sourcePath, destDir })
  return r.newPath
}

export async function renameFile(projectName: string, oldPath: string, newPath: string): Promise<void> {
  await postJson(`/files/${encodeURIComponent(projectName)}/rename`, { oldPath, newPath })
}

export async function deleteFile(projectName: string, path: string): Promise<void> {
  await postJson(`/files/${encodeURIComponent(projectName)}/delete`, { path })
}

// --- Git ---

export interface GitStatusResponse {
  changes: GitChange[]
  stale: boolean
}

export function useGitStatus(projectName: string | null) {
  const fetcher = useCallback(
    () => projectName ? fetchJson<GitStatusResponse>(`/git/${encodeURIComponent(projectName)}/status`) : Promise.resolve({ changes: [], stale: false }),
    [projectName]
  )
  return usePolling(fetcher, 30_000, 'git')
}

export async function fetchGitDiff(projectName: string, filePath: string): Promise<string> {
  const r = await fetchJson<{ diff: string }>(`/git/${encodeURIComponent(projectName)}/diff?path=${encodeURIComponent(filePath)}`)
  return r.diff
}
