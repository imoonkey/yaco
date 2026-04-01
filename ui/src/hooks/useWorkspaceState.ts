import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useSSERefresh } from './useSSE'
import { API } from './useApi'

// --- Types ---

export type FileStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'missing'

export type FileState = {
  serverContent: string | null
  draft: string | null
  baseRevision: number | null
  viewportLine: number
  status: FileStatus
  editedAt: number
}

export type MdMode = 'edit' | 'preview' | 'split'

export type WorkspaceLayout = {
  showSidebar: boolean
  showRightPanel: boolean
  showExplorer: boolean
  showSessions: boolean
  showChanges: boolean
  showTasks: boolean
  mdMode: MdMode
  splitSize: number
  leftSize: number
  rightSize: number
  explorerSize: number
  changesSize: number
  sessionSize: number
}

type PersistedDraftEntry = {
  draft: string | null
  baseRevision: number | null
  viewportLine: number
  updatedAt: number
}

type PersistedDrafts = {
  files: Record<string, PersistedDraftEntry>
}

export const TASKS_TAB_ID = '\0tasks'

export function isDiffTab(tab: string | null): boolean {
  return typeof tab === 'string' && tab.startsWith('diff:')
}

export function isTasksTab(tab: string | null): boolean {
  return tab === TASKS_TAB_ID
}

export function isFileTab(tab: string | null): tab is string {
  return typeof tab === 'string' && tab.length > 0 && !isDiffTab(tab) && !isTasksTab(tab)
}

// --- Storage keys ---

function layoutKey(project: string): string {
  return `workflow-workspace:${project}`
}

function draftsKey(project: string): string {
  return `workflow-drafts:${project}`
}

// --- Defaults ---

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  showSidebar: true,
  showRightPanel: true,
  showExplorer: true,
  showSessions: true,
  showChanges: true,
  showTasks: true,
  mdMode: 'edit',
  splitSize: 50,
  leftSize: 220,
  rightSize: 420,
  explorerSize: 250,
  changesSize: 150,
  sessionSize: 180,
}

function defaultFileState(): FileState {
  return { serverContent: null, draft: null, baseRevision: null, viewportLine: 1, status: 'clean', editedAt: 0 }
}

// --- localStorage helpers ---

function loadStoredSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function dedupeTabs(tabs: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const tab of tabs) {
    if (!tab || seen.has(tab)) continue
    seen.add(tab)
    next.push(tab)
  }
  return next
}

type PersistedState = {
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
  activeSession: string
  mobilePane: 'files' | 'editor' | 'terminal'
  layout: WorkspaceLayout
  pinnedSessions: string[]
}

