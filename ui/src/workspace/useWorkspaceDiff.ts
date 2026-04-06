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

  // Fetch diffs for active paths. Re-runs on gitData change to pick up
  // new git state, but keeps stale data visible until the fetch completes
  // (no flash to "Loading...").
  useEffect(() => {
    const controllers: AbortController[] = []

    for (const path of pathsToFetch) {
      // On initial load, skip if already cached and not stale.
      // But always re-fetch when gitData changes — the effect dependency
      // array includes gitData, so we get a fresh closure each time.
      // We only skip if we already have data AND gitData hasn't changed
      // (which React guarantees by re-running the effect on gitData change).

      const controller = new AbortController()
      controllers.push(controller)

      // Set loading only if we don't have data yet (avoid flash)
      setCache(prev => {
        const current = prev[path]
        if (current?.parsed) return prev // keep showing stale data while re-fetching
        if (current?.loading) return prev
        return {
          ...prev,
          [path]: {
            raw: null,
            parsed: null,
            loading: true,
            error: false,
          },
        }
      })

      fetchGitDiff(projectName, path)
        .then(raw => {
          if (controller.signal.aborted) return
          setCache(prev => {
            // Skip update if raw diff hasn't changed (avoids re-render)
            if (prev[path]?.raw === raw) return prev
            const parsed = parseDiff(raw, path)
            return { ...prev, [path]: { raw, parsed, loading: false, error: false } }
          })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDiffPath, editorDiffPath, projectName, gitData])

  // Clean up cache entries when paths are no longer needed
  const prevPathsRef = useRef(pathsToFetch)
  useEffect(() => {
    const prev = prevPathsRef.current
    prevPathsRef.current = pathsToFetch
    const removed = [...prev].filter(p => !pathsToFetch.has(p))
    if (removed.length === 0) return
    setCache(prev => {
      const next = { ...prev }
      for (const p of removed) delete next[p]
      return next
    })
  }, [pathsToFetch])

  // Diff tab consumes this
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
