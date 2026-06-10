import { useState, useCallback, useRef, useEffect } from 'react'
import {
  type WorkspaceLayout,
  type WorkspacePanelLayout,
  type PersistedState,
  isFileTab,
  isDiffTab,
} from './workspaceTypes'
import type { PreviewLifecycle } from './useFileState'

export function useLayoutState(
  initialLayout: PersistedState,
  previewLifecycle: PreviewLifecycle,
) {
  const [openTabs, setOpenTabs] = useState<string[]>(initialLayout.openTabs)
  const [activeTab, setActiveTab] = useState<string | null>(initialLayout.activeTab)
  const [previewTab, setPreviewTab] = useState<string | null>(initialLayout.previewTab)
  const [activeSession, setActiveSession] = useState(initialLayout.activeSession)
  const [mobilePane, setMobilePane] = useState(initialLayout.mobilePane)
  const [layout, setLayout] = useState<WorkspaceLayout>(initialLayout.layout)
  const [recentFiles, setRecentFiles] = useState<string[]>(initialLayout.recentFiles)
  // Panel-layout tree, seeded from the migrated persisted state. The tree
  // renderer (engine: 'tree') reads it and the layout commands mutate it via
  // `setPanelLayout` (the provider funnels every model edit through this setter);
  // the legacy renderer ignores it. Persistence already carries it on every save.
  const [panelLayout, setPanelLayout] = useState<WorkspacePanelLayout>(initialLayout.panelLayout)

  const openTabsRef = useRef(openTabs)
  const activeTabRef = useRef(activeTab)
  const previewTabRef = useRef(previewTab)
  // Mirror latest values for callbacks/effects that read without re-subscribing.
  useEffect(() => {
    openTabsRef.current = openTabs
    activeTabRef.current = activeTab
    previewTabRef.current = previewTab
  })

  // --- Shared: close old preview tab when opening a new one ---
  const closeOldPreview = useCallback((newTab: string) => {
    const oldPreview = previewTabRef.current
    if (!oldPreview || oldPreview === newTab) return

    if (isFileTab(oldPreview)) {
      if (previewLifecycle.canDropPreview(oldPreview)) {
        previewLifecycle.onDropPreview(oldPreview)
        setOpenTabs(tabs => tabs.filter(t => t !== oldPreview))
      }
      // If can't drop (dirty/saving/conflict), tab stays auto-pinned
    } else {
      // Diff tabs and other non-file previews are always droppable
      setOpenTabs(tabs => tabs.filter(t => t !== oldPreview))
    }
  }, [previewLifecycle])

  // --- Tab actions ---

  /** Open a file tab (pin if it was a preview, add to tabs, activate) */
  const openFileTab = useCallback((path: string) => {
    setPreviewTab(prev => prev === path ? null : prev)
    setOpenTabs(tabs => tabs.includes(path) ? tabs : [...tabs, path])
    setActiveTab(path)
  }, [])

  /**
   * Open a file as a preview tab. Returns false if the tab was already open
   * as a pinned tab (just activated, no fetch needed), true otherwise.
   */
  const openPreviewTab = useCallback((path: string): boolean => {
    // If already open as a pinned tab, just activate — don't demote to preview
    if (openTabsRef.current.includes(path) && previewTabRef.current !== path) {
      setActiveTab(path)
      return false
    }
    closeOldPreview(path)
    setOpenTabs(tabs => tabs.includes(path) ? tabs : [...tabs, path])
    setActiveTab(path)
    setPreviewTab(path)
    return true
  }, [closeOldPreview])

  const openDiffTab = useCallback((path: string) => {
    const tab = `diff:${path}`
    setOpenTabs(tabs => tabs.includes(tab) ? tabs : [...tabs, tab])
    setActiveTab(tab)
  }, [])

  const openPreviewDiffTab = useCallback((path: string) => {
    const tab = `diff:${path}`
    // If already open as pinned, just activate
    if (openTabsRef.current.includes(tab) && previewTabRef.current !== tab) {
      setActiveTab(tab)
      return
    }
    closeOldPreview(tab)
    setOpenTabs(tabs => tabs.includes(tab) ? tabs : [...tabs, tab])
    setActiveTab(tab)
    setPreviewTab(tab)
  }, [closeOldPreview])

  /** Open a diff tab as preview using a pre-built tab ID (for compare diffs) */
  const openPreviewDiffTabById = useCallback((tabId: string) => {
    if (openTabsRef.current.includes(tabId) && previewTabRef.current !== tabId) {
      setActiveTab(tabId)
      return
    }
    closeOldPreview(tabId)
    setOpenTabs(tabs => tabs.includes(tabId) ? tabs : [...tabs, tabId])
    setActiveTab(tabId)
    setPreviewTab(tabId)
  }, [closeOldPreview])

  const closeTab = useCallback((tab: string) => {
    setPreviewTab(prev => prev === tab ? null : prev)
    setOpenTabs(tabs => {
      const idx = tabs.indexOf(tab)
      if (idx === -1) return tabs
      const next = tabs.filter(t => t !== tab)
      setActiveTab(prev => prev !== tab ? prev : next[Math.min(idx, next.length - 1)] ?? null)
      return next
    })
  }, [])

  /** Clear preview pointer for a tab (auto-pin on edit) */
  const pinTab = useCallback((path: string) => {
    setPreviewTab(prev => prev === path ? null : prev)
  }, [])

  const updateLayout = useCallback((partial: Partial<WorkspaceLayout>) => {
    setLayout(prev => ({ ...prev, ...partial }))
  }, [])

  const addRecentFile = useCallback((path: string) => {
    setRecentFiles(prev => {
      const next = [path, ...prev.filter(p => p !== path)]
      return next.length > 50 ? next.slice(0, 50) : next
    })
  }, [])

  /** Retarget tabs when a file or directory is renamed/moved */
  const retargetPaths = useCallback((oldPath: string, newPath: string) => {
    const remap = (tab: string): string => {
      // Exact file match
      if (tab === oldPath) return newPath
      // Diff tab for exact file
      if (tab === `diff:${oldPath}`) return `diff:${newPath}`
      // Directory prefix match (oldPath is a dir)
      if (isFileTab(tab) && tab.startsWith(oldPath + '/')) {
        return newPath + tab.slice(oldPath.length)
      }
      if (isDiffTab(tab) && tab.slice(5).startsWith(oldPath + '/')) {
        return 'diff:' + newPath + tab.slice(5 + oldPath.length)
      }
      return tab
    }
    setOpenTabs(tabs => {
      const next = tabs.map(remap)
      return next.some((t, i) => t !== tabs[i]) ? next : tabs
    })
    setActiveTab(prev => prev ? remap(prev) : prev)
    setPreviewTab(prev => prev ? remap(prev) : prev)
  }, [])

  /** Close all tabs under a path (file or directory prefix) */
  const closeTabsUnder = useCallback((path: string) => {
    const matches = (tab: string): boolean => {
      if (tab === path) return true
      if (tab === `diff:${path}`) return true
      if (isFileTab(tab) && tab.startsWith(path + '/')) return true
      if (isDiffTab(tab) && tab.slice(5).startsWith(path + '/')) return true
      return false
    }
    setOpenTabs(tabs => {
      const next = tabs.filter(t => !matches(t))
      if (next.length === tabs.length) return tabs
      setActiveTab(prev => prev && matches(prev) ? (next[0] ?? null) : prev)
      setPreviewTab(prev => prev && matches(prev) ? null : prev)
      return next
    })
  }, [])

  return {
    openTabs,
    activeTab,
    previewTab,
    activeSession,
    mobilePane,
    layout,
    panelLayout,
    setPanelLayout,
    recentFiles,
    openFileTab,
    openPreviewTab,
    openDiffTab,
    openPreviewDiffTab,
    openPreviewDiffTabById,
    closeTab,
    pinTab,
    setActiveTab,
    setActiveSession,
    setMobilePane,
    updateLayout,
    addRecentFile,
    retargetPaths,
    closeTabsUnder,
  }
}
