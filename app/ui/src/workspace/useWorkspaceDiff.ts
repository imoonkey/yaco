import { useState, useEffect, useRef, useMemo } from 'react'
import { fetchGitBaseline, fetchGitDiff } from '../hooks/useApi'
import { buildEditorBufferDiff } from '../lib/editorBufferDiff'
import { parseDiff, type DiffHunk, type ParsedFileDiff } from '../lib/parseDiff'
import { useThrottledValue } from '../hooks/useThrottledValue'

// The editor gutter recomputes from the live buffer; throttle that input so a large
// document isn't re-diffed on every keystroke (the diff-TAB path is unaffected — it
// keys off the diff tab id + git state, not the live buffer). Matches the preview.
const EDITOR_DIFF_THROTTLE_MS = 120

export type DiffState = {
  raw: string | null
  parsed: ParsedFileDiff | null
  loading: boolean
  error: boolean
}

interface UseWorkspaceDiffOpts {
  activeDiffPath: string | null
  activeFilePath: string | null
  activeFileContent: string | null
  projectName: string
  worktree?: string | null
  gitData: unknown // used as dependency trigger for re-fetch
  compareBase?: string | null
  compareHead?: string | null
}

type BaselineState = {
  content: string
  exists: boolean
  loaded: boolean
  loading: boolean
  error: boolean
}

export function useWorkspaceDiff(opts: UseWorkspaceDiffOpts) {
  const {
    activeDiffPath, activeFilePath, activeFileContent,
    projectName, worktree, gitData, compareBase, compareHead,
  } = opts

  const [cache, setCache] = useState<Record<string, DiffState>>({})
  const [baselineCache, setBaselineCache] = useState<Record<string, BaselineState>>({})

  // Cache key: include the worktree (so a switch re-points to that worktree's diff
  // instead of showing the previous one — and never collides across worktrees on the
  // same path) and the refs when present (so switching refs triggers a re-fetch).
  const activeDiffCacheKey = activeDiffPath
    ? `${worktree ?? ''}:${compareBase && compareHead ? `${compareBase}:${compareHead}:` : ''}${activeDiffPath}`
    : null

  const editorBaselineKey = activeFilePath
    ? `${projectName}:${worktree ?? ''}:${activeFilePath}`
    : null
  const activeFileContentReady = activeFileContent != null

  // Deduplicated set of cache keys to keep
  const keysToFetch = useMemo(() => {
    const keys = new Set<string>()
    if (activeDiffCacheKey) keys.add(activeDiffCacheKey)
    return keys
  }, [activeDiffCacheKey])

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

    for (const entry of fetchEntries) {
      const controller = new AbortController()
      controllers.push(controller)

      // Set loading only if we don't have data yet (avoid flash). Parsed diffs
      // arrive via the async fetchGitDiff().then below — this only flips loading.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
  }, [activeDiffCacheKey, projectName, worktree, gitData, compareBase, compareHead])

  // Fetch the HEAD baseline for the active editor file. The editor gutter is
  // computed from current buffer content vs this baseline, so unsaved edits and
  // saved working-tree edits use the same visible coordinate system.
  useEffect(() => {
    if (!activeFilePath || !editorBaselineKey || !activeFileContentReady) return
    const controller = new AbortController()

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBaselineCache(prev => {
      const current = prev[editorBaselineKey]
      if (current?.loading) return prev
      return {
        [editorBaselineKey]: {
          content: current?.content ?? '',
          exists: current?.exists ?? false,
          loaded: current?.loaded ?? false,
          loading: true,
          error: false,
        },
      }
    })

    fetchGitBaseline(projectName, activeFilePath, worktree)
      .then(result => {
        if (controller.signal.aborted) return
        setBaselineCache({
          [editorBaselineKey]: {
            content: result.content,
            exists: result.exists,
            loaded: true,
            loading: false,
            error: false,
          },
        })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setBaselineCache(prev => ({
          [editorBaselineKey]: {
            content: prev[editorBaselineKey]?.content ?? '',
            exists: prev[editorBaselineKey]?.exists ?? false,
            loaded: prev[editorBaselineKey]?.loaded ?? false,
            loading: false,
            error: true,
          },
        }))
      })

    return () => controller.abort()
  }, [activeFilePath, activeFileContentReady, editorBaselineKey, projectName, worktree, gitData])

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

  // Editor gutter consumes this. The buffer content is throttled so a large file is
  // re-diffed at most ~8/s while typing, not per keystroke; the live `draft` (and
  // every save/sync path) is unchanged. A null buffer is passed through untouched so
  // the "no content yet" guard still fires immediately.
  const throttledContent = useThrottledValue(activeFileContent, EDITOR_DIFF_THROTTLE_MS, activeFilePath)
  const editorDiffHunks = useMemo<DiffHunk[]>(() => {
    if (!activeFilePath || !editorBaselineKey || throttledContent == null) return []
    const baseline = baselineCache[editorBaselineKey]
    if (!baseline?.loaded) return []
    return buildEditorBufferDiff(activeFilePath, baseline.content, throttledContent, baseline.exists).hunks
  }, [activeFilePath, throttledContent, editorBaselineKey, baselineCache])

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
