import { useCallback, useRef, useEffect, useMemo } from 'react'
import { type PersistedDrafts, isFileTab } from './workspaceTypes'
import { usePersistence } from './usePersistence'
import { useFileState } from './useFileState'
import { useLayoutState } from './useLayoutState'

// Re-export shared types and guards so existing consumers don't break
export { type FileStatus, type FileState, type MdMode, type WorkspaceLayout, TASKS_TAB_ID, DEFAULT_LAYOUT, isDiffTab, isTasksTab, isFileTab } from './workspaceTypes'

export function useWorkspaceState(projectName: string) {
  // Phase 1: load persisted state
  const { initialLayout, initialDrafts, bindSnapshots, scheduleLayoutSave, scheduleDraftsSave } = usePersistence(projectName)

  // Shared ref: tracks current open tabs for SSE refetch in useFileState
  const openTabsRef = useRef(initialLayout.openTabs)

  // Phase 2: create domain hooks
  const {
    files, filesRef, dirtyTabs, conflictTabs,
    previewLifecycle,
    fetchForTab, removeFile,
    updateDraft, updateViewport,
    save, forceSave, acceptDisk,
  } = useFileState(projectName, initialDrafts, initialLayout.openTabs, openTabsRef)

  const ls = useLayoutState(initialLayout, previewLifecycle)

  // Keep open tabs ref in sync for SSE refetch
  openTabsRef.current = ls.openTabs

  // Phase 3: bind persistence snapshots (once)
  const layoutRef = useRef({ openTabs: ls.openTabs, activeTab: ls.activeTab, previewTab: ls.previewTab, activeSession: ls.activeSession, mobilePane: ls.mobilePane, layout: ls.layout, pinnedSessions: ls.pinnedSessions })
  layoutRef.current = { openTabs: ls.openTabs, activeTab: ls.activeTab, previewTab: ls.previewTab, activeSession: ls.activeSession, mobilePane: ls.mobilePane, layout: ls.layout, pinnedSessions: ls.pinnedSessions }

  const bound = useRef(false)
  if (!bound.current) {
    bound.current = true
    bindSnapshots({
      layoutRef: () => layoutRef.current,
      draftsRef: (): PersistedDrafts => {
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
        return { files: entries }
      },
    })
  }

  // Schedule persistence on state changes
  useEffect(() => {
    scheduleLayoutSave()
  }, [ls.openTabs, ls.activeTab, ls.previewTab, ls.activeSession, ls.mobilePane, ls.layout, ls.pinnedSessions, scheduleLayoutSave])

  useEffect(() => {
    scheduleDraftsSave()
  }, [files, scheduleDraftsSave])

  // Phase 4: compose cross-cutting actions
  const openFileTab = useCallback((path: string) => {
    if (!isFileTab(path)) return
    ls.openFileTab(path)
    fetchForTab(path)
  }, [ls.openFileTab, fetchForTab])

  const openPreviewTab = useCallback((path: string) => {
    if (!isFileTab(path)) return
    const shouldFetch = ls.openPreviewTab(path)
    if (shouldFetch) fetchForTab(path)
  }, [ls.openPreviewTab, fetchForTab])

  const closeTab = useCallback((tab: string) => {
    ls.closeTab(tab)
    removeFile(tab)
  }, [ls.closeTab, removeFile])

  const updateFileDraft = useCallback((path: string, draft: string) => {
    if (!isFileTab(path)) return
    ls.pinTab(path)
    updateDraft(path, draft)
  }, [ls.pinTab, updateDraft])

  const updateFileViewport = useCallback((path: string, line: number) => {
    if (!isFileTab(path)) return
    updateViewport(path, line)
  }, [updateViewport])

  const saveFile = useCallback(async (path: string, content: string): Promise<{ conflict: boolean }> => {
    if (!isFileTab(path)) return { conflict: false }
    return save(path, content)
  }, [save])

  const wrappedForceSave = useCallback(async (path: string, content: string) => {
    if (!isFileTab(path)) return
    return forceSave(path, content)
  }, [forceSave])

  const wrappedAcceptDisk = useCallback((path: string) => {
    if (!isFileTab(path)) return
    acceptDisk(path)
  }, [acceptDisk])

  const actions = useMemo(() => ({
    openFileTab,
    openPreviewTab,
    openDiffTab: ls.openDiffTab,
    openPreviewDiffTab: ls.openPreviewDiffTab,
    openTasksTab: ls.openTasksTab,
    toggleTasksTab: ls.toggleTasksTab,
    closeTab,
    setActiveTab: ls.setActiveTab,
    setActiveSession: ls.setActiveSession,
    setMobilePane: ls.setMobilePane,
    updateLayout: ls.updateLayout,
    updateFileDraft,
    updateFileViewport,
    saveFile,
    forceSave: wrappedForceSave,
    acceptDisk: wrappedAcceptDisk,
    setPinnedSessions: ls.setPinnedSessions,
  }), [openFileTab, openPreviewTab, ls.openDiffTab, ls.openPreviewDiffTab, ls.openTasksTab, ls.toggleTasksTab, closeTab, ls.setActiveTab, ls.setActiveSession, ls.setMobilePane, ls.updateLayout, updateFileDraft, updateFileViewport, saveFile, wrappedForceSave, wrappedAcceptDisk, ls.setPinnedSessions])

  return {
    openTabs: ls.openTabs,
    activeTab: ls.activeTab,
    previewTab: ls.previewTab,
    activeSession: ls.activeSession,
    mobilePane: ls.mobilePane,
    layout: ls.layout,
    files,
    dirtyTabs,
    conflictTabs,
    pinnedSessions: ls.pinnedSessions,
    actions,
  }
}
