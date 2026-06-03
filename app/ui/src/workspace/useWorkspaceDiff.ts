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
  worktree?: string | null
  changes: GitChange[]
  gitData: unknown // used as dependency trigger for re-fetch
  compareBase?: string | null
  compareHead?: string | null
}

export function useWorkspaceDiff(opts: UseWorkspaceDiffOpts) {
  const { activeDiffPath, activeFilePath, projectName, worktree, changes, gitData, compareBase, compareHead } = opts

  const [cache, setCache] = useState<Record<string, DiffState>>({})

  // Cache key: include refs when present so switching refs triggers re-fetch
  const activeDiffCacheKey = activeDiffPath
    ? (compareBase && compareHead ? `${compareBase}:${compareHead}:${activeDiffPath}` : activeDiffPath)
    : null

  // Paths that need fetching: diff tab + editor gutter (if file is changed)
  const activeFileIsChanged = !!activeFilePath && changes.some(c => c.path === activeFilePath)
  const editorDiffPath = activeFileIsChanged ? activeFilePath : null

  // Deduplicated set of cache keys to keep
  const keysToFetch = useMemo(() => {
    const keys = new Set<string>()
    if (activeDiffCacheKey) keys.add(activeDiffCacheKey)
    if (editorDiffPath) keys.add(editorDiffPath)
    return keys
  }, [activeDiffCacheKey, editorDiffPath])

  // Fetch diffs for active paths. Re-runs on gitData change to pick up
  // new git state, but keeps stale data visible until the fetch completes
  // (no flash to "Loading...").
  useEffect(() => {
    const controllers: AbortController[] = []

    // Build a map from cache key to { path, base?, compare? } for fetching
    const fetchEntries: { key: string; path: string; base?: string; compare?: string }[] = []
    if (activeDiffCacheKey && activeDiffPath) {
      fetchEntries.push({
        key: activeDiffCacheKey,
        path: activeDiffPath,
        base: compareBase ?? undefined,
        compare: compareHead ?? undefined,
      })
    }
    if (editorDiffPath && editorDiffPath !== activeDiffCacheKey) {
      fetchEntries.push({ key: editorDiffPath, path: editorDiffPath })
    }

    for (const entry of fetchEntries) {
      const controller = new AbortController()
      controllers.push(controller)

      // Set loading only if we don't have data yet (avoid flash)
      setCache(prev => {
        const current = prev[entry.key]
        if (current?.parsed) return prev // keep showing stale data while re-fetching
        if (current?.loading) return prev
        return {
          ...prev,
          [entry.key]: {
            raw: null,
            parsed: null,
            loading: true,
            error: false,
          },
        }
      })

      fetchGitDiff(projectName, entry.path, entry.base, entry.compare, worktree)
        .then(raw => {
          if (controller.signal.aborted) return
          setCache(prev => {
            // Skip update if raw diff hasn't changed (avoids re-render)
            if (prev[entry.key]?.raw === raw) return prev
            const parsed = parseDiff(raw, entry.path)
            return { ...prev, [entry.key]: { raw, parsed, loading: false, error: false } }
          })
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setCache(prev => ({
            ...prev,
            [entry.key]: {
              raw: prev[entry.key]?.raw ?? null,
              parsed: prev[entry.key]?.parsed ?? null,
              loading: false,
              error: true,
            },
          }))
        })
    }

    return () => { controllers.forEach(c => c.abort()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDiffCacheKey, editorDiffPath, projectName, worktree, gitData, compareBase, compareHead])

  // Clean up cache entries when keys are no longer needed
  const prevKeysRef = useRef(keysToFetch)
  useEffect(() => {
    const prev = prevKeysRef.current
    prevKeysRef.current = keysToFetch
    const removed = [...prev].filter(p => !keysToFetch.has(p))
    if (removed.length === 0) return
    setCache(prev => {
      const next = { ...prev }
      for (const p of removed) delete next[p]
      return next
    })
  }, [keysToFetch])

  // Diff tab consumes this (look up by cache key which includes refs)
  const activeDiff = activeDiffCacheKey ? cache[activeDiffCacheKey] ?? null : null

  // Editor gutter consumes this
  const editorDiffHunks: DiffHunk[] = editorDiffPath
    ? cache[editorDiffPath]?.parsed?.hunks ?? []
    : []

  const clearDiff = (key: string) => {
    setCache(prev => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  return { diffs: cache, activeDiff, editorDiffHunks, clearDiff }
}
