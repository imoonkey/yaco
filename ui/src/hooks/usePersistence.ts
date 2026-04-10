import { useState, useCallback, useRef, useEffect } from 'react'
import {
  type PersistedState,
  type PersistedDrafts,
  DEFAULT_LAYOUT,
  isFileTab,
  isTasksTab,
  layoutKey,
  draftsKey,
  loadStoredSize,
  dedupeTabs,
} from './workspaceTypes'

// --- Load helpers ---

function loadPersistedState(project: string): PersistedState {
  const defaults: PersistedState = {
    openTabs: [],
    activeTab: null,
    previewTab: null,
    activeSession: '',
    mobilePane: 'files',
    layout: { ...DEFAULT_LAYOUT },
    pinnedSessions: [],
    recentFiles: [],
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
        showProjects: typeof pl.showProjects === 'boolean' ? pl.showProjects : DEFAULT_LAYOUT.showProjects,
        showExplorer: typeof pl.showExplorer === 'boolean' ? pl.showExplorer : DEFAULT_LAYOUT.showExplorer,
        showSessions: typeof pl.showSessions === 'boolean' ? pl.showSessions : DEFAULT_LAYOUT.showSessions,
        showChanges: typeof pl.showChanges === 'boolean' ? pl.showChanges : DEFAULT_LAYOUT.showChanges,
        showTasks: typeof pl.showTasks === 'boolean' ? pl.showTasks : DEFAULT_LAYOUT.showTasks,
        showTextSearch: typeof pl.showTextSearch === 'boolean' ? pl.showTextSearch : DEFAULT_LAYOUT.showTextSearch,
        autocompleteEnabled: typeof pl.autocompleteEnabled === 'boolean' ? pl.autocompleteEnabled : DEFAULT_LAYOUT.autocompleteEnabled,
        mdMode: pl.mdMode === 'edit' || pl.mdMode === 'preview' || pl.mdMode === 'split' ? pl.mdMode
          : typeof pl.previewMode === 'boolean' ? (pl.previewMode ? 'preview' : 'edit')
          : DEFAULT_LAYOUT.mdMode,
        splitDirection: pl.splitDirection === 'horizontal' || pl.splitDirection === 'vertical' ? pl.splitDirection : DEFAULT_LAYOUT.splitDirection,
        splitSize: typeof pl.splitSize === 'number' && pl.splitSize >= 20 && pl.splitSize <= 80 ? pl.splitSize : DEFAULT_LAYOUT.splitSize,
        leftSize: loadStoredSize(pl.leftSize, DEFAULT_LAYOUT.leftSize),
        rightSize: loadStoredSize(pl.rightSize, DEFAULT_LAYOUT.rightSize),
        explorerSize: loadStoredSize(pl.explorerSize, DEFAULT_LAYOUT.explorerSize),
        searchSize: loadStoredSize(pl.searchSize, DEFAULT_LAYOUT.searchSize),
        changesSize: loadStoredSize(pl.changesSize, DEFAULT_LAYOUT.changesSize),
        sessionSize: loadStoredSize(pl.sessionSize, DEFAULT_LAYOUT.sessionSize),
        projectSize: loadStoredSize(pl.projectSize, DEFAULT_LAYOUT.projectSize),
      },
      pinnedSessions: Array.isArray(parsed.pinnedSessions)
        ? (parsed.pinnedSessions as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
      recentFiles: Array.isArray(parsed.recentFiles)
        ? (parsed.recentFiles as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 50)
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

// --- Save helpers ---

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

// --- Hook ---

/**
 * Two-phase persistence hook.
 * Phase 1: returns initialLayout + initialDrafts synchronously at mount.
 * Phase 2: call bindSnapshots() after state hooks are created to enable
 *          debounced saves and synchronous beforeunload/unmount flush.
 */
export function usePersistence(projectName: string) {
  const [initialLayout] = useState(() => loadPersistedState(projectName))
  const [initialDrafts] = useState(() => loadPersistedDrafts(projectName))

  const projectRef = useRef(projectName)
  projectRef.current = projectName

  const layoutSnapshotRef = useRef<(() => PersistedState) | null>(null)
  const draftsSnapshotRef = useRef<(() => PersistedDrafts) | null>(null)

  const flushLayout = useCallback(() => {
    if (layoutSnapshotRef.current) {
      saveLayout(projectRef.current, layoutSnapshotRef.current())
    }
  }, [])

  const flushDrafts = useCallback(() => {
    if (draftsSnapshotRef.current) {
      saveDrafts(projectRef.current, draftsSnapshotRef.current())
    }
  }, [])

  // Debounce timers
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const scheduleLayoutSave = useCallback(() => {
    clearTimeout(layoutTimer.current)
    layoutTimer.current = setTimeout(flushLayout, 300)
  }, [flushLayout])

  const scheduleDraftsSave = useCallback(() => {
    clearTimeout(draftsTimer.current)
    draftsTimer.current = setTimeout(flushDrafts, 500)
  }, [flushDrafts])

  // Synchronous flush on page unload
  useEffect(() => {
    const onBeforeUnload = () => {
      flushLayout()
      flushDrafts()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushLayout, flushDrafts])

  // Synchronous flush on unmount + timer cleanup
  useEffect(() => () => {
    flushLayout()
    flushDrafts()
    clearTimeout(layoutTimer.current)
    clearTimeout(draftsTimer.current)
  }, [flushLayout, flushDrafts])

  const bindSnapshots = useCallback((snapshots: {
    layoutRef: () => PersistedState
    draftsRef: () => PersistedDrafts
  }) => {
    layoutSnapshotRef.current = snapshots.layoutRef
    draftsSnapshotRef.current = snapshots.draftsRef
  }, [])

  return { initialLayout, initialDrafts, bindSnapshots, scheduleLayoutSave, scheduleDraftsSave }
}
