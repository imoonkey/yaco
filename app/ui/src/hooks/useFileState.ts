import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { useSSERefresh } from './useSSE'
import { API, appendWorktree } from './useApi'
import { ApiError } from '../lib/apiError'
import {
  type FileState,
  type PersistedDraftsByWorktree,
  isFileTab,
  defaultFileState,
} from './workspaceTypes'
import { isBinaryPreviewFile } from '../lib/binaryFiles'
import { fileTransition, reconcileFile } from './fileStateMachine'

// The per-relpath file map for ONE worktree. The hook stores one of these per
// worktree key; the active one is projected as the public `files`.
type Files = Record<string, FileState>

// Stable empty bucket so an unselected worktree projects the same reference every
// render (no spurious editor re-render before its bytes hydrate).
const EMPTY_FILES: Files = {}

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
  projectPath: string,
  worktree: string | null | undefined,
  initialDraftsByWorktree: PersistedDraftsByWorktree,
  initialOpenTabs: string[],
  openTabsRef: { readonly current: string[] },
) {
  // The per-worktree dimension lives INSIDE the hook (design §P3 file-content
  // keying): one bucket per `worktreeKey = worktree ?? projectPath` — the worktree's
  // absolute path, with the primary checkout keyed by the project root path. This
  // matches the persisted record's keys exactly, so buckets seed and flush with no
  // remap. The public relpath contract is unchanged: consumers read the ACTIVE bucket.
  const worktreeKey = worktree ?? projectPath

  // Seed EVERY persisted bucket up front (design §P3 — the no-remount flip): with the
  // per-worktree remount gone, switching to a worktree must restore its drafts without
  // a reload, so a partially-hydrated bucket can never serialize `{}` and prune an
  // unopened-path base draft (#3b). Each bucket restores its drafts with serverContent
  // unfetched — the hydration effect fetches the active worktree's bytes on mount and
  // on every switch.
  const [filesByWorktree, setFilesByWorktree] = useState<Record<string, Files>>(() => {
    const out: Record<string, Files> = {}
    for (const [key, bucket] of Object.entries(initialDraftsByWorktree)) {
      const restored: Files = {}
      for (const [path, entry] of Object.entries(bucket)) {
        restored[path] = {
          serverContent: null,
          serverRevision: null,
          draft: entry.draft,
          baseRevision: entry.baseRevision,
          viewportLine: entry.viewportLine,
          status: entry.draft != null ? 'dirty' : 'clean',
          editedAt: entry.updatedAt,
          loadError: null,
        }
      }
      out[key] = restored
    }
    return out
  })

  // Active projection: the selected worktree's bucket. `files` AND `filesRef`
  // expose it, so EditorPanel/WorkspaceEditorColumn/GroupTabBar/PanelGroup/
  // MobilePanelProjection/useWorkspaceState see the active worktree transparently
  // by plain relpath. A background bucket mutating gives `filesByWorktree` a new
  // identity but the active bucket reference is unchanged → `files` keeps identity.
  const files = useMemo(() => filesByWorktree[worktreeKey] ?? EMPTY_FILES, [filesByWorktree, worktreeKey])

  const projectRef = useRef(projectName)
  const worktreeRef = useRef(worktree)
  const worktreeKeyRef = useRef(worktreeKey)
  const filesRef = useRef(files)
  // The WHOLE per-worktree store, mirrored for the persistence flush: serializing it
  // (not just the active projection) is the design §P3 "all-buckets surface", and it
  // reflects background-bucket mutations too — a save/accept that completes into a
  // now-background worktree after a switch lands here, so the flush never writes back
  // a stale draft for it.
  const filesByWorktreeRef = useRef(filesByWorktree)
  // Mirror latest values for async fetch/SSE callbacks that read without re-subscribing.
  // useLayoutEffect (not passive) so a tab-bar Save handler reading `filesRef.current`
  // sees the committed draft before the next user event, never one render stale.
  useLayoutEffect(() => {
    projectRef.current = projectName
    worktreeRef.current = worktree
    worktreeKeyRef.current = worktreeKey
    filesRef.current = files
    filesByWorktreeRef.current = filesByWorktree
  })

  // Mutate one worktree's bucket; returns the prior whole map when the updater is
  // a no-op so identity stays stable.
  const setFilesIn = useCallback((key: string, updater: (prev: Files) => Files) => {
    setFilesByWorktree(prev => {
      const bucket = prev[key] ?? EMPTY_FILES
      const next = updater(bucket)
      return next === bucket ? prev : { ...prev, [key]: next }
    })
  }, [])
  // Mutate the CURRENTLY active bucket — synchronous user edits target the view.
  const setActiveFiles = useCallback((updater: (prev: Files) => Files) => {
    setFilesIn(worktreeKeyRef.current, updater)
  }, [setFilesIn])

  const refetchAbortRef = useRef<AbortController | null>(null)
  // Per-worktree-epoch abort: a switch aborts every in-flight fetch issued for the
  // previous worktree — hydration, per-tab open all carry its signal, so a superseded
  // read is cancelled (and, if it resolved first, dropped by the captured-key check
  // below).
  const wtAbortRef = useRef<AbortController | null>(null)
  // Mount-lifetime abort for DETACHED operations that must outlive a worktree switch:
  // accept-disk is an explicit action on a captured (worktree, path) and must complete
  // into that bucket even after the user switches worktrees (#3a — no remount means no
  // reload to recover a dropped accept). Aborted only on unmount; a project switch
  // remounts the provider, so it is correctly torn down then.
  const lifeAbortRef = useRef<AbortController | null>(null)
  if (lifeAbortRef.current == null) lifeAbortRef.current = new AbortController()
  useEffect(() => () => lifeAbortRef.current?.abort(), [])

  // Record a failed content fetch (e.g. 413 "file too large") onto the path's
  // state so the editor pane can show why, instead of spinning forever.
  const recordLoadError = useCallback((path: string, err: unknown) => {
    const status = err instanceof ApiError ? err.status : 0
    const message = err instanceof ApiError ? err.message : 'Failed to load file'
    setActiveFiles(prev => {
      const existing = prev[path] ?? defaultFileState()
      return { ...prev, [path]: fileTransition(existing, { type: 'LOAD_ERROR', status, message }) }
    })
  }, [setActiveFiles])

  // --- Hydration: fetch the active worktree's bytes for open file tabs ---
  // Runs on mount AND on every worktree switch (the editor must show the selected
  // worktree's version of each open path — design §P3 "switching re-points open
  // editors"). Captured-worktree key + AbortController guard: a fetch issued for
  // worktree A that resolves after a switch to B is aborted on cleanup, and if it
  // still resolved it is dropped — never reconciled into B's bucket (no cross-
  // worktree leak). First run uses the mount snapshot; a later switch re-fetches
  // the live open-tab set.
  const firstHydrate = useRef(true)
  useEffect(() => {
    const key = worktree ?? projectPath
    // The epoch controller for THIS worktree — stored so fetchForTab / acceptDisk
    // ride the same abort, and cleanup cancels every read when the worktree changes.
    const ac = new AbortController()
    wtAbortRef.current = ac
    const source = firstHydrate.current ? initialOpenTabs : openTabsRef.current
    firstHydrate.current = false

    const fileTabs = source.filter(t => isFileTab(t) && !isBinaryPreviewFile(t))
    for (const path of fileTabs) {
      fetchContent(projectName, path, worktree, ac.signal).then(result => {
        if (ac.signal.aborted || projectRef.current !== projectName || worktreeKeyRef.current !== key) return
        setActiveFiles(prev => {
          const next = reconcileFile(prev[path], result)
          return next === prev[path] ? prev : { ...prev, [path]: next }
        })
      }).catch(err => {
        if (err?.name === 'AbortError' || ac.signal.aborted || projectRef.current !== projectName || worktreeKeyRef.current !== key) return
        recordLoadError(path, err)
      })
    }
    return () => ac.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree])

  // Abort in-flight SSE refetches on unmount
  useEffect(() => () => { refetchAbortRef.current?.abort() }, [])

  // --- SSE: refetch open file tabs on filetree or git changes ---
  const refetchOpenFiles = useCallback(() => {
    const project = projectRef.current
    const key = worktreeKeyRef.current
    const wt = worktreeRef.current
    const tabs = openTabsRef.current.filter(t => isFileTab(t) && !isBinaryPreviewFile(t))
    if (tabs.length === 0) return

    refetchAbortRef.current?.abort()
    const ac = new AbortController()
    refetchAbortRef.current = ac

    for (const path of tabs) {
      fetchContent(project, path, wt, ac.signal).then(result => {
        if (ac.signal.aborted || projectRef.current !== project || worktreeKeyRef.current !== key) return
        setActiveFiles(prev => {
          const next = reconcileFile(prev[path], result)
          return next === prev[path] ? prev : { ...prev, [path]: next }
        })
      }).catch(err => {
        if (err?.name === 'AbortError' || ac.signal.aborted || projectRef.current !== project || worktreeKeyRef.current !== key) return
        recordLoadError(path, err)
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordLoadError, setActiveFiles])

  // Working-tree file content changes always arrive on the 'filetree' channel
  // (the watcher emits 'git' in addition, but only for .git-internal writes that
  // never alter open file contents). Subscribing to both double-fired a full
  // refetch of every open tab per disk change; 'filetree' alone is sufficient.
  useSSERefresh('filetree', refetchOpenFiles)

  // --- Derived: dirty/conflict tab sets (for the ACTIVE worktree) ---
  // Signatures are JSON of the sorted path list (not a char-join): a filename-legal
  // separator can never split one path into two — the same collision-free encoding
  // keepPathsSignature uses. Each Set's identity changes only when membership does
  // (not on unrelated file-state updates like viewport scroll), keeping memoized
  // consumers (tab bar, editor column) from re-rendering needlessly.
  const { dirtySig, conflictSig } = useMemo(() => {
    const dirty: string[] = []
    const conflict: string[] = []
    for (const [path, state] of Object.entries(files)) {
      // draft != null also covers 'missing' (a dirty file deleted on disk) so an
      // unsaved buffer is never dropped from the dirty set on its way to GC.
      if (state.draft != null || state.status === 'dirty' || state.status === 'saving' || state.status === 'conflict') dirty.push(path)
      if (state.status === 'conflict') conflict.push(path)
    }
    dirty.sort()
    conflict.sort()
    return { dirtySig: JSON.stringify(dirty), conflictSig: JSON.stringify(conflict) }
  }, [files])

  const dirtyTabs = useMemo(() => new Set<string>(JSON.parse(dirtySig) as string[]), [dirtySig])
  const conflictTabs = useMemo(() => new Set<string>(JSON.parse(conflictSig) as string[]), [conflictSig])

  // --- File actions ---

  /** Fetch content for a newly opened tab (gentle — won't clobber drafts) */
  const fetchForTab = useCallback((path: string) => {
    const project = projectRef.current
    const key = worktreeKeyRef.current
    const signal = wtAbortRef.current?.signal
    fetchContent(project, path, worktreeRef.current, signal).then(result => {
      // Drop a result that resolved after a project/worktree switch (aborted by the
      // epoch controller and/or superseded worktree key).
      if (signal?.aborted || projectRef.current !== project || worktreeKeyRef.current !== key) return
      setActiveFiles(prev => {
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
    }).catch(err => {
      if (err?.name === 'AbortError' || signal?.aborted || projectRef.current !== project || worktreeKeyRef.current !== key) return
      recordLoadError(path, err)
    })
  }, [recordLoadError, setActiveFiles])

  /** Shared-buffer GC (design: §B). Keep a buffer iff some open editor view still
   *  references its path OR it is dirty — so closing one view never drops a buffer
   *  another shows, and no structural close (close tab / close pane / reset) ever
   *  silently loses unsaved work. Run in an effect over the POST-mutation union.
   *  GC the ACTIVE bucket only; background worktrees keep their drafts (switch away
   *  and back never loses an edit). */
  const gcBuffers = useCallback((keepPaths: ReadonlySet<string>) => {
    setActiveFiles(prev => {
      let changed = false
      const next: Files = {}
      for (const [path, state] of Object.entries(prev)) {
        // Retain anything still holding unsaved work — including a 'missing' file
        // (deleted on disk) whose draft would otherwise be silently GC'd on close.
        const unsaved = state.draft != null || state.status === 'dirty' || state.status === 'saving' || state.status === 'conflict'
        if (keepPaths.has(path) || unsaved) next[path] = state
        else changed = true
      }
      return changed ? next : prev
    })
  }, [setActiveFiles])

  /** Retarget file state from oldPath to newPath (rename/move) */
  const retargetFile = useCallback((oldPath: string, newPath: string) => {
    setActiveFiles(prev => {
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
  }, [setActiveFiles])

  /** Remove file state for a path and all children (delete) */
  const removeFilesUnder = useCallback((path: string) => {
    setActiveFiles(prev => {
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
  }, [setActiveFiles])

  const updateDraft = useCallback((path: string, draft: string) => {
    setActiveFiles(prev => {
      const existing = prev[path] ?? defaultFileState()
      const next = fileTransition(existing, { type: 'EDIT', draft, editedAt: Date.now() })
      return { ...prev, [path]: next }
    })
  }, [setActiveFiles])

  const updateViewport = useCallback((path: string, line: number) => {
    setActiveFiles(prev => {
      const existing = prev[path]
      if (!existing) return { ...prev, [path]: { ...defaultFileState(), viewportLine: line } }
      if (existing.viewportLine === line) return prev
      return { ...prev, [path]: { ...existing, viewportLine: line } }
    })
  }, [setActiveFiles])

  const save = useCallback(async (path: string, content: string): Promise<{ conflict: boolean }> => {
    const project = projectRef.current
    // Capture the worktree once: the save targets THIS worktree's bytes, and every
    // transition (start → success/conflict/error) lands in its bucket, so a switch
    // mid-save never strands 'saving' state nor leaks the result into another view.
    const wt = worktreeRef.current
    const key = wt ?? projectPath
    let baseRevision: number | undefined
    setFilesIn(key, prev => {
      const s = prev[path]
      if (!s) return prev
      baseRevision = s.baseRevision ?? undefined
      return { ...prev, [path]: fileTransition(s, { type: 'SAVE_START' }) }
    })

    try {
      const res = await fetch(`${API}${appendWorktree(`/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`, wt)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, baseRevision }),
      })

      if (res.status === 409) {
        setFilesIn(key, prev => {
          const s = prev[path]
          return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_CONFLICT' }) } : prev
        })
        return { conflict: true }
      }

      if (!res.ok) throw new Error(`${res.status}`)

      const body = await res.json() as { revision: number }
      setFilesIn(key, prev => {
        const s = prev[path]
        return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_SUCCESS', content, revision: body.revision }) } : prev
      })
      return { conflict: false }
    } catch {
      setFilesIn(key, prev => {
        const s = prev[path]
        return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_ERROR' }) } : prev
      })
      return { conflict: false }
    }
  }, [setFilesIn, projectPath])

  const forceSave = useCallback(async (path: string, content: string) => {
    const project = projectRef.current
    const wt = worktreeRef.current
    const key = wt ?? projectPath
    setFilesIn(key, prev => {
      const s = prev[path]
      return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_START' }) } : prev
    })

    try {
      const res = await fetch(`${API}${appendWorktree(`/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`, wt)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) throw new Error(`${res.status}`)

      const body = await res.json() as { revision: number }
      setFilesIn(key, prev => {
        const s = prev[path]
        return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_SUCCESS', content, revision: body.revision }) } : prev
      })
    } catch {
      setFilesIn(key, prev => {
        const s = prev[path]
        return s ? { ...prev, [path]: fileTransition(s, { type: 'SAVE_ERROR' }) } : prev
      })
    }
  }, [setFilesIn, projectPath])

  const acceptDisk = useCallback((path: string) => {
    const project = projectRef.current
    // Capture the worktree once: accept-disk targets THIS worktree's bytes and lands
    // the ACCEPT_DISK transition in its bucket. It rides the mount-lifetime signal, NOT
    // the per-worktree epoch — an explicit accept must complete into the captured bucket
    // even after the user switches worktrees (#3a: no remount means no reload to recover
    // a dropped accept; the keyed bucket is correct regardless of the current view).
    const wt = worktreeRef.current
    const key = wt ?? projectPath
    const signal = lifeAbortRef.current?.signal
    const cached = filesByWorktreeRef.current[key]?.[path]
    const acceptEditedAt = cached?.editedAt ?? 0
    const cachedContent = cached?.serverContent ?? null
    const cachedRevision = cached?.serverRevision ?? null
    const usedCached = cached?.status === 'conflict'
      && cached.serverContent != null
      && cached.serverRevision != null
      && cached.serverRevision !== cached.baseRevision
    if (usedCached) {
      setFilesIn(key, prev => {
        const existing = prev[path] ?? defaultFileState()
        return { ...prev, [path]: fileTransition(existing, { type: 'ACCEPT_DISK_CACHED', content: cachedContent!, revision: cachedRevision! }) }
      })
    }
    fetchContent(project, path, wt, signal).then(result => {
      if (signal?.aborted) return
      setFilesIn(key, prev => {
        const existing = prev[path] ?? defaultFileState()
        const stillCachedAccept = usedCached
          && existing.draft == null
          && existing.status === 'clean'
          && existing.editedAt === acceptEditedAt
          && existing.serverContent === cachedContent
          && existing.serverRevision === cachedRevision
          && existing.baseRevision === cachedRevision
        if (!result) {
          return stillCachedAccept
            ? { ...prev, [path]: fileTransition(existing, { type: 'SERVER_MISSING' }) }
            : prev
        }
        const event = (usedCached ? stillCachedAccept : existing.editedAt === acceptEditedAt)
          ? { type: 'ACCEPT_DISK' as const, content: result.content, revision: result.revision }
          : { type: 'SERVER_SYNC' as const, content: result.content, revision: result.revision }
        return { ...prev, [path]: fileTransition(existing, event) }
      })
    }).catch(err => {
      if (err?.name === 'AbortError' || signal?.aborted) return
      setFilesIn(key, prev => {
        const existing = prev[path]
        if (!existing) return prev
        const stillCachedAccept = usedCached
          && existing.draft == null
          && existing.status === 'clean'
          && existing.editedAt === acceptEditedAt
          && existing.serverContent === cachedContent
          && existing.serverRevision === cachedRevision
          && existing.baseRevision === cachedRevision
        if (!stillCachedAccept) return prev
        const status = err instanceof ApiError ? err.status : 0
        const message = err instanceof ApiError ? err.message : 'Failed to load file'
        return { ...prev, [path]: fileTransition(existing, { type: 'LOAD_ERROR', status, message }) }
      })
      console.warn(`acceptDisk: failed to refresh "${path}"`, err)
    })
  }, [setFilesIn, projectPath])

  return {
    files,
    filesRef,
    filesByWorktree,
    filesByWorktreeRef,
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
