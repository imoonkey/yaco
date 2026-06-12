import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useSSERefresh } from './useSSE'
import { API, appendWorktree } from './useApi'
import { ApiError } from '../lib/apiError'
import {
  type FileState,
  type PersistedDrafts,
  isFileTab,
  defaultFileState,
} from './workspaceTypes'
import { isBinaryPreviewFile } from '../lib/binaryFiles'
import { fileTransition, reconcileFile } from './fileStateMachine'

// --- Fetch helper ---

async function fetchContent(
  project: string,
  path: string,
  worktree?: string | null,
  signal?: AbortSignal,
): Promise<{ content: string; revision: number } | null> {
  const res = await fetch(
    `${API}${appendWorktree(`/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`, worktree)}`,
    signal ? { signal } : undefined,
  )
  if (!res.ok) {
    if (res.status === 404) return null
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
  return res.json()
}

// --- Hook ---

export function useFileState(
  projectName: string,
  worktree: string | null | undefined,
  initialDrafts: PersistedDrafts,
  initialOpenTabs: string[],
  openTabsRef: { readonly current: string[] },
) {
  const [files, setFiles] = useState<Record<string, FileState>>(() => {
    const restored: Record<string, FileState> = {}
    for (const [path, entry] of Object.entries(initialDrafts.files)) {
      restored[path] = {
        serverContent: null,
        draft: entry.draft,
        baseRevision: entry.baseRevision,
        viewportLine: entry.viewportLine,
        status: entry.draft != null ? 'dirty' : 'clean',
        editedAt: entry.updatedAt,
      }
    }
    return restored
  })

  const projectRef = useRef(projectName)
  const worktreeRef = useRef(worktree)
  const filesRef = useRef(files)
  // Mirror latest values for async fetch/SSE callbacks that read without re-subscribing.
  useEffect(() => {
    projectRef.current = projectName
    worktreeRef.current = worktree
    filesRef.current = files
  })

  const refetchAbortRef = useRef<AbortController | null>(null)

  // --- Hydration: fetch server truth for open file tabs on mount ---
  const hydrated = useRef(false)
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true

    const fileTabs = initialOpenTabs.filter(t => isFileTab(t) && !isBinaryPreviewFile(t))
    if (fileTabs.length === 0) return

    for (const path of fileTabs) {
      fetchContent(projectName, path, worktree).then(result => {
        if (projectRef.current !== projectName) return
        setFiles(prev => {
          const next = reconcileFile(prev[path], result)
          return next === prev[path] ? prev : { ...prev, [path]: next }
        })
      }).catch(() => {/* network/server error — file stays in current state */})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName])

  // Abort in-flight refetches on unmount
  useEffect(() => () => { refetchAbortRef.current?.abort() }, [])

  // --- SSE: refetch open file tabs on filetree or git changes ---
  const refetchOpenFiles = useCallback(() => {
    const project = projectRef.current
    const tabs = openTabsRef.current.filter(t => isFileTab(t) && !isBinaryPreviewFile(t))
    if (tabs.length === 0) return

    refetchAbortRef.current?.abort()
    const ac = new AbortController()
    refetchAbortRef.current = ac

    for (const path of tabs) {
      fetchContent(project, path, worktreeRef.current, ac.signal).then(result => {
        if (ac.signal.aborted || projectRef.current !== project) return
        setFiles(prev => {
          const next = reconcileFile(prev[path], result)
          return next === prev[path] ? prev : { ...prev, [path]: next }
        })
      }).catch(() => {/* AbortError or network — ignore */})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useSSERefresh('filetree', refetchOpenFiles)
  useSSERefresh('git', refetchOpenFiles)

  // --- Derived: dirty/conflict tab sets ---
  // Key each Set on a content signature so its identity only changes when membership
  // changes — not on unrelated file-state updates (e.g. viewport scroll) — which keeps
  // memoized consumers (tab bar, editor column) from re-rendering needlessly.
  const { dirtySig, conflictSig } = useMemo(() => {
    const dirty: string[] = []
    const conflict: string[] = []
    for (const [path, state] of Object.entries(files)) {
      if (state.status === 'dirty' || state.status === 'saving' || state.status === 'conflict') dirty.push(path)
      if (state.status === 'conflict') conflict.push(path)
    }
    dirty.sort()
    conflict.sort()
    return { dirtySig: dirty.join('\u0000'), conflictSig: conflict.join('\u0000') }
  }, [files])

  const dirtyTabs = useMemo(() => new Set(dirtySig ? dirtySig.split('\u0000') : []), [dirtySig])
  const conflictTabs = useMemo(() => new Set(conflictSig ? conflictSig.split('\u0000') : []), [conflictSig])

  // --- File actions ---

  /** Fetch content for a newly opened tab (gentle — won't clobber drafts) */
  const fetchForTab = useCallback((path: string) => {
    const project = projectRef.current
    fetchContent(project, path, worktreeRef.current).then(result => {
      if (projectRef.current !== project) return
      setFiles(prev => {
        const existing = prev[path]
        // If user already started editing before fetch returned, gently fill revision
        if (existing?.draft != null) {
          if (!result) return prev
          const next = fileTransition(existing, { type: 'FILL_REVISION', content: result.content, revision: result.revision })
          return next === existing ? prev : { ...prev, [path]: next }
        }
        const next = reconcileFile(existing, result)
        return next === existing ? prev : { ...prev, [path]: next }
      })
    }).catch(() => {/* network/server error — file stays in current state */})
  }, [])

  /** Shared-buffer GC (design: §B). Keep a buffer iff some open editor view still
   *  references its path OR it is dirty — so closing one view never drops a buffer
   *  another shows, and no structural close (close tab / close pane / reset) ever
   *  silently loses unsaved work. Run in an effect over the POST-mutation union. */
  const gcBuffers = useCallback((keepPaths: ReadonlySet<string>) => {
    setFiles(prev => {
      let changed = false
      const next: Record<string, FileState> = {}
      for (const [path, state] of Object.entries(prev)) {
        const dirty = state.status === 'dirty' || state.status === 'saving' || state.status === 'conflict'
        if (keepPaths.has(path) || dirty) next[path] = state
        else changed = true
      }
      return changed ? next : prev
    })
  }, [])

  /** Retarget file state from oldPath to newPath (rename/move) */
  const retargetFile = useCallback((oldPath: string, newPath: string) => {
    setFiles(prev => {
      const next = { ...prev }
      let changed = false
      for (const key of Object.keys(prev)) {
        if (key === oldPath) {
          next[newPath] = prev[key]
          delete next[key]
          changed = true
        } else if (key.startsWith(oldPath + '/')) {
          const newKey = newPath + key.slice(oldPath.length)
          next[newKey] = prev[key]
          delete next[key]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  /** Remove file state for a path and all children (delete) */
  const removeFilesUnder = useCallback((path: string) => {
    setFiles(prev => {
      const next = { ...prev }
      let changed = false
      for (const key of Object.keys(prev)) {
        if (key === path || key.startsWith(path + '/')) {
          delete next[key]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const updateDraft = useCallback((path: string, draft: string) => {
    setFiles(prev => {
      const existing = prev[path] ?? defaultFileState()
      const next = fileTransition(existing, { type: 'EDIT', draft, editedAt: Date.now() })
      return { ...prev, [path]: next }
    })
  }, [])

  const updateViewport = useCallback((path: string, line: number) => {
    setFiles(prev => {
      const existing = prev[path]
      if (!existing) return { ...prev, [path]: { ...defaultFileState(), viewportLine: line } }
      if (existing.viewportLine === line) return prev
      return { ...prev, [path]: { ...existing, viewportLine: line } }
    })
  }, [])

  const save = useCallback(async (path: string, content: string): Promise<{ conflict: boolean }> => {
    const project = projectRef.current
    let baseRevision: number | undefined
    setFiles(prev => {
      const s = prev[path]
      if (!s) return prev
      baseRevision = s.baseRevision ?? undefined
      return { ...prev, [path]: fileTransition(s, { type: 'SAVE_START' }) }
    })

    try {
      const res = await fetch(`${API}${appendWorktree(`/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`, worktreeRef.current)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, baseRevision }),
      })

      if (res.status === 409) {
        setFiles(prev => {
          const s = prev[path]
          return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_CONFLICT' }) } : prev
        })
        return { conflict: true }
      }

      if (!res.ok) throw new Error(`${res.status}`)

      const body = await res.json() as { revision: number }
      setFiles(prev => {
        const s = prev[path]
        return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_SUCCESS', content, revision: body.revision }) } : prev
      })
      return { conflict: false }
    } catch {
      setFiles(prev => {
        const s = prev[path]
        return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_ERROR' }) } : prev
      })
      return { conflict: false }
    }
  }, [])

  const forceSave = useCallback(async (path: string, content: string) => {
    const project = projectRef.current
    setFiles(prev => {
      const s = prev[path]
      return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_START' }) } : prev
    })

    try {
      const res = await fetch(`${API}${appendWorktree(`/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`, worktreeRef.current)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) throw new Error(`${res.status}`)

      const body = await res.json() as { revision: number }
      setFiles(prev => {
        const s = prev[path]
        return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_SUCCESS', content, revision: body.revision }) } : prev
      })
    } catch {
      setFiles(prev => {
        const s = prev[path]
        return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_ERROR' }) } : prev
      })
    }
  }, [])

  const acceptDisk = useCallback((path: string) => {
    const project = projectRef.current
    fetchContent(project, path, worktreeRef.current).then(result => {
      if (!result) return
      setFiles(prev => {
        const existing = prev[path] ?? defaultFileState()
        return { ...prev, [path]: fileTransition(existing, { type: 'ACCEPT_DISK', content: result.content, revision: result.revision }) }
      })
    }).catch(() => {/* network/server error — keep conflict state */})
  }, [])

  return {
    files,
    filesRef,
    dirtyTabs,
    conflictTabs,
    gcBuffers,
    fetchForTab,
    retargetFile,
    removeFilesUnder,
    updateDraft,
    updateViewport,
    save,
    forceSave,
    acceptDisk,
  }
}