function loadPersistedState(project: string): PersistedState {
  const defaults: PersistedState = {
    openTabs: [],
    activeTab: null,
    previewTab: null,
    activeSession: '',
    mobilePane: 'files',
    layout: { ...DEFAULT_LAYOUT },
    pinnedSessions: [],
  }

  try {
    const raw = localStorage.getItem(layoutKey(project))
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Record<string, unknown>

    const openTabs = dedupeTabs(Array.isArray(parsed.openTabs)
      ? (parsed.openTabs as unknown[]).filter((t): t is string => typeof t === 'string')
      : [])
    const activeTab = typeof parsed.activeTab === 'string' && openTabs.includes(parsed.activeTab)
      ? parsed.activeTab
      : openTabs[0] ?? null

    const pl = (parsed.layout ?? parsed) as Record<string, unknown>

    return {
      openTabs,
      activeTab,
      previewTab: typeof parsed.previewTab === 'string' && openTabs.includes(parsed.previewTab) && !isTasksTab(parsed.previewTab)
        ? parsed.previewTab
        : null,
      activeSession: typeof parsed.activeSession === 'string' ? parsed.activeSession : '',
      mobilePane: parsed.mobilePane === 'files' || parsed.mobilePane === 'editor' || parsed.mobilePane === 'terminal'
        ? parsed.mobilePane as PersistedState['mobilePane'] : 'files',
      layout: {
        showSidebar: typeof pl.showSidebar === 'boolean' ? pl.showSidebar : DEFAULT_LAYOUT.showSidebar,
        showRightPanel: typeof pl.showRightPanel === 'boolean' ? pl.showRightPanel : DEFAULT_LAYOUT.showRightPanel,
        showExplorer: typeof pl.showExplorer === 'boolean' ? pl.showExplorer : DEFAULT_LAYOUT.showExplorer,
        showSessions: typeof pl.showSessions === 'boolean' ? pl.showSessions : DEFAULT_LAYOUT.showSessions,
        showChanges: typeof pl.showChanges === 'boolean' ? pl.showChanges : DEFAULT_LAYOUT.showChanges,
        showTasks: typeof pl.showTasks === 'boolean' ? pl.showTasks : DEFAULT_LAYOUT.showTasks,
        mdMode: pl.mdMode === 'edit' || pl.mdMode === 'preview' || pl.mdMode === 'split' ? pl.mdMode
          : typeof pl.previewMode === 'boolean' ? (pl.previewMode ? 'preview' : 'edit')
          : DEFAULT_LAYOUT.mdMode,
        splitSize: typeof pl.splitSize === 'number' && pl.splitSize >= 20 && pl.splitSize <= 80 ? pl.splitSize : DEFAULT_LAYOUT.splitSize,
        leftSize: loadStoredSize(pl.leftSize, DEFAULT_LAYOUT.leftSize),
        rightSize: loadStoredSize(pl.rightSize, DEFAULT_LAYOUT.rightSize),
        explorerSize: loadStoredSize(pl.explorerSize, DEFAULT_LAYOUT.explorerSize),
        changesSize: loadStoredSize(pl.changesSize, DEFAULT_LAYOUT.changesSize),
        sessionSize: loadStoredSize(pl.sessionSize, DEFAULT_LAYOUT.sessionSize),
      },
      pinnedSessions: Array.isArray(parsed.pinnedSessions)
        ? (parsed.pinnedSessions as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
    }
  } catch {
    return defaults
  }
}

function loadPersistedDrafts(project: string): PersistedDrafts {
  try {
    const raw = localStorage.getItem(draftsKey(project))
    if (!raw) return { files: {} }
    const parsed = JSON.parse(raw) as PersistedDrafts
    if (!parsed.files || typeof parsed.files !== 'object') return { files: {} }
    const files = Object.fromEntries(
      Object.entries(parsed.files).filter(([path]) => isFileTab(path))
    )
    return { files }
  } catch {
    return { files: {} }
  }
}

function saveLayout(project: string, state: PersistedState): void {
  try {
    localStorage.setItem(layoutKey(project), JSON.stringify(state))
  } catch { /* layout is tiny — quota should never be an issue */ }
}

function saveDrafts(project: string, drafts: PersistedDrafts): void {
  try {
    localStorage.setItem(draftsKey(project), JSON.stringify(drafts))
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      const entries = Object.entries(drafts.files).sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      while (entries.length > 0) {
        entries.shift()
        try {
          localStorage.setItem(draftsKey(project), JSON.stringify({ files: Object.fromEntries(entries) }))
          return
        } catch { continue }
      }
      // All evicted — persist empty so next load doesn't restore stale data
      try { localStorage.setItem(draftsKey(project), JSON.stringify({ files: {} })) } catch { /* noop */ }
    }
  }
}

// --- Fetch helper ---

