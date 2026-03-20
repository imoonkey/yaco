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

export type WorkspaceLayout = {
  showSidebar: boolean
  showRightPanel: boolean
  showExplorer: boolean
  showSessions: boolean
  showChanges: boolean
  previewMode: boolean
  leftSize: number
  rightSize: number
  explorerSize: number
  changesSize: number
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
  previewMode: false,
  leftSize: 220,
  rightSize: 420,
  explorerSize: 250,
  changesSize: 150,
}

function defaultFileState(): FileState {
  return { serverContent: null, draft: null, baseRevision: null, viewportLine: 1, status: 'clean', editedAt: 0 }
}

// --- localStorage helpers ---

function loadStoredSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

type PersistedState = {
  openTabs: string[]
  activeTab: string | null
  activeSession: string
  mobilePane: 'files' | 'editor' | 'terminal'
  layout: WorkspaceLayout
}

function loadPersistedState(project: string): PersistedState {
  const defaults: PersistedState = {
    openTabs: [],
    activeTab: null,
    activeSession: '',
    mobilePane: 'files',
    layout: { ...DEFAULT_LAYOUT },
  }

  try {
    const raw = localStorage.getItem(layoutKey(project))
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Record<string, unknown>

    const openTabs = Array.isArray(parsed.openTabs)
      ? (parsed.openTabs as unknown[]).filter((t): t is string => typeof t === 'string')
      : []
    const activeTab = typeof parsed.activeTab === 'string' && openTabs.includes(parsed.activeTab)
      ? parsed.activeTab
      : openTabs[0] ?? null

    const pl = (parsed.layout ?? parsed) as Record<string, unknown>

    return {
      openTabs,
      activeTab,
      activeSession: typeof parsed.activeSession === 'string' ? parsed.activeSession : '',
      mobilePane: parsed.mobilePane === 'files' || parsed.mobilePane === 'editor' || parsed.mobilePane === 'terminal'
        ? parsed.mobilePane as PersistedState['mobilePane'] : 'files',
      layout: {
        showSidebar: typeof pl.showSidebar === 'boolean' ? pl.showSidebar : DEFAULT_LAYOUT.showSidebar,
        showRightPanel: typeof pl.showRightPanel === 'boolean' ? pl.showRightPanel : DEFAULT_LAYOUT.showRightPanel,
        showExplorer: typeof pl.showExplorer === 'boolean' ? pl.showExplorer : DEFAULT_LAYOUT.showExplorer,
        showSessions: typeof pl.showSessions === 'boolean' ? pl.showSessions : DEFAULT_LAYOUT.showSessions,
        showChanges: typeof pl.showChanges === 'boolean' ? pl.showChanges : DEFAULT_LAYOUT.showChanges,
        previewMode: typeof pl.previewMode === 'boolean' ? pl.previewMode : DEFAULT_LAYOUT.previewMode,
        leftSize: loadStoredSize(pl.leftSize, DEFAULT_LAYOUT.leftSize),
        rightSize: loadStoredSize(pl.rightSize, DEFAULT_LAYOUT.rightSize),
        explorerSize: loadStoredSize(pl.explorerSize, DEFAULT_LAYOUT.explorerSize),
        changesSize: loadStoredSize(pl.changesSize, DEFAULT_LAYOUT.changesSize),
      },
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
    return parsed
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

async function fetchContent(project: string, path: string): Promise<{ content: string; revision: number } | null> {
  try {
    const res = await fetch(`${API}/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`)
    if (!res.ok) return null
    return res.json()
  } catch {
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
  const [activeSession, setActiveSession] = useState(persisted.activeSession)
  const [mobilePane, setMobilePane] = useState(persisted.mobilePane)
  const [layout, setLayout] = useState<WorkspaceLayout>(persisted.layout)
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

  // --- Hydration: fetch server truth for open file tabs on mount ---
  const hydrated = useRef(false)
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true

    const fileTabs = openTabs.filter(t => !t.startsWith('diff:'))
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
  const layoutRef = useRef({ openTabs, activeTab, activeSession, mobilePane, layout })
  layoutRef.current = { openTabs, activeTab, activeSession, mobilePane, layout }

  const flushLayout = useCallback(() => {
    saveLayout(projectRef.current, layoutRef.current)
  }, [])

  // Debounced persist on state changes (handles rapid resize etc.)
  const layoutTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    clearTimeout(layoutTimer.current)
    layoutTimer.current = setTimeout(flushLayout, 300)
    return () => clearTimeout(layoutTimer.current)
  }, [openTabs, activeTab, activeSession, mobilePane, layout, flushLayout])

  // --- Persist drafts ---
  const filesRef = useRef(files)
  filesRef.current = files

  const flushDrafts = useCallback(() => {
    const entries: PersistedDrafts['files'] = {}
    for (const [path, state] of Object.entries(filesRef.current)) {
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

  // --- SSE: refetch open file tabs on filetree or git changes ---
  // Zero-dep callback — reads everything from refs so identity never changes.
  // This prevents useSSERefresh from ever re-registering the callback.
  const refetchOpenFiles = useCallback(() => {
    const project = projectRef.current
    const tabs = openTabsRef.current.filter(t => !t.startsWith('diff:'))
    if (tabs.length === 0) return

    for (const path of tabs) {
      fetchContent(project, path).then(result => {
        if (projectRef.current !== project) return
        setFiles(prev => {
          const next = reconcileFile(prev[path], result)
          return next === prev[path] ? prev : { ...prev, [path]: next }
        })
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useSSERefresh('filetree', refetchOpenFiles)
  useSSERefresh('git', refetchOpenFiles)

  // --- Derived (memoized) ---
  const { dirtyTabs, conflictTabs } = useMemo(() => {
    const dirty = new Set<string>()
    const conflict = new Set<string>()
    for (const [path, state] of Object.entries(files)) {
      if (state.status === 'dirty' || state.status === 'saving') dirty.add(path)
      if (state.status === 'conflict') { dirty.add(path); conflict.add(path) }
    }
    return { dirtyTabs: dirty, conflictTabs: conflict }
  }, [files])

  // --- Tab actions ---

  const openFileTab = useCallback((path: string) => {
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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const openDiffTab = useCallback((path: string) => {
    const tab = `diff:${path}`
    setOpenTabs(tabs => tabs.includes(tab) ? tabs : [...tabs, tab])
    setActiveTab(tab)
  }, [])

  const closeTabByKey = useCallback((tab: string) => {
    setOpenTabs(tabs => {
      const idx = tabs.indexOf(tab)
      if (idx === -1) return tabs
      const next = tabs.filter(t => t !== tab)
      setActiveTab(prev => prev !== tab ? prev : next[Math.min(idx, next.length - 1)] ?? null)
      return next
    })
    if (!tab.startsWith('diff:')) {
      setFiles(prev => {
        if (!(tab in prev)) return prev
        const next = { ...prev }
        delete next[tab]
        return next
      })
    }
  }, [])

  // --- File state actions ---

  const updateLayout = useCallback((partial: Partial<WorkspaceLayout>) => {
    setLayout(prev => ({ ...prev, ...partial }))
  }, [])

  const updateFileDraft = useCallback((path: string, draft: string) => {
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
    setFiles(prev => {
      const existing = prev[path]
      if (!existing) return { ...prev, [path]: { ...defaultFileState(), viewportLine: line } }
      if (existing.viewportLine === line) return prev
      return { ...prev, [path]: { ...existing, viewportLine: line } }
    })
  }, [])

  const saveFile = useCallback(async (path: string, content: string): Promise<{ conflict: boolean }> => {
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
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const actions = useMemo(() => ({
    openFileTab,
    openDiffTab,
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
  }), [openFileTab, openDiffTab, closeTabByKey, updateLayout, updateFileDraft, updateFileViewport, saveFile, forceSave, acceptDisk])

  return {
    openTabs,
    activeTab,
    activeSession,
    mobilePane,
    layout,
    files,
    dirtyTabs,
    conflictTabs,
    actions,
  }
}
