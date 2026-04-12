import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, ProgressEntry, AgentSession, FileNode, GitChange, SessionProvider, HistorySession } from '../types'
import { useSSERefresh } from './useSSE'
import { ApiError } from '../lib/apiError'

export const API = '/api'
const FILE_TREE_FALLBACK_MS = 60_000

/** Append ?worktree=slug (or &worktree=slug) to a URL when worktree is active */
export function appendWorktree(url: string, worktree?: string | null): string {
  if (!worktree) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}worktree=${encodeURIComponent(worktree)}`
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API}${path}`, signal ? { signal } : undefined)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
  return res.json()
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const resBody = await res.json().catch(() => ({}))
    throw new ApiError(res.status, resBody)
  }
  return res.json()
}

/** Run async fn over items in batches to limit concurrency */
async function batchMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = 6): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    const batch = await Promise.all(items.slice(i, i + limit).map(fn))
    results.push(...batch)
  }
  return results
}

export type AsyncData<T> = { data: T | null; error: Error | null; loading: boolean }

/** SSE-triggered tick counter for manual fetch loops */
export function useSSETick(sseChannel: string): { tick: number; refresh: () => void } {
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(t => t + 1), [])
  useSSERefresh(sseChannel, refresh)
  return { tick, refresh }
}

/** Generic polling hook with optional SSE-triggered refresh */
function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, sseChannel?: string): AsyncData<T> & { refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick(t => t + 1), [])

  // Wire SSE refresh signal to immediate re-fetch
  useSSERefresh(sseChannel ?? '', refresh)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await fetcher()
        if (!cancelled) { setData(result); setError(null); setLoading(false) }
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e : new Error(String(e))); setLoading(false) }
      }
    }
    load()
    const id = setInterval(load, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [fetcher, intervalMs, tick])

  return { data, error, loading, refresh }
}

