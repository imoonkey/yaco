import { useState, useCallback, useRef } from 'react'
import {
  type WorkspaceLayout,
  type PersistedState,
  isFileTab,
  isDiffTab,
  TASKS_TAB_ID,
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
  const [pinnedSessions, setPinnedSessions] = useState<string[]>(initialLayout.pinnedSessions)

  const openTabsRef = useRef(openTabs)
  openTabsRef.current = openTabs

  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  const previewTabRef = useRef(previewTab)
  previewTabRef.current = previewTab

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

  const openTasksTab = useCallback(() => {
    setPreviewTab(prev => prev === TASKS_TAB_ID ? null : prev)
    setOpenTabs(tabs => tabs.includes(TASKS_TAB_ID) ? tabs : [...tabs, TASKS_TAB_ID])
    setActiveTab(TASKS_TAB_ID)
  }, [])

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

  const toggleTasksTab = useCallback(() => {
    const isOpen = openTabsRef.current.includes(TASKS_TAB_ID)
    if (!isOpen) {
      openTasksTab()
      return
    }
    if (activeTabRef.current === TASKS_TAB_ID) {
      closeTab(TASKS_TAB_ID)
      return
    }
    setPreviewTab(prev => prev === TASKS_TAB_ID ? null : prev)
    setActiveTab(TASKS_TAB_ID)
  }, [closeTab, openTasksTab])

  /** Clear preview pointer for a tab (auto-pin on edit) */
  const pinTab = useCallback((path: string) => {
    setPreviewTab(prev => prev === path ? null : prev)
  }, [])

  const updateLayout = useCallback((partial: Partial<WorkspaceLayout>) => {
    setLayout(prev => ({ ...prev, ...partial }))
  }, [])

  return {
    openTabs,
    activeTab,
    previewTab,
    activeSession,
    mobilePane,
    layout,
    pinnedSessions,
    openFileTab,
    openPreviewTab,
    openDiffTab,
    openPreviewDiffTab,
    openTasksTab,
    toggleTasksTab,
    closeTab,
    pinTab,
    setActiveTab,
    setActiveSession,
    setMobilePane,
    updateLayout,
    setPinnedSessions,
  }
}
