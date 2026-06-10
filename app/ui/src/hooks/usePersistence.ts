import { useState, useCallback, useRef, useEffect } from 'react'
import {
  type PersistedState,
  type PersistedDrafts,
  type WorkspaceLayout,
  type WorkspacePanelLayout,
  DEFAULT_LAYOUT,
  isFileTab,
  isTasksTab,
  layoutKey,
  draftsKey,
  loadStoredSize,
  dedupeTabs,
} from './workspaceTypes'
import { defaultWorkspacePanelLayout, normalizeLayout } from '../workspace/panelLayoutModel'

// --- Load helpers ---

function defaultPersistedState(): PersistedState {
  return {
    openTabs: [],
    activeTab: null,
    previewTab: null,
    activeSession: '',
    mobilePane: 'files',
    layout: { ...DEFAULT_LAYOUT },
    recentFiles: [],
    panelLayout: defaultWorkspacePanelLayout(),
  }
}

/** Parse the flat `WorkspaceLayout` bag, salvaging every field independently to
 *  its default. `pl` is `parsed.layout` (or `parsed` itself for very old blobs
 *  that stored the fields at the top level). */
function parseFlatLayout(pl: Record<string, unknown>): WorkspaceLayout {
  return {
    showSidebar: typeof pl.showSidebar === 'boolean' ? pl.showSidebar : DEFAULT_LAYOUT.showSidebar,
    showRightPanel: typeof pl.showRightPanel === 'boolean' ? pl.showRightPanel : DEFAULT_LAYOUT.showRightPanel,
    showProjects: typeof pl.showProjects === 'boolean' ? pl.showProjects : DEFAULT_LAYOUT.showProjects,
    showExplorer: typeof pl.showExplorer === 'boolean' ? pl.showExplorer : DEFAULT_LAYOUT.showExplorer,
    showSessions: typeof pl.showSessions === 'boolean' ? pl.showSessions : DEFAULT_LAYOUT.showSessions,
    showChanges: typeof pl.showChanges === 'boolean' ? pl.showChanges : DEFAULT_LAYOUT.showChanges,
    showTasks: typeof pl.showTasks === 'boolean' ? pl.showTasks : DEFAULT_LAYOUT.showTasks,
    showTextSearch: typeof pl.showTextSearch === 'boolean' ? pl.showTextSearch : DEFAULT_LAYOUT.showTextSearch,
    autocompleteEnabled: typeof pl.autocompleteEnabled === 'boolean' ? pl.autocompleteEnabled : DEFAULT_LAYOUT.autocompleteEnabled,
    previewMode: pl.previewMode === 'edit' || pl.previewMode === 'preview' || pl.previewMode === 'split' ? pl.previewMode
      : DEFAULT_LAYOUT.previewMode,
    splitDirection: pl.splitDirection === 'horizontal' || pl.splitDirection === 'vertical' ? pl.splitDirection : DEFAULT_LAYOUT.splitDirection,
    splitSize: typeof pl.splitSize === 'number' && pl.splitSize >= 20 && pl.splitSize <= 80 ? pl.splitSize : DEFAULT_LAYOUT.splitSize,
    leftSize: loadStoredSize(pl.leftSize, DEFAULT_LAYOUT.leftSize),
    rightSize: loadStoredSize(pl.rightSize, DEFAULT_LAYOUT.rightSize),
    explorerSize: loadStoredSize(pl.explorerSize, DEFAULT_LAYOUT.explorerSize),
    searchSize: loadStoredSize(pl.searchSize, DEFAULT_LAYOUT.searchSize),
    changesSize: loadStoredSize(pl.changesSize, DEFAULT_LAYOUT.changesSize),
    sessionSize: loadStoredSize(pl.sessionSize, DEFAULT_LAYOUT.sessionSize),
    projectSize: loadStoredSize(pl.projectSize, DEFAULT_LAYOUT.projectSize),
  }
}

/** Derive the panel-layout tree (design: Persistence Shape / Load behavior).
 *
 *  - A stored `version: 1` tree is validated + normalized; `normalizeLayout`
 *    salvages every field independently (tree → default subtree, mobile dock,
 *    panel state), so a malformed tree is repaired, never wholesale discarded.
 *  - Any other input is an old flat blob: use the default desktop/mobile
 *    arrangement and lift only the four editor preference fields into
 *    `panelState.editor`. They are read from the already-salvaged `flat` layout,
 *    so an invalid pref falls back to its default per field. */
