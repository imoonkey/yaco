import { useState, useEffect, useRef, useMemo } from 'react'
import { fetchGitDiff } from '../hooks/useApi'
import { parseDiff, type DiffHunk, type ParsedFileDiff } from '../lib/parseDiff'
import type { GitChange } from '../types'

export type DiffState = {
  raw: string | null
  parsed: ParsedFileDiff | null
  loading: boolean
  error: boolean
}

interface UseWorkspaceDiffOpts {
  activeDiffPath: string | null
  activeFilePath: string | null
  projectName: string
  changes: GitChange[]
  gitData: unknown // used as dependency trigger for re-fetch
}

export function useWorkspaceDiff(opts: UseWorkspaceDiffOpts) {
  const { activeDiffPath, activeFilePath, projectName, changes, gitData } = opts

  const [cache, setCache] = useState<Record<string, DiffState>>({})

  // Paths that need fetching: diff tab + editor gutter (if file is changed)
  const activeFileIsChanged = !!activeFilePath && changes.some(c => c.path === activeFilePath)
  const editorDiffPath = activeFileIsChanged ? activeFilePath : null

  // Deduplicated set of paths to keep in cache
  const pathsToFetch = useMemo(() => {
    const paths = new Set<string>()
    if (activeDiffPath) paths.add(activeDiffPath)
    if (editorDiffPath) paths.add(editorDiffPath)
    return paths
  }, [activeDiffPath, editorDiffPath])

  // Invalidate cache when git state changes so diffs are re-fetched
  const prevGitDataRef = useRef(gitData)
  useEffect(() => {
    if (prevGitDataRef.current === gitData) return
    prevGitDataRef.current = gitData
    // Clear all cached entries — the fetch effect will re-populate
    setCache({})
  }, [gitData])

  // Single effect that fetches all needed paths
  useEffect(() => {
    const controllers: AbortController[] = []

    for (const path of pathsToFetch) {
      // Skip if already loaded and not stale
      const existing = cache[path]
      if (existing && !existing.loading && !existing.error && existing.parsed) continue

      setCache(prev => {
        const current = prev[path]
        if (current?.loading) return prev
        return {
          ...prev,
          [path]: {
            raw: current?.raw ?? null,
            parsed: current?.parsed ?? null,
            loading: true,
            error: false,
          },
        }
      })

      const controller = new AbortController()
      controllers.push(controller)

      fetchGitDiff(projectName, path)
        .then(raw => {
          if (controller.signal.aborted) return
          const parsed = parseDiff(raw, path)
          setCache(prev => ({
            ...prev,
            [path]: { raw, parsed, loading: false, error: false },
          }))
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setCache(prev => ({
            ...prev,
            [path]: {
              raw: prev[path]?.raw ?? null,
              parsed: prev[path]?.parsed ?? null,
              loading: false,
              error: true,
            },
          }))
        })
    }

    return () => { controllers.forEach(c => c.abort()) }
    // gitData triggers re-fetch when git state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDiffPath, editorDiffPath, projectName, gitData])

  // Invalidate cache entries when paths are no longer needed
  const prevPathsRef = useRef(pathsToFetch)
  useEffect(() => {
    const prev = prevPathsRef.current
    prevPathsRef.current = pathsToFetch
    // Clean up paths that dropped out
    const removed = [...prev].filter(p => !pathsToFetch.has(p))
    if (removed.length === 0) return
    setCache(prev => {
      const next = { ...prev }
      for (const p of removed) delete next[p]
      return next
    })
  }, [pathsToFetch])

  // Diff tab consumes this (backward compat with WorkspaceEditorArea)
  const activeDiff = activeDiffPath ? cache[activeDiffPath] ?? null : null

  // Editor gutter consumes this
  const editorDiffHunks: DiffHunk[] = editorDiffPath
    ? cache[editorDiffPath]?.parsed?.hunks ?? []
    : []

  const clearDiff = (path: string) => {
    setCache(prev => {
      if (!(path in prev)) return prev
      const next = { ...prev }
      delete next[path]
      return next
    })
  }

  return { diffs: cache, activeDiff, editorDiffHunks, clearDiff }
}
