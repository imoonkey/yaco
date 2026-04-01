import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useSSERefresh } from './useSSE'
import { API } from './useApi'
import { ApiError } from '../lib/apiError'
import {
  type FileState,
  type PersistedDrafts,
  isFileTab,
  defaultFileState,
} from './workspaceTypes'

// --- PreviewLifecycle interface ---

/** Narrow contract connecting layout state to file state for preview tab cleanup */
export interface PreviewLifecycle {
  /** Returns true if the preview tab is clean and can be dropped */
  canDropPreview: (tab: string) => boolean
  /** Remove file state entry for a dropped preview tab */
  onDropPreview: (tab: string) => void
}

// --- Fetch helper ---

async function fetchContent(
  project: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ content: string; revision: number } | null> {
  const res = await fetch(
    `${API}/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`,
    signal ? { signal } : undefined,
  )
  if (!res.ok) {
    if (res.status === 404) return null
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body)
  }
  return res.json()
}

// --- Reconciliation helper ---

/** Apply server fetch result to file state. Returns prev unchanged if nothing differs. */
function reconcileFile(prev: FileState | undefined, result: { content: string; revision: number } | null): FileState {
  const existing = prev ?? defaultFileState()

  if (!result) {
    return existing.status === 'missing' ? existing : { ...existing, status: 'missing' }
  }

  // Dirty/conflict file: check if revision diverged
  if (existing.draft != null && existing.status !== 'clean') {
    if (existing.baseRevision != null && existing.baseRevision !== result.revision) {
      if (existing.status === 'conflict' && existing.serverContent === result.content) return existing
      return { ...existing, serverContent: result.content, status: 'conflict' }
    }
    // Revision matches — keep draft, update server content if changed
    if (existing.serverContent === result.content && existing.baseRevision === result.revision) return existing
    return { ...existing, serverContent: result.content, baseRevision: result.revision }
  }

  // Clean file: adopt server content (skip if identical)
  if (existing.serverContent === result.content && existing.baseRevision === result.revision && existing.status === 'clean') {
    return existing
  }

  return {
    serverContent: result.content,
    draft: null,
    baseRevision: result.revision,
    viewportLine: existing.viewportLine,
    status: 'clean',
    editedAt: existing.editedAt,
  }
}

// --- Hook ---

