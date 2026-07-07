import { useCallback, useRef, useEffect, useMemo } from 'react'
import {
  type PersistedDraftsByWorktree, type PersistedDraftEntry, type FileState, type LayoutNode,
  isFileTab, parseDiffTab,
} from './workspaceTypes'
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

/** Serialize one worktree's live file state into its persisted drafts bucket: keep a
 *  path iff it carries an unsaved draft or a non-default viewport (the same filter the
 *  old single-bucket snapshot used). */
function serializeBucket(files: Record<string, FileState>): Record<string, PersistedDraftEntry> {
  const out: Record<string, PersistedDraftEntry> = {}
  for (const [path, state] of Object.entries(files)) {
    if (!isFileTab(path)) continue
    if (state.draft != null || state.viewportLine > 1) {
      out[path] = {
        draft: state.draft,
        baseRevision: state.baseRevision,
        viewportLine: state.viewportLine,
        updatedAt: state.editedAt || Date.now(),
      }
    }
  }
  return out
}

export function useWorkspaceState(projectName: string, projectPath: string, worktree?: string | null) {
  // Phase 1: load persisted state
  const { initialLayout, initialDraftsByWorktree, bindSnapshots, scheduleLayoutSave, scheduleDraftsSave } = usePersistence(projectName, projectPath)

  // Union of file-tab paths across the restored group tree — what useFileState
  // hydrates on mount and refetches on SSE. Computed once from the migrated tree.
  const initialOpenTabs = useMemo(() => editorTabPaths(initialLayout.panelLayout.desktop), [initialLayout.panelLayout.desktop])

  // Shared ref: tracks the current open-file-tab union for SSE refetch in useFileState
  const openTabsRef = useRef(initialOpenTabs)

  // Phase 2: create domain hooks
  const {
    files, filesRef, filesByWorktree, filesByWorktreeRef, dirtyTabs, conflictTabs,
    gcBuffers,
    fetchForTab, retargetFile, removeFilesUnder,
    updateDraft, updateViewport,
    save, forceSave, acceptDisk,
  } = useFileState(projectName, projectPath, worktree, initialDraftsByWorktree, initialOpenTabs, openTabsRef)

  // The dirty set, mirrored into a ref so the reducer's preview-drop decision
  // (keep a dirty old preview pinned) reads it without re-creating callbacks.
  const dirtyPathsRef = useRef<ReadonlySet<string>>(dirtyTabs)
  useEffect(() => { dirtyPathsRef.current = dirtyTabs })

  const ls = useLayoutState(initialLayout, dirtyPathsRef)
  const {
    openTab,
    openPreviewTab,
    openDiffTab,
    openRoutedTab,
    openRoutedDiffTab,
    openRoutedPreviewTab,
    openRoutedBoundTerminalTab,
    resolveEditorTarget,
    newCenterGroup,
    panelLayout,
    pinTab,
    retargetPaths: retargetLayoutPaths,
    closeTabsUnder,
    activeTerminalId,
    bindTerminal,
    addRecentFile,
  } = ls

  // Latest layout snapshot for SSE refetch + persistence getters (group shape).
  const layoutValue = {
    terminalBindings: ls.terminalBindings,
    editorMru: ls.editorMru, terminalMru: ls.terminalMru, activeGroupId: ls.activeGroupId,
    mobilePane: ls.mobilePane, layout: ls.layout, panelLayout: ls.panelLayout, recentFiles: ls.recentFiles,
  }
  const layoutRef = useRef(layoutValue)

  // The drafts flush snapshot (design §P3 all-bucket flush). Serialize EVERY live
  // worktree bucket from useFileState's whole store — not just the active projection —
  // so a dirty draft in a background worktree is flushed, and a background save that
  // cleared a draft after a switch is reflected (never written back stale). useFileState
  // keys buckets by worktree abspath (primary = projectPath), matching the persisted
  // record, so no remap is needed.
  //
  // No-remount fidelity (this IS the decouple task that dropped App.tsx's remount key):
  // useFileState now seeds ALL persisted buckets up front, so every worktree's drafts
  // are live from mount. A switched-to worktree therefore can never serialize a
  // partially-hydrated `{}` and prune an unopened-path base draft (#3b) — the bucket
  // already carries its restored drafts. A present-but-empty bucket is still kept as
  // `{}` so a fully-cleared bucket prunes (vs. a bucket the user never cleared).
  const snapshotDrafts = useCallback((): PersistedDraftsByWorktree => {
    const out: PersistedDraftsByWorktree = {}
    for (const [key, bucket] of Object.entries(filesByWorktreeRef.current)) {
      out[key] = serializeBucket(bucket)
    }
    return out
  }, [filesByWorktreeRef])

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
      draftsRef: snapshotDrafts,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Schedule persistence on state changes
  useEffect(() => {
    scheduleLayoutSave()
  }, [ls.terminalBindings, ls.editorMru, ls.terminalMru, ls.activeGroupId, ls.mobilePane, ls.layout, ls.panelLayout, ls.recentFiles, scheduleLayoutSave])

  // Schedule a drafts save on EVERY all-bucket mutation — keyed on the whole
  // `filesByWorktree` store, not just the active projection. A save/accept that lands
  // in a now-BACKGROUND worktree after a switch changes a background bucket but leaves
  // the active `files` reference intact; keying on `files` would skip the debounce and
  // leave localStorage stale until an unrelated active edit or unmount (a crash would
  // then resurrect a draft the user saved or accepted away — the durable side of #3a).
  useEffect(() => {
    scheduleDraftsSave()
  }, [filesByWorktree, scheduleDraftsSave])

  // Phase 4: composed file-open helpers (group-targeted). A file open also loads
  // its shared-by-path buffer; a diff open does not (diff bodies fetch their own).
  const openFileInGroup = useCallback((groupId: string, path: string): string | null => {
    if (!isFileTab(path)) return null
    const instanceId = openTab(groupId, path)
    addRecentFile(path)
    if (!isBinaryPreviewFile(path)) fetchForTab(path)
    return instanceId
  }, [openTab, addRecentFile, fetchForTab])

  const openDiffInGroup = useCallback((groupId: string, tabId: string) => {
    openDiffTab(groupId, tabId)
  }, [openDiffTab])

  const previewDiffInGroup = useCallback((groupId: string, tabId: string) => {
    openPreviewTab(groupId, tabId)
  }, [openPreviewTab])

  // --- Routed open helpers (kind-aware; design: separateKinds) ---
  // Each dispatches a reducer-owned OPEN_ROUTED_* (the reducer resolves the target
  // group + creates one if needed, atomically) and rides the PATH-keyed effects the
  // reducer must not own: an editor open fetches unconditionally (as openFileInGroup
  // does); an editor preview gates the fetch on a PURE content-presence pre-check
  // (no synchronous reducer return); diff opens fetch nothing (the viewer hydrates).
  const openFileRouted = useCallback((path: string) => {
    if (!isFileTab(path)) return
    openRoutedTab(path)
    addRecentFile(path)
    if (!isBinaryPreviewFile(path)) fetchForTab(path)
  }, [openRoutedTab, addRecentFile, fetchForTab])

  const previewFileRouted = useCallback((path: string) => {
    if (!isFileTab(path)) return
    const loaded = filesRef.current[path]?.serverContent != null
    openRoutedPreviewTab(path)
    addRecentFile(path)
    if (!loaded && !isBinaryPreviewFile(path)) fetchForTab(path)
  }, [openRoutedPreviewTab, addRecentFile, fetchForTab, filesRef])

  const openDiffRouted = useCallback((tabId: string) => {
    openRoutedDiffTab(tabId)
  }, [openRoutedDiffTab])

  const previewDiffRouted = useCallback((tabId: string) => {
    openRoutedPreviewTab(tabId)
  }, [openRoutedPreviewTab])

  const openBoundTerminalRouted = useCallback((session: string, preview = false) => {
    openRoutedBoundTerminalTab(session, preview)
  }, [openRoutedBoundTerminalTab])

  // Go-to-line stays command-resolved: the PURE resolver picks the editor home (a new
  // center group when none), we open there and RETURN the opened instanceId so the
  // caller stamps the jump on exactly that tab — synchronous, no reducer round-trip,
  // no id race (design: Synchronous results & follow-ups).
  const openFileAtLineRouted = useCallback((path: string): string | null => {
    if (!isFileTab(path)) return null
    const target = resolveEditorTarget()
    const groupId = 'groupId' in target ? target.groupId : newCenterGroup()
    return openFileInGroup(groupId, path)
  }, [resolveEditorTarget, newCenterGroup, openFileInGroup])

  // A draft promotes a preview tab to pinned: pin every preview editor tab on this
  // path (the shared-buffer edit could surface in more than one pane).
  const pinPreviewsOnPath = useCallback((path: string) => {
    const tree: LayoutNode = panelLayout.desktop
    for (const id of editorInstancesInOrder(tree)) {
      const tab = editorTabByInstance(tree, id)
      if (tab && tab.kind === 'editor' && tab.preview && tabFilePath(tab.tabId) === path) {
        const g = groupOf(tree, id)
        if (g) pinTab(g, id)
      }
    }
  }, [panelLayout.desktop, pinTab])

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
    retargetLayoutPaths(oldPath, newPath)
    retargetFile(oldPath, newPath)
  }, [retargetLayoutPaths, retargetFile])

  /** Close tabs and remove file state when a file/dir is deleted */
  const onDeletePath = useCallback((path: string) => {
    closeTabsUnder(path)
    removeFilesUnder(path)
  }, [closeTabsUnder, removeFilesUnder])

  // Bind the active terminal to a session (compat for the legacy setActiveSession).
  const setActiveSession = useCallback((name: string) => {
    if (activeTerminalId) bindTerminal(activeTerminalId, name)
  }, [activeTerminalId, bindTerminal])

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
    filesRef,
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
    openDiffInGroup,
    previewDiffInGroup,
    // routed open helpers (kind-aware; design: separateKinds)
    openFileRouted,
    previewFileRouted,
    openDiffRouted,
    previewDiffRouted,
    openBoundTerminalRouted,
    openFileAtLineRouted,
    toggleSeparateKinds: ls.toggleSeparateKinds,
    // group dispatchers + resolution
    openTab: ls.openTab,
    openTasksTab: ls.openTasksTab,
    openPreviewTab: ls.openPreviewTab,
    openDiffTab: ls.openDiffTab,
    openBoundTerminalTab: ls.openBoundTerminalTab,
    pinTab: ls.pinTab,
    setTabView: ls.setTabView,
    closeGroupTab: ls.closeGroupTab,
    closeGroup: ls.closeGroup,
    setActiveGroupTab: ls.setActiveGroupTab,
    setActiveGroup: ls.setActiveGroup,
    splitGroup: ls.splitGroup,
    reorderGroupTab: ls.reorderGroupTab,
    moveTab: ls.moveTab,
    moveTabToSplit: ls.moveTabToSplit,
    moveGroup: ls.moveGroup,
    focusPane: ls.focusPane,
    bindTerminal: ls.bindTerminal,
    movePane: ls.movePane,
    moveLeafToEdge: ls.moveLeafToEdge,
    resolveTarget: ls.resolveTarget,
    groupForInstance: ls.groupForInstance,
  }
}