async function fetchContent(project: string, path: string, signal?: AbortSignal): Promise<{ content: string; revision: number } | null> {
  try {
    const res = await fetch(
      `${API}/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`,
      signal ? { signal } : undefined,
    )
    if (!res.ok) return null
    return res.json()
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    return null
  }
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

export function useWorkspaceState(projectName: string) {
  const [persisted] = useState(() => loadPersistedState(projectName))
  const [draftsLoaded] = useState(() => loadPersistedDrafts(projectName))

  const [openTabs, setOpenTabs] = useState<string[]>(persisted.openTabs)
  const [activeTab, setActiveTab] = useState<string | null>(persisted.activeTab)
  const [previewTab, setPreviewTab] = useState<string | null>(persisted.previewTab)
  const [activeSession, setActiveSession] = useState(persisted.activeSession)
  const [mobilePane, setMobilePane] = useState(persisted.mobilePane)
  const [layout, setLayout] = useState<WorkspaceLayout>(persisted.layout)
  const [pinnedSessions, setPinnedSessions] = useState<string[]>(persisted.pinnedSessions)
  const [files, setFiles] = useState<Record<string, FileState>>(() => {
    const restored: Record<string, FileState> = {}
    for (const [path, entry] of Object.entries(draftsLoaded.files)) {
      restored[path] = {
        serverContent: null, // will be populated by hydration
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

  const openTabsRef = useRef(openTabs)
  openTabsRef.current = openTabs

  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  const previewTabRef = useRef(previewTab)
  previewTabRef.current = previewTab

  const refetchAbortRef = useRef<AbortController | null>(null)

  // --- Hydration: fetch server truth for open file tabs on mount ---
  const hydrated = useRef(false)
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true

    const fileTabs = openTabs.filter(isFileTab)
    if (fileTabs.length === 0) return

    for (const path of fileTabs) {
      fetchContent(projectName, path).then(result => {
        if (projectRef.current !== projectName) return
        setFiles(prev => {
          const next = reconcileFile(prev[path], result)
          return next === prev[path] ? prev : { ...prev, [path]: next }
        })
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName])

  // --- Persist layout ---
  // Refs hold latest state for synchronous flush on beforeunload
  const layoutRef = useRef({ openTabs, activeTab, previewTab, activeSession, mobilePane, layout, pinnedSessions })
  layoutRef.current = { openTabs, activeTab, previewTab, activeSession, mobilePane, layout, pinnedSessions }

  const flushLayout = useCallback(() => {
    saveLayout(projectRef.current, layoutRef.current)
  }, [])

  // Debounced persist on state changes (handles rapid resize etc.)
  const layoutTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    clearTimeout(layoutTimer.current)
    layoutTimer.current = setTimeout(flushLayout, 300)
    return () => clearTimeout(layoutTimer.current)
  }, [openTabs, activeTab, previewTab, activeSession, mobilePane, layout, pinnedSessions, flushLayout])

  // --- Persist drafts ---
  const filesRef = useRef(files)
  filesRef.current = files

  const flushDrafts = useCallback(() => {
    const entries: PersistedDrafts['files'] = {}
    for (const [path, state] of Object.entries(filesRef.current)) {
      if (!isFileTab(path)) continue
      if (state.draft != null || state.viewportLine > 1) {
        entries[path] = {
          draft: state.draft,
          baseRevision: state.baseRevision,
          viewportLine: state.viewportLine,
          updatedAt: state.editedAt || Date.now(),
        }
      }
    }
    saveDrafts(projectRef.current, { files: entries })
  }, [])

  // Debounced persist on file state changes
  const draftsTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    clearTimeout(draftsTimer.current)
    draftsTimer.current = setTimeout(flushDrafts, 500)
    return () => clearTimeout(draftsTimer.current)
  }, [files, flushDrafts])

  // Synchronous flush on page unload — catches state that the debounced timer hasn't persisted yet
  useEffect(() => {
    const onBeforeUnload = () => {
      flushLayout()
      flushDrafts()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushLayout, flushDrafts])

  // Synchronous flush on unmount — covers view/project switches where beforeunload doesn't fire
  useEffect(() => () => { flushLayout(); flushDrafts(); refetchAbortRef.current?.abort() }, [flushLayout, flushDrafts])

  // --- SSE: refetch open file tabs on filetree or git changes ---
  // Zero-dep callback — reads everything from refs so identity never changes.
  // This prevents useSSERefresh from ever re-registering the callback.
  const refetchOpenFiles = useCallback(() => {
    const project = projectRef.current
    const tabs = openTabsRef.current.filter(isFileTab)
    if (tabs.length === 0) return

    // Abort any in-flight refetch cycle
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
  }, [])

  useSSERefresh('filetree', refetchOpenFiles)
  useSSERefresh('git', refetchOpenFiles)

  // --- Derived (memoized) ---
  const prevDirtyRef = useRef(new Set<string>())
  const prevConflictRef = useRef(new Set<string>())
  const { dirtyTabs, conflictTabs } = useMemo(() => {
    const dirty = new Set<string>()
    const conflict = new Set<string>()
    for (const [path, state] of Object.entries(files)) {
      if (state.status === 'dirty' || state.status === 'saving') dirty.add(path)
      if (state.status === 'conflict') { dirty.add(path); conflict.add(path) }
    }
    // Stabilize references: return previous Sets if content hasn't changed
    const dirtyMatch = dirty.size === prevDirtyRef.current.size && [...dirty].every(p => prevDirtyRef.current.has(p))
    const conflictMatch = conflict.size === prevConflictRef.current.size && [...conflict].every(p => prevConflictRef.current.has(p))
    const stableDirty = dirtyMatch ? prevDirtyRef.current : dirty
    const stableConflict = conflictMatch ? prevConflictRef.current : conflict
    prevDirtyRef.current = stableDirty
    prevConflictRef.current = stableConflict
    return { dirtyTabs: stableDirty, conflictTabs: stableConflict }
  }, [files])

  // --- Tab actions ---

  const openFileTab = useCallback((path: string) => {
    if (!isFileTab(path)) return
    // Pin if this tab was a preview
    setPreviewTab(prev => prev === path ? null : prev)
    setOpenTabs(tabs => tabs.includes(path) ? tabs : [...tabs, path])
    setActiveTab(path)
    // Fetch content + revision for the newly opened tab
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
    })
  }, [])

  const openPreviewTab = useCallback((path: string) => {
    if (!isFileTab(path)) return
    // If the tab is already open as a pinned tab, just activate it — don't demote to preview
    if (openTabsRef.current.includes(path) && previewTabRef.current !== path) {
      setActiveTab(path)
      return
    }

    // Close existing preview tab if it's a different file and not dirty (dirty = auto-pinned)
    const oldPreview = previewTabRef.current
    if (oldPreview && oldPreview !== path) {
      setFiles(prev => {
        const oldState = prev[oldPreview]
        if (oldState && (oldState.status === 'dirty' || oldState.status === 'saving' || oldState.status === 'conflict')) {
          // Auto-pinned by edit — don't remove
          return prev
        }
        if (!(oldPreview in prev)) return prev
        const next = { ...prev }
        delete next[oldPreview]
        return next
      })
      setOpenTabs(tabs => {
        // Only remove if file state wasn't dirty (check via files ref)
        const oldState = filesRef.current[oldPreview]
        if (oldState && (oldState.status === 'dirty' || oldState.status === 'saving' || oldState.status === 'conflict')) {
          return tabs
        }
        return tabs.filter(t => t !== oldPreview)
      })
    }
    setOpenTabs(tabs => tabs.includes(path) ? tabs : [...tabs, path])
    setActiveTab(path)
    setPreviewTab(path)
    // Fetch content
    const project = projectRef.current
    fetchContent(project, path).then(result => {
      if (projectRef.current !== project) return
      setFiles(prev => {
        const existing = prev[path]
        if (existing?.draft != null) {
          if (existing.baseRevision == null && result) {
            return { ...prev, [path]: { ...existing, serverContent: result.content, baseRevision: result.revision } }
          }
          return prev
        }
        const next = reconcileFile(existing, result)
        return next === existing ? prev : { ...prev, [path]: next }
      })
    })
  }, [])

  const openDiffTab = useCallback((path: string) => {
    const tab = `diff:${path}`
    setOpenTabs(tabs => tabs.includes(tab) ? tabs : [...tabs, tab])
    setActiveTab(tab)
  }, [])

  // Open diff as a preview (temporary) tab — replaced by next preview open
  const openPreviewDiffTab = useCallback((path: string) => {
    const tab = `diff:${path}`
    // If already open as pinned, just activate
    if (openTabsRef.current.includes(tab) && previewTabRef.current !== tab) {
      setActiveTab(tab)
      return
    }
    // Close existing preview tab if different and clean
    const oldPreview = previewTabRef.current
    if (oldPreview && oldPreview !== tab) {
      if (isDiffTab(oldPreview)) {
        // Diff previews are always clean — just remove
        setOpenTabs(tabs => tabs.filter(t => t !== oldPreview))
      } else if (isFileTab(oldPreview)) {
        // File preview — only remove if not dirty
        setFiles(prev => {
          const oldState = prev[oldPreview]
          if (oldState && (oldState.status === 'dirty' || oldState.status === 'saving' || oldState.status === 'conflict')) return prev
          if (!(oldPreview in prev)) return prev
          const next = { ...prev }
          delete next[oldPreview]
          return next
        })
        setOpenTabs(tabs => {
          const oldState = filesRef.current[oldPreview]
          if (oldState && (oldState.status === 'dirty' || oldState.status === 'saving' || oldState.status === 'conflict')) return tabs
          return tabs.filter(t => t !== oldPreview)
        })
      } else {
        setOpenTabs(tabs => tabs.filter(t => t !== oldPreview))
      }
    }
    setOpenTabs(tabs => tabs.includes(tab) ? tabs : [...tabs, tab])
    setActiveTab(tab)
    setPreviewTab(tab)
  }, [])

  const openTasksTab = useCallback(() => {
    setPreviewTab(prev => prev === TASKS_TAB_ID ? null : prev)
    setOpenTabs(tabs => tabs.includes(TASKS_TAB_ID) ? tabs : [...tabs, TASKS_TAB_ID])
    setActiveTab(TASKS_TAB_ID)
  }, [])

  const closeTabByKey = useCallback((tab: string) => {
    setPreviewTab(prev => prev === tab ? null : prev)
    setOpenTabs(tabs => {
      const idx = tabs.indexOf(tab)
      if (idx === -1) return tabs
      const next = tabs.filter(t => t !== tab)
      setActiveTab(prev => prev !== tab ? prev : next[Math.min(idx, next.length - 1)] ?? null)
      return next
    })
    if (isFileTab(tab)) {
      setFiles(prev => {
        if (!(tab in prev)) return prev
        const next = { ...prev }
        delete next[tab]
        return next
      })
    }
  }, [])

  const toggleTasksTab = useCallback(() => {
    const isOpen = openTabsRef.current.includes(TASKS_TAB_ID)
    if (!isOpen) {
      openTasksTab()
      return
    }
    if (activeTabRef.current === TASKS_TAB_ID) {
      closeTabByKey(TASKS_TAB_ID)
      return
    }
    setPreviewTab(prev => prev === TASKS_TAB_ID ? null : prev)
    setActiveTab(TASKS_TAB_ID)
  }, [closeTabByKey, openTasksTab])

  // --- File state actions ---

  const updateLayout = useCallback((partial: Partial<WorkspaceLayout>) => {
    setLayout(prev => ({ ...prev, ...partial }))
  }, [])

  const updateFileDraft = useCallback((path: string, draft: string) => {
    if (!isFileTab(path)) return
    // Auto-pin on edit
    setPreviewTab(prev => prev === path ? null : prev)
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

  const updateFileViewport = useCallback((path: string, line: number) => {
    if (!isFileTab(path)) return
    setFiles(prev => {
      const existing = prev[path]
      if (!existing) return { ...prev, [path]: { ...defaultFileState(), viewportLine: line } }
      if (existing.viewportLine === line) return prev
      return { ...prev, [path]: { ...existing, viewportLine: line } }
    })
  }, [])

  const saveFile = useCallback(async (path: string, content: string): Promise<{ conflict: boolean }> => {
    if (!isFileTab(path)) return { conflict: false }
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
    if (!isFileTab(path)) return
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
    if (!isFileTab(path)) return
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
    })
  }, [])

  const actions = useMemo(() => ({
    openFileTab,
    openPreviewTab,
    openDiffTab,
    openPreviewDiffTab,
    openTasksTab,
    toggleTasksTab,
    closeTab: closeTabByKey,
    setActiveTab,
    setActiveSession,
    setMobilePane,
    updateLayout,
    updateFileDraft,
    updateFileViewport,
    saveFile,
    forceSave,
    acceptDisk,
    setPinnedSessions,
  }), [openFileTab, openPreviewTab, openDiffTab, openPreviewDiffTab, openTasksTab, toggleTasksTab, closeTabByKey, updateLayout, updateFileDraft, updateFileViewport, saveFile, forceSave, acceptDisk])

  return {
    openTabs,
    activeTab,
    previewTab,
    activeSession,
    mobilePane,
    layout,
    files,
    dirtyTabs,
    conflictTabs,
    pinnedSessions,
    actions,
  }
}