function migratePanelLayout(parsed: Record<string, unknown>, flat: WorkspaceLayout): WorkspacePanelLayout {
  const stored = parsed.panelLayout
  if (stored && typeof stored === 'object' && (stored as Record<string, unknown>).version === 1) {
    return normalizeLayout(stored)
  }
  const base = defaultWorkspacePanelLayout()
  return {
    ...base,
    panelState: {
      ...base.panelState,
      editor: {
        previewMode: flat.previewMode,
        splitDirection: flat.splitDirection,
        splitSize: flat.splitSize,
        autocompleteEnabled: flat.autocompleteEnabled,
      },
    },
  }
}

export function loadPersistedState(project: string, worktree?: string | null): PersistedState {
  try {
    const raw = localStorage.getItem(layoutKey(project, worktree))
    if (!raw) return defaultPersistedState()
    const parsed = JSON.parse(raw) as Record<string, unknown>

    const openTabs = dedupeTabs(Array.isArray(parsed.openTabs)
      ? (parsed.openTabs as unknown[]).filter((t): t is string => typeof t === 'string')
      : [])
    const activeTab = typeof parsed.activeTab === 'string' && openTabs.includes(parsed.activeTab)
      ? parsed.activeTab
      : openTabs[0] ?? null

    const pl = (parsed.layout ?? parsed) as Record<string, unknown>
    const layout = parseFlatLayout(pl)

    return {
      openTabs,
      activeTab,
      previewTab: typeof parsed.previewTab === 'string' && openTabs.includes(parsed.previewTab) && !isTasksTab(parsed.previewTab)
        ? parsed.previewTab
        : null,
      activeSession: typeof parsed.activeSession === 'string' ? parsed.activeSession : '',
      mobilePane: parsed.mobilePane === 'files' || parsed.mobilePane === 'editor' || parsed.mobilePane === 'tasks' || parsed.mobilePane === 'terminal'
        ? parsed.mobilePane as PersistedState['mobilePane'] : 'files',
      layout,
      recentFiles: Array.isArray(parsed.recentFiles)
        ? (parsed.recentFiles as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 50)
        : [],
      panelLayout: migratePanelLayout(parsed, layout),
    }
  } catch {
    return defaultPersistedState()
  }
}

export function loadPersistedDrafts(project: string, worktree?: string | null): PersistedDrafts {
  try {
    const raw = localStorage.getItem(draftsKey(project, worktree))
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

export function saveLayout(project: string, worktree: string | null | undefined, state: PersistedState): void {
  try {
    localStorage.setItem(layoutKey(project, worktree), JSON.stringify(state))
  } catch { /* layout is tiny — quota should never be an issue */ }
}

function saveDrafts(project: string, worktree: string | null | undefined, drafts: PersistedDrafts): void {
  try {
    localStorage.setItem(draftsKey(project, worktree), JSON.stringify(drafts))
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      const entries = Object.entries(drafts.files).sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      while (entries.length > 0) {
        entries.shift()
        try {
          localStorage.setItem(draftsKey(project, worktree), JSON.stringify({ files: Object.fromEntries(entries) }))
          return
        } catch { continue }
      }
      // All evicted — persist empty so next load doesn't restore stale data
      try { localStorage.setItem(draftsKey(project, worktree), JSON.stringify({ files: {} })) } catch { /* noop */ }
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
export function usePersistence(projectName: string, worktree?: string | null) {
  const [initialLayout] = useState(() => loadPersistedState(projectName, worktree))
  const [initialDrafts] = useState(() => loadPersistedDrafts(projectName, worktree))

  const projectRef = useRef(projectName)
  const worktreeRef = useRef(worktree)
  // Mirror latest project/worktree for flush callbacks that read without re-subscribing.
  useEffect(() => {
    projectRef.current = projectName
    worktreeRef.current = worktree
  })

  const layoutSnapshotRef = useRef<(() => PersistedState) | null>(null)
  const draftsSnapshotRef = useRef<(() => PersistedDrafts) | null>(null)

  const flushLayout = useCallback(() => {
    if (layoutSnapshotRef.current) {
      saveLayout(projectRef.current, worktreeRef.current, layoutSnapshotRef.current())
    }
  }, [])

  const flushDrafts = useCallback(() => {
    if (draftsSnapshotRef.current) {
      saveDrafts(projectRef.current, worktreeRef.current, draftsSnapshotRef.current())
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
