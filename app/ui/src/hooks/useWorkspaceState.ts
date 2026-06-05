import { useCallback, useRef, useEffect, useMemo } from 'react'
import { type PersistedDrafts, isFileTab } from './workspaceTypes'
import { isBinaryPreviewFile } from '../lib/binaryFiles'
import { usePersistence } from './usePersistence'
import { useFileState } from './useFileState'
import { useLayoutState } from './useLayoutState'

// Re-export shared types and guards so existing consumers don't break
export { type FileStatus, type FileState, type PreviewMode, type SplitDirection, type WorkspaceLayout, TASKS_TAB_ID, DEFAULT_LAYOUT, isDiffTab, isTasksTab, isFileTab, parseDiffTab } from './workspaceTypes'

export function useWorkspaceState(projectName: string, worktree?: string | null) {
  // Phase 1: load persisted state
  const { initialLayout, initialDrafts, bindSnapshots, scheduleLayoutSave, scheduleDraftsSave } = usePersistence(projectName, worktree)

  // Shared ref: tracks current open tabs for SSE refetch in useFileState
  const openTabsRef = useRef(initialLayout.openTabs)

  // Phase 2: create domain hooks
  const {
    files, filesRef, dirtyTabs, conflictTabs,
    previewLifecycle,
    fetchForTab, removeFile, retargetFile, removeFilesUnder,
    updateDraft, updateViewport,
    save, forceSave, acceptDisk,
  } = useFileState(projectName, worktree, initialDrafts, initialLayout.openTabs, openTabsRef)

  const ls = useLayoutState(initialLayout, previewLifecycle)

  // Latest layout snapshot for SSE refetch + persistence getters.
  const layoutValue = { openTabs: ls.openTabs, activeTab: ls.activeTab, previewTab: ls.previewTab, activeSession: ls.activeSession, mobilePane: ls.mobilePane, layout: ls.layout, recentFiles: ls.recentFiles }
  const layoutRef = useRef(layoutValue)
  useEffect(() => {
    openTabsRef.current = ls.openTabs
    layoutRef.current = layoutValue
  })

  // Phase 3: bind persistence snapshots once on mount. Getters read latest refs lazily.
  useEffect(() => {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Schedule persistence on state changes
  useEffect(() => {
    scheduleLayoutSave()
  }, [ls.openTabs, ls.activeTab, ls.previewTab, ls.activeSession, ls.mobilePane, ls.layout, ls.recentFiles, scheduleLayoutSave])

  useEffect(() => {
    scheduleDraftsSave()
  }, [files, scheduleDraftsSave])

  // Phase 4: compose cross-cutting actions
  const openFileTab = useCallback((path: string) => {
    if (!isFileTab(path)) return
    ls.openFileTab(path)
    ls.addRecentFile(path)
    if (!isBinaryPreviewFile(path)) fetchForTab(path)
  }, [ls.openFileTab, ls.addRecentFile, fetchForTab])

  const openPreviewTab = useCallback((path: string) => {
    if (!isFileTab(path)) return
    const shouldFetch = ls.openPreviewTab(path)
    ls.addRecentFile(path)
    if (shouldFetch && !isBinaryPreviewFile(path)) fetchForTab(path)
  }, [ls.openPreviewTab, ls.addRecentFile, fetchForTab])

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

  /** Retarget tabs and file state when a file/dir is renamed or moved */
  const retargetPaths = useCallback((oldPath: string, newPath: string) => {
    ls.retargetPaths(oldPath, newPath)
    retargetFile(oldPath, newPath)
  }, [ls.retargetPaths, retargetFile])

  /** Close tabs and remove file state when a file/dir is deleted */
  const onDeletePath = useCallback((path: string) => {
    ls.closeTabsUnder(path)
    removeFilesUnder(path)
  }, [ls.closeTabsUnder, removeFilesUnder])

  const actions = useMemo(() => ({
    openFileTab,
    openPreviewTab,
    openDiffTab: ls.openDiffTab,
    openPreviewDiffTab: ls.openPreviewDiffTab,
    openPreviewDiffTabById: ls.openPreviewDiffTabById,
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
    retargetPaths,
    onDeletePath,
  }), [openFileTab, openPreviewTab, ls.openDiffTab, ls.openPreviewDiffTab, ls.openPreviewDiffTabById, ls.openTasksTab, ls.toggleTasksTab, closeTab, ls.setActiveTab, ls.setActiveSession, ls.setMobilePane, ls.updateLayout, updateFileDraft, updateFileViewport, saveFile, wrappedForceSave, wrappedAcceptDisk, retargetPaths, onDeletePath])

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
    recentFiles: ls.recentFiles,
    actions,
  }
}