export function useFileState(
  projectName: string,
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
  projectRef.current = projectName

  const filesRef = useRef(files)
  filesRef.current = files

  const refetchAbortRef = useRef<AbortController | null>(null)

  // --- Hydration: fetch server truth for open file tabs on mount ---
  const hydrated = useRef(false)
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true

    const fileTabs = initialOpenTabs.filter(isFileTab)
    if (fileTabs.length === 0) return

    for (const path of fileTabs) {
      fetchContent(projectName, path).then(result => {
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
    const tabs = openTabsRef.current.filter(isFileTab)
    if (tabs.length === 0) return

    refetchAbortRef.current?.abort()
    const ac = new AbortController()
    refetchAbortRef.current = ac

    for (const path of tabs) {
      fetchContent(project, path, ac.signal).then(result => {
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

  // --- Derived (memoized with stabilized references) ---
  const prevDirtyRef = useRef(new Set<string>())
  const prevConflictRef = useRef(new Set<string>())
  const { dirtyTabs, conflictTabs } = useMemo(() => {
    const dirty = new Set<string>()
    const conflict = new Set<string>()
    for (const [path, state] of Object.entries(files)) {
      if (state.status === 'dirty' || state.status === 'saving') dirty.add(path)
      if (state.status === 'conflict') { dirty.add(path); conflict.add(path) }
    }
    const dirtyMatch = dirty.size === prevDirtyRef.current.size && [...dirty].every(p => prevDirtyRef.current.has(p))
    const conflictMatch = conflict.size === prevConflictRef.current.size && [...conflict].every(p => prevConflictRef.current.has(p))
    const stableDirty = dirtyMatch ? prevDirtyRef.current : dirty
    const stableConflict = conflictMatch ? prevConflictRef.current : conflict
    prevDirtyRef.current = stableDirty
    prevConflictRef.current = stableConflict
    return { dirtyTabs: stableDirty, conflictTabs: stableConflict }
  }, [files])

  // --- Preview lifecycle ---
  const previewLifecycle: PreviewLifecycle = useMemo(() => ({
    canDropPreview: (tab: string) => {
      if (!isFileTab(tab)) return true
      const state = filesRef.current[tab]
      if (!state) return true
      return state.status !== 'dirty' && state.status !== 'saving' && state.status !== 'conflict'
    },
    onDropPreview: (tab: string) => {
      if (!isFileTab(tab)) return
      setFiles(prev => {
        if (!(tab in prev)) return prev
        const next = { ...prev }
        delete next[tab]
        return next
      })
    },
  }), [])

  // --- File actions ---

  /** Fetch content for a newly opened tab (gentle — won't clobber drafts) */
  const fetchForTab = useCallback((path: string) => {
    const project = projectRef.current
    fetchContent(project, path).then(result => {
      if (projectRef.current !== project) return
      setFiles(prev => {
        const existing = prev[path]
        // If user already started editing before fetch returned, don't clobber the draft
        if (existing?.draft != null) {
          if (existing.baseRevision == null && result) {
            return { ...prev, [path]: { ...existing, serverContent: result.content, baseRevision: result.revision } }
          }
          return prev
        }
        const next = reconcileFile(existing, result)
        return next === existing ? prev : { ...prev, [path]: next }
      })
    }).catch(() => {/* network/server error — file stays in current state */})
  }, [])

  /** Remove file state entry (for tab close) */
  const removeFile = useCallback((tab: string) => {
    if (!isFileTab(tab)) return
    setFiles(prev => {
      if (!(tab in prev)) return prev
      const next = { ...prev }
      delete next[tab]
      return next
    })
  }, [])

  const updateDraft = useCallback((path: string, draft: string) => {
    setFiles(prev => {
      const existing = prev[path]
      const base = existing ?? defaultFileState()
      return {
        ...prev,
        [path]: {
          ...base,
          draft,
          status: base.status === 'conflict' ? 'conflict' : 'dirty',
          editedAt: Date.now(),
        },
      }
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
      baseRevision = s?.baseRevision ?? undefined
      return s ? { ...prev, [path]: { ...s, status: 'saving' } } : prev
    })

    try {
      const res = await fetch(`${API}/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, baseRevision }),
      })

      if (res.status === 409) {
        setFiles(prev => {
          const s = prev[path]
          return s ? { ...prev, [path]: { ...s, status: 'conflict' } } : prev
        })
        return { conflict: true }
      }

      if (!res.ok) throw new Error(`${res.status}`)

      const body = await res.json() as { revision: number }
      setFiles(prev => {
        const s = prev[path]
        return s
          ? { ...prev, [path]: { ...s, serverContent: content, draft: null, baseRevision: body.revision, status: 'clean' } }
          : prev
      })
      return { conflict: false }
    } catch {
      setFiles(prev => {
        const s = prev[path]
        return s ? { ...prev, [path]: { ...s, status: 'dirty' } } : prev
      })
      return { conflict: false }
    }
  }, [])

  const forceSave = useCallback(async (path: string, content: string) => {
    const project = projectRef.current
    setFiles(prev => {
      const s = prev[path]
      return s ? { ...prev, [path]: { ...s, status: 'saving' } } : prev
    })

    try {
      const res = await fetch(`${API}/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) throw new Error(`${res.status}`)

      const body = await res.json() as { revision: number }
      setFiles(prev => {
        const s = prev[path]
        return s
          ? { ...prev, [path]: { ...s, serverContent: content, draft: null, baseRevision: body.revision, status: 'clean' } }
          : prev
      })
    } catch {
      setFiles(prev => {
        const s = prev[path]
        return s ? { ...prev, [path]: { ...s, status: 'dirty' } } : prev
      })
    }
  }, [])

  const acceptDisk = useCallback((path: string) => {
    const project = projectRef.current
    fetchContent(project, path).then(result => {
      if (!result) return
      setFiles(prev => ({
        ...prev,
        [path]: {
          serverContent: result.content,
          draft: null,
          baseRevision: result.revision,
          viewportLine: prev[path]?.viewportLine ?? 1,
          status: 'clean',
          editedAt: prev[path]?.editedAt ?? 0,
        },
      }))
    }).catch(() => {/* network/server error — keep conflict state */})
  }, [])

  return {
    files,
    filesRef,
    dirtyTabs,
    conflictTabs,
    previewLifecycle,
    fetchForTab,
    removeFile,
    updateDraft,
    updateViewport,
    save,
    forceSave,
    acceptDisk,
  }
}
