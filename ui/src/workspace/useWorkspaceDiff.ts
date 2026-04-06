import { useState, useEffect, useRef } from 'react'
import { fetchGitDiff } from '../hooks/useApi'
import { parseDiff, type DiffHunk } from '../lib/parseDiff'
import type { GitChange } from '../types'

export type DiffState = {
  content: string | null
  error: boolean
  loading: boolean
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

  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [editorDiffHunks, setEditorDiffHunks] = useState<DiffHunk[]>([])

  // Fetch diff when a diff tab is active
  useEffect(() => {
    if (!activeDiffPath) return
    const path = activeDiffPath
    let cancelled = false
    setDiffs(prev => {
      const current = prev[path]
      if (current?.loading) return prev
      return {
        ...prev,
        [path]: {
          content: current?.content ?? null,
          error: false,
          loading: true,
        },
      }
    })
    fetchGitDiff(projectName, path)
      .then(d => {
        if (cancelled) return
        setDiffs(prev => ({
          ...prev,
          [path]: { content: d, error: false, loading: false },
        }))
      })
      .catch(() => {
        if (cancelled) return
        setDiffs(prev => ({
          ...prev,
          [path]: { content: prev[path]?.content ?? null, error: true, loading: false },
        }))
      })
    return () => { cancelled = true }
  }, [activeDiffPath, projectName])

  // Fetch diff for active editor file (gutter indicators)
  const activeFileIsChanged = !!activeFilePath && changes.some(c => c.path === activeFilePath)
  const prevDiffFileRef = useRef(activeFilePath)
  useEffect(() => {
    if (prevDiffFileRef.current !== activeFilePath) {
      setEditorDiffHunks([])
      prevDiffFileRef.current = activeFilePath
    }
    if (!activeFilePath || !activeFileIsChanged) {
      setEditorDiffHunks([])
      return
    }
    let cancelled = false
    fetchGitDiff(projectName, activeFilePath)
      .then(diffText => {
        if (cancelled) return
        setEditorDiffHunks(parseDiff(diffText).hunks)
      })
      .catch(() => {
        if (cancelled) return
        setEditorDiffHunks([])
      })
    return () => { cancelled = true }
  }, [activeFilePath, activeFileIsChanged, projectName, gitData])

  const clearDiff = (path: string) => {
    setDiffs(prev => {
      if (!(path in prev)) return prev
      const next = { ...prev }
      delete next[path]
      return next
    })
  }

  return { diffs, editorDiffHunks, clearDiff }
}
