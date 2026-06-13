import { useCallback, useRef, useEffect, useMemo } from 'react'
import { type PersistedDrafts, type LayoutNode, isFileTab, parseDiffTab } from './workspaceTypes'
import { isBinaryPreviewFile } from '../lib/binaryFiles'
import { usePersistence } from './usePersistence'
import { useFileState } from './useFileState'
import { useLayoutState, editorTabByInstance } from './useLayoutState'
import { editorTabPaths, editorInstancesInOrder, groupOf } from '../workspace/panelLayoutModel'

// Re-export shared types and guards so existing consumers don't break
export { type FileStatus, type FileState, type PreviewMode, type SplitDirection, type WorkspaceLayout, DEFAULT_LAYOUT, isDiffTab, isFileTab, parseDiffTab } from './workspaceTypes'

/** The underlying file path of an editor tab id (a diff tab's target, else itself). */
function tabFilePath(tabId: string): string | null {
  const diff = parseDiffTab(tabId)
  if (diff) return diff.path
  return isFileTab(tabId) ? tabId : null
}

/** A stable, collision-free signature for the shared-buffer keep-set. JSON (not a
 *  space-join) so a filename-legal character — a space in "src/my file.ts" — never
 *  splits one path into two, which would drop a still-referenced clean buffer and
 *  break SSE refetch tracking. */
export function keepPathsSignature(paths: string[]): string {
  return JSON.stringify([...paths].sort())
}

/** Rebuild the keep-set from its signature, preserving every path verbatim. */
export function parseKeepPaths(sig: string): Set<string> {
  return new Set<string>(JSON.parse(sig) as string[])
}