export function useProjects() {
  const fetcher = useCallback(() => fetchJson<Project[]>('/projects'), [])
  return usePolling(fetcher, 60_000, 'projects')
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

export function useFileTree(projectName: string | null, worktree?: string | null) {
  const [data, setData] = useState<FileNode[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const loadedDirsRef = useRef(new Set<string>())
  const refreshAbortRef = useRef<AbortController | null>(null)

  // Fetch root-level entries
  const loadRoot = useCallback(async () => {
    if (!projectName) { setData([]); return }
    try {
      const root = await fetchJson<FileNode[]>(appendWorktree(`/files/${encodeURIComponent(projectName)}`, worktree))
      setData(root)
      setError(null)
      loadedDirsRef.current.clear()
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    }
  }, [projectName, worktree])

  // Initial load + project change
  useEffect(() => { void loadRoot() }, [loadRoot])

  // Helper: merge children into tree at a given dir path
  const mergeChildren = useCallback((dirPath: string, children: FileNode[]) => {
    setData(prev => {
      if (!prev) return prev
      return updateNodeChildren(prev, dirPath, children)
    })
  }, [])

  // Expand a directory: fetch its children and merge into tree
  const expandDir = useCallback(async (dirPath: string) => {
    if (!projectName || loadedDirsRef.current.has(dirPath)) return
    loadedDirsRef.current.add(dirPath)
    try {
      const children = await fetchJson<FileNode[]>(
        appendWorktree(`/files/${encodeURIComponent(projectName)}/children?dir=${encodeURIComponent(dirPath)}`, worktree)
      )
      mergeChildren(dirPath, children)
    } catch (e) {
      console.warn(`useFileTree: failed to expand dir "${dirPath}"`, e)
      loadedDirsRef.current.delete(dirPath)
    }
  }, [projectName, worktree, mergeChildren])

  // SSE refresh: reload root + all expanded dirs
  const refreshExpanded = useCallback(async () => {
    if (!projectName) return

    // Abort any in-flight refresh cycle
    refreshAbortRef.current?.abort()
    const ac = new AbortController()
    refreshAbortRef.current = ac

    try {
      const root = await fetchJson<FileNode[]>(
        appendWorktree(`/files/${encodeURIComponent(projectName)}`, worktree), ac.signal
      )
      // Re-fetch expanded dirs in batches of 6
      const dirs = [...loadedDirsRef.current]
      const results = await batchMap(dirs, async (dirPath) => {
        try {
          return { dirPath, children: await fetchJson<FileNode[]>(
            appendWorktree(`/files/${encodeURIComponent(projectName)}/children?dir=${encodeURIComponent(dirPath)}`, worktree),
            ac.signal
          )}
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') throw e
          loadedDirsRef.current.delete(dirPath)
          return null
        }
      })
      // Build the tree: start from root, merge in all expanded dirs
      let tree = root
      for (const r of results) {
        if (r) tree = updateNodeChildren(tree, r.dirPath, r.children)
      }
      setData(tree)
      setError(null)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(e instanceof Error ? e : new Error(String(e)))
    }
  }, [projectName, worktree])

  useSSERefresh('filetree', refreshExpanded)

  // Foreground refresh
  useEffect(() => {
    const onForeground = () => { if (!document.hidden) void refreshExpanded() }
    window.addEventListener('focus', onForeground)
    document.addEventListener('visibilitychange', onForeground)
    const id = window.setInterval(() => { void refreshExpanded() }, FILE_TREE_FALLBACK_MS)
    return () => {
      window.removeEventListener('focus', onForeground)
      document.removeEventListener('visibilitychange', onForeground)
      window.clearInterval(id)
      refreshAbortRef.current?.abort()
    }
  }, [refreshExpanded])

  const clearLoadedDirs = useCallback(() => { loadedDirsRef.current.clear() }, [])

  return { data, error, refresh: refreshExpanded, expandDir, patchTree: setData, clearLoadedDirs }
}

/** Recursively replace children of a dir node at the given path */
function updateNodeChildren(nodes: FileNode[], dirPath: string, children: FileNode[]): FileNode[] {
  return nodes.map(node => {
    if (node.path === dirPath && node.type === 'dir') {
      return { ...node, children }
    }
    if (node.children && node.children.length > 0) {
      return { ...node, children: updateNodeChildren(node.children, dirPath, children) }
    }
    return node
  })
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

export async function addProject(name: string, path: string): Promise<void> {
  await postJson('/projects', { name, path })
}

export async function removeProject(name: string): Promise<void> {
  const res = await fetch(`${API}/projects/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
}

export async function reorderProjects(order: string[]): Promise<Project[]> {
  return postJson<Project[]>('/projects/reorder', { order })
}

export async function startSession(provider: SessionProvider, projectPath: string, resumeId?: string, name?: string): Promise<string> {
  const resolvedName = name ?? (provider === 'shell' ? undefined : `${provider}-${Date.now().toString(36)}`)
  const result = await postJson<{ name: string }>('/sessions/start', {
    provider,
    name: resolvedName,
    cwd: projectPath,
    ...(resumeId ? { resumeId } : {}),
  })
  return result.name
}

export async function closeSession(name: string): Promise<void> {
  await postJson(`/sessions/${encodeURIComponent(name)}/close`)
}

export async function renameSession(name: string, newName: string, cwd: string): Promise<void> {
  await postJson(`/sessions/${encodeURIComponent(name)}/rename`, { name: newName, cwd })
}

export async function saveFileContent(projectName: string, filePath: string, content: string, baseRevision?: number, worktree?: string | null): Promise<{ revision: number }> {
  const res = await fetch(`${API}${appendWorktree(`/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`, worktree)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseRevision }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
  return res.json()
}

export async function createFile(projectName: string, path: string, worktree?: string | null): Promise<void> {
  await postJson(appendWorktree(`/files/${encodeURIComponent(projectName)}/create-file`, worktree), { path })
}

export async function createDir(projectName: string, path: string, worktree?: string | null): Promise<void> {
  await postJson(appendWorktree(`/files/${encodeURIComponent(projectName)}/create-dir`, worktree), { path })
}

export async function moveFile(projectName: string, sourcePath: string, destDir: string, worktree?: string | null): Promise<string> {
  const r = await postJson<{ newPath: string }>(appendWorktree(`/files/${encodeURIComponent(projectName)}/move`, worktree), { sourcePath, destDir })
  return r.newPath
}

export async function renameFile(projectName: string, oldPath: string, newPath: string, worktree?: string | null): Promise<void> {
  await postJson(appendWorktree(`/files/${encodeURIComponent(projectName)}/rename`, worktree), { oldPath, newPath })
}

export async function deleteFile(projectName: string, path: string, worktree?: string | null): Promise<void> {
  await postJson(appendWorktree(`/files/${encodeURIComponent(projectName)}/delete`, worktree), { path })
}

export async function revealInFinder(projectName: string, path: string, worktree?: string | null): Promise<void> {
  await postJson(appendWorktree(`/files/${encodeURIComponent(projectName)}/reveal`, worktree), { path })
}

// --- Browse ---

export interface BrowseEntry {
  name: string
  path: string
  isGit: boolean
}

export async function browseDirs(prefix: string): Promise<BrowseEntry[]> {
  const res = await fetchJson<{ entries: BrowseEntry[] }>(`/browse?prefix=${encodeURIComponent(prefix)}`)
  return res.entries
}

// --- Git ---

export interface GitStatusResponse {
  changes: GitChange[]
  stale: boolean
  stats?: { added: number; deleted: number }
}

export function useGitStatus(projectName: string | null, worktree?: string | null) {
  const fetcher = useCallback(
    () => projectName ? fetchJson<GitStatusResponse>(appendWorktree(`/git/${encodeURIComponent(projectName)}/status`, worktree)) : Promise.resolve({ changes: [], stale: false }),
    [projectName, worktree]
  )
  return usePolling(fetcher, 30_000, 'git')
}

export function useHistory(projectName: string | null): AsyncData<HistorySession[]> & { refresh: () => void } {
  const [data, setData] = useState<HistorySession[] | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!projectName) { setData(null); return }
    setLoading(true)
    try {
      const result = await fetchJson<HistorySession[]>(`/sessions/history?project=${encodeURIComponent(projectName)}`)
      setData(result)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [projectName])

  return { data, error, loading, refresh }
}

export async function fetchGitDiff(projectName: string, filePath: string, base?: string, compare?: string, worktree?: string | null): Promise<string> {
  let url = `/git/${encodeURIComponent(projectName)}/diff?path=${encodeURIComponent(filePath)}`
  if (base) url += `&base=${encodeURIComponent(base)}`
  if (compare) url += `&compare=${encodeURIComponent(compare)}`
  const r = await fetchJson<{ diff: string }>(appendWorktree(url, worktree))
  return r.diff
}

export interface GitRefsResult {
  branches: string[]
  tags: string[]
  recentCommits: { hash: string; subject: string; date: string; author: string }[]
}

export async function fetchGitRefs(projectName: string): Promise<GitRefsResult> {
  return fetchJson<GitRefsResult>(`/git/${encodeURIComponent(projectName)}/refs`)
}

export async function fetchGitCompare(projectName: string, base: string, compare: string, worktree?: string | null): Promise<{ files: GitChange[]; stats: { added: number; deleted: number } }> {
  return fetchJson(appendWorktree(`/git/${encodeURIComponent(projectName)}/compare?base=${encodeURIComponent(base)}&compare=${encodeURIComponent(compare)}`, worktree))
}