export function useWorkspaceState(projectName: string, worktree?: string | null) {
  // Phase 1: load persisted state
  const { initialLayout, initialDrafts, bindSnapshots, scheduleLayoutSave, scheduleDraftsSave } = usePersistence(projectName, worktree)

  // Union of file-tab paths across the restored group tree — what useFileState
  // hydrates on mount and refetches on SSE. Computed once from the migrated tree.
  const initialOpenTabs = useMemo(() => editorTabPaths(initialLayout.panelLayout.desktop), [initialLayout.panelLayout.desktop])

  // Shared ref: tracks the current open-file-tab union for SSE refetch in useFileState
  const openTabsRef = useRef(initialOpenTabs)

  // Phase 2: create domain hooks
  const {
    files, filesRef, dirtyTabs, conflictTabs,
    gcBuffers,
    fetchForTab, retargetFile, removeFilesUnder,
    updateDraft, updateViewport,
    save, forceSave, acceptDisk,
  } = useFileState(projectName, worktree, initialDrafts, initialOpenTabs, openTabsRef)

  // The dirty set, mirrored into a ref so the reducer's preview-drop decision
  // (keep a dirty old preview pinned) reads it without re-creating callbacks.
  const dirtyPathsRef = useRef<ReadonlySet<string>>(dirtyTabs)
  useEffect(() => { dirtyPathsRef.current = dirtyTabs })

  const ls = useLayoutState(initialLayout, dirtyPathsRef)

  // Latest layout snapshot for SSE refetch + persistence getters (group shape).
  const layoutValue = {
    terminalBindings: ls.terminalBindings,
    editorMru: ls.editorMru, terminalMru: ls.terminalMru, activeGroupId: ls.activeGroupId,
    mobilePane: ls.mobilePane, layout: ls.layout, panelLayout: ls.panelLayout, recentFiles: ls.recentFiles,
  }
  const layoutRef = useRef(layoutValue)

  // The open-file-tab union, derived from the live group tree; identity is stable
  // across edits that don't change the union (a JSON signature) so the buffer-GC
  // effect stays calm. JSON.stringify never collides on a filename-legal char (a
  // space in a path must not split a single path into two). allEditorTabPaths =
  // editorTabPaths.
  const openFileTabsSig = useMemo(() => keepPathsSignature(editorTabPaths(ls.panelLayout.desktop)), [ls.panelLayout.desktop])
  const openFileTabSet = useMemo(
    () => parseKeepPaths(openFileTabsSig), [openFileTabsSig],
  )

  // Mirror the open-tab union + layout snapshot in an effect for the SSE refetch
  // list and the beforeunload/unmount flush.
  useEffect(() => {
    openTabsRef.current = [...openFileTabSet]
    layoutRef.current = layoutValue
  })

  // Shared-buffer GC: after any tree mutation (or a file going clean), drop every
  // buffer no editor tab references and that is not dirty (design: §B). Keyed on
  // the union signature + dirty set so it runs on the POST-mutation union.
  useEffect(() => { gcBuffers(openFileTabSet) }, [openFileTabSet, dirtyTabs, gcBuffers])

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
  }, [ls.terminalBindings, ls.editorMru, ls.terminalMru, ls.activeGroupId, ls.mobilePane, ls.layout, ls.panelLayout, ls.recentFiles, scheduleLayoutSave])

  useEffect(() => {
    scheduleDraftsSave()
  }, [files, scheduleDraftsSave])

  // Phase 4: composed file-open helpers (group-targeted). A file open also loads
  // its shared-by-path buffer; a diff open does not (diff bodies fetch their own).
  const openFileInGroup = useCallback((groupId: string, path: string): string | null => {
    if (!isFileTab(path)) return null
    const instanceId = ls.openTab(groupId, path)
    ls.addRecentFile(path)
    if (!isBinaryPreviewFile(path)) fetchForTab(path)
    return instanceId
  }, [ls.openTab, ls.addRecentFile, fetchForTab])

  const previewFileInGroup = useCallback((groupId: string, path: string) => {
    if (!isFileTab(path)) return
    const shouldFetch = ls.openPreviewTab(groupId, path)
    ls.addRecentFile(path)
    if (shouldFetch && !isBinaryPreviewFile(path)) fetchForTab(path)
  }, [ls.openPreviewTab, ls.addRecentFile, fetchForTab])

  const openDiffInGroup = useCallback((groupId: string, tabId: string) => {
    ls.openDiffTab(groupId, tabId)
  }, [ls.openDiffTab])

  const previewDiffInGroup = useCallback((groupId: string, tabId: string) => {
    ls.openPreviewTab(groupId, tabId)
  }, [ls.openPreviewTab])

  // A draft promotes a preview tab to pinned: pin every preview editor tab on this
  // path (the shared-buffer edit could surface in more than one pane).
  const pinPreviewsOnPath = useCallback((path: string) => {
    const tree: LayoutNode = ls.panelLayout.desktop
    for (const id of editorInstancesInOrder(tree)) {
      const tab = editorTabByInstance(tree, id)
      if (tab && tab.kind === 'editor' && tab.preview && tabFilePath(tab.tabId) === path) {
        const g = groupOf(tree, id)
        if (g) ls.pinTab(g, id)
      }
    }
  }, [ls.panelLayout.desktop, ls.pinTab])

  const updateFileDraft = useCallback((path: string, draft: string) => {
    if (!isFileTab(path)) return
    pinPreviewsOnPath(path)
    updateDraft(path, draft)
  }, [pinPreviewsOnPath, updateDraft])

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

  // Bind the active terminal to a session (compat for the legacy setActiveSession).
  const setActiveSession = useCallback((name: string) => {
    if (ls.activeTerminalId) ls.bindTerminal(ls.activeTerminalId, name)
  }, [ls.activeTerminalId, ls.bindTerminal])

  return {
    // selection
    activeGroupId: ls.activeGroupId,
    activeEditorTab: ls.activeEditorTab,
    activeEditorTabId: ls.activeEditorTabId,
    activeEditorPath: ls.activeEditorPath,
    activeSession: ls.activeSession,
    activeEditorId: ls.activeEditorId,
    activeTerminalId: ls.activeTerminalId,
    terminalBindings: ls.terminalBindings,
    editorMru: ls.editorMru,
    terminalMru: ls.terminalMru,
    focusedPane: ls.focusedPane,
    // orthogonal
    mobilePane: ls.mobilePane,
    layout: ls.layout,
    panelLayout: ls.panelLayout,
    setPanelLayout: ls.setPanelLayout,
    files,
    dirtyTabs,
    conflictTabs,
    recentFiles: ls.recentFiles,
    fetchForTab,
    addRecentFile: ls.addRecentFile,
    setMobilePane: ls.setMobilePane,
    updateLayout: ls.updateLayout,
    // file actions
    saveFile,
    forceSave: wrappedForceSave,
    acceptDisk: wrappedAcceptDisk,
    updateFileDraft,
    updateFileViewport,
    retargetPaths,
    onDeletePath,
    setActiveSession,
    // composed open helpers (group-targeted)
    openFileInGroup,
    previewFileInGroup,
    openDiffInGroup,
    previewDiffInGroup,
    // group dispatchers + resolution
    openTab: ls.openTab,
    openPreviewTab: ls.openPreviewTab,
    openDiffTab: ls.openDiffTab,
    openBoundTerminalTab: ls.openBoundTerminalTab,
    pinTab: ls.pinTab,
    closeGroupTab: ls.closeGroupTab,
    closeGroup: ls.closeGroup,
    setActiveGroupTab: ls.setActiveGroupTab,
    setActiveGroup: ls.setActiveGroup,
    splitGroup: ls.splitGroup,
    reorderGroupTab: ls.reorderGroupTab,
    focusPane: ls.focusPane,
    bindTerminal: ls.bindTerminal,
    movePane: ls.movePane,
    resolveTarget: ls.resolveTarget,
    groupForInstance: ls.groupForInstance,
  }
}
