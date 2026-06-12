// EditorPanel — the editor section as a self-contained, propless panel.
//
// Design (Panel Encapsulation / EditorPanel): wraps `WorkspaceEditorColumn`,
// owns `useWorkspaceDiff` panel-private, and derives `CompareContext` from the
// active diff tab id (fetching the compare file list on demand from the tab's
// base/compare refs, so compare state never becomes global).
//
// Chrome: UNFRAMED. The editor owns its chrome (tab bar + breadcrumbs), so it
// publishes no shared section header.
//
// It is a pure consumer of the T1b contexts:
//   env       — viewport (isMobile/isTouch) + project (name/worktree)
//   data      — git.changes (editor gutter diff), sessions.liveSessionHandles
//   selection — openTabs/activeTab/previewTab/activeSession + editor file state
//   layout    — editor prefs (previewMode/splitDirection/splitSize/autocomplete)
//   commands  — tab/file/session commands + raw layout/tab actions
//   voice     — the single screen-level voice surface (editor control + insert)
//
// Voice is NOT owned here. The workspace has one screen-level voice surface (one
// `useVoice` + one `ComposeTray`); this panel consumes its editor control slot
// (eligibility/handlers decided by the screen) and the `editorInsert` the screen
// routes to it on confirm. Outside the screen (isolation tests) the inert default
// surface renders no voice button and never inserts.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { isDiffTab, isFileTab, parseDiffTab } from '../../hooks/useWorkspaceState'
import { EMPTY_VIEW } from '../../hooks/workspaceTypes'
import { fetchGitCompare } from '../../hooks/useApi'
import type { GitChange } from '../../types'
import type { CompareContext } from '../diff/DiffTab'
import {
  useWorkspaceEnv, useWorkspaceDataContext, useWorkspaceSelection,
  useWorkspaceLayout, useWorkspaceCommands, useWorkspaceVoiceSurface,
  type SplitSide,
} from '../context'
import { usePanelInstance } from '../panelInstance'
import { HOME_EDITOR_ID, MAIN_TABS_ID } from '../panelLayoutModel'
import { useWorkspaceDiff } from '../useWorkspaceDiff'
import { WorkspaceEditorColumn } from '../WorkspaceEditorColumn'
import { PANEL_META } from '../panelMeta'
import type { PanelDefinition } from '../panelRegistry'

// editorInsert carries instanceId + filePath (design: §G); we read them
// structurally so this panel consumes only inserts aimed at this pane AND at the
// file it is currently showing (a take stamped before a tab switch never lands).
type TargetedInsert = { text: string; key: number; instanceId?: string; filePath?: string }

export function EditorPanel() {
  const env = useWorkspaceEnv()
  const data = useWorkspaceDataContext()
  const selection = useWorkspaceSelection()
  const { layout } = useWorkspaceLayout()
  const commands = useWorkspaceCommands()
  const voice = useWorkspaceVoiceSurface()
  const actions = commands.actions

  const { name: projectName, worktree } = env.project
  const { isMobile, isTouch } = env.viewport
  // Which editor instance this pane is. Outside a PanelHost (isolation tests)
  // there is no instance context → the home editor ('editor').
  const instanceId = usePanelInstance()?.instanceId ?? HOME_EDITOR_ID
  const isSecondary = instanceId !== HOME_EDITOR_ID
  // View is per-instance (design: §E); a missing id resolves to the empty view.
  const view = selection.editorViews[instanceId] ?? EMPTY_VIEW
  const { openTabs, activeTab, previewTab } = view
  const { files, dirtyTabs, conflictTabs, jumpRequest } = selection.editor
  const { previewMode, splitDirection, splitSize, autocompleteEnabled } = layout
  // Derived tab state (mirrors the inline editor body).
  const activeFilePath = isFileTab(activeTab) ? activeTab : null
  const activeFileState = activeFilePath ? files[activeFilePath] : null
  const activeFileContent = activeFileState?.draft ?? activeFileState?.serverContent ?? null
  const activeDiffTab = isDiffTab(activeTab)
  const parsedDiff = activeDiffTab && activeTab ? parseDiffTab(activeTab) : null
  const activeDiffPath = parsedDiff?.path ?? null

  // Panel-private diff cache: the active diff tab + the editor gutter for the
  // current open buffer. Compare refs (when present) key the diff-tab fetch.
  const { activeDiff, editorDiffHunks } = useWorkspaceDiff({
    activeDiffPath, activeFilePath, projectName, worktree,
    activeFileContent, gitData: data.git,
    compareBase: parsedDiff?.base, compareHead: parsedDiff?.compare,
  })

  // Compare context, derived from the active diff tab id alone. A self-describing
  // `diff:path?base=&compare=` tab is the only signal; the file list is fetched on
  // demand from those refs so compare state stays panel-local.
  const isCompareDiff = !!(parsedDiff?.base && parsedDiff?.compare)
  const compareBase = parsedDiff?.base
  const compareHead = parsedDiff?.compare
  const [compareList, setCompareList] = useState<{ key: string; files: GitChange[] } | null>(null)

  useEffect(() => {
    if (!isCompareDiff || !compareBase || !compareHead || !projectName) return
    const key = `${compareBase}:${compareHead}`
    const controller = new AbortController()
    fetchGitCompare(projectName, compareBase, compareHead, worktree)
      .then(result => { if (!controller.signal.aborted) setCompareList({ key, files: result.files }) })
      .catch(() => { if (!controller.signal.aborted) setCompareList({ key, files: [] }) })
    return () => controller.abort()
  }, [isCompareDiff, compareBase, compareHead, projectName, worktree])

  const compareFiles = useMemo(() => {
    if (!compareBase || !compareHead) return []
    return compareList?.key === `${compareBase}:${compareHead}` ? compareList.files : []
  }, [compareList, compareBase, compareHead])

  const navigateCompareFile = useCallback((path: string) => {
    if (!compareBase || !compareHead) return
    const tabId = `diff:${path}?base=${encodeURIComponent(compareBase)}&compare=${encodeURIComponent(compareHead)}`
    // Open in THIS pane (instance-scoped), not the active editor, so compare-nav
    // from a non-active editor stays in the editor the user clicked (design: §E).
    actions.openPreviewDiffTabByIdIn(instanceId, tabId)
    commands.focusPane('editor', instanceId)
  }, [compareBase, compareHead, actions, commands, instanceId])

  const compareContext = useMemo<CompareContext | undefined>(() => {
    if (!isCompareDiff || !compareBase || !compareHead || !parsedDiff) return undefined
    return {
      base: compareBase,
      compare: compareHead,
      files: compareFiles,
      currentPath: parsedDiff.path,
      onNavigate: navigateCompareFile,
    }
  }, [isCompareDiff, compareBase, compareHead, parsedDiff, compareFiles, navigateCompareFile])

  // Tab interactions are instance-scoped: select/close act on THIS pane's view and
  // also focus it; mousedown focuses it. Double-click promotes preview→pinned IN
  // THIS pane (instance-scoped open), not the active editor.
  const handleDoubleClickTab = useCallback((tab: string) => {
    if (tab !== previewTab) return
    if (isFileTab(tab)) actions.openFileTabIn(instanceId, tab)
    if (isDiffTab(tab)) actions.openDiffTabIn(instanceId, tab.slice(5))
  }, [previewTab, actions, instanceId])

  const handleSelectTab = useCallback((tab: string) => commands.selectTab(tab, instanceId), [commands, instanceId])
  const handleCloseTab = useCallback((tab: string) => commands.closeTab(tab, instanceId), [commands, instanceId])
  const handleFocusEditor = useCallback(() => commands.focusPane('editor', instanceId), [commands, instanceId])
  // Breadcrumb directory navigation awaits the result; the command is fire-and-
  // forget, so adapt it to the async prop shape.
  const handleNavigateDir = useCallback(async (dir: string) => {
    commands.expandFolderInFiles(dir)
  }, [commands])

  // Per-instance routing of go-to-line + voice insert: consume only requests
  // aimed at this pane (design: §E). The home editor's id is HOME_EDITOR_ID. The
  // insert must ALSO target the file this pane currently shows, so a take stamped
  // before a tab switch never lands in the wrong file.
  const myJump = jumpRequest && jumpRequest.instanceId === instanceId ? jumpRequest : null
  const insert = voice.editorInsert as TargetedInsert | null
  const myInsert = insert && insert.instanceId === instanceId && insert.filePath === activeTab ? insert : null

  // Paths open in OTHER editor views — closing a dirty tab here is loss-free when
  // the file is still shown elsewhere (shared buffer), so the tab bar skips its
  // discard confirm in that case (design: §B explicit-discard). On the LAST view,
  // the confirmed discard runs `acceptDisk` (the surface's revert-to-disk action:
  // draft → null, status → clean), so the post-close GC drops the now-unreferenced
  // buffer instead of keeping it dirty and resurrecting the edit on reopen.
  const pathsOpenElsewhere = useMemo(() => {
    const set = new Set<string>()
    for (const [id, v] of Object.entries(selection.editorViews)) {
      if (id === instanceId) continue
      for (const tab of v.openTabs) set.add(tab)
    }
    return set
  }, [selection.editorViews, instanceId])

  // Split/Move/Close chrome (design: §E). The home editor only splits; secondary
  // editors also move (beside the structural home region) and close.
  const editorSplit = useMemo(() => ({
    isSecondary,
    onSplit: (side: SplitSide) => commands.splitEditor(instanceId, side),
    onMove: (side: SplitSide) => commands.movePane(instanceId, { targetId: MAIN_TABS_ID, side }),
    onClose: () => commands.closePane(instanceId),
  }), [isSecondary, instanceId, commands])

  return (
    <WorkspaceEditorColumn
      openTabs={openTabs}
      activeTab={activeTab}
      previewTab={previewTab}
      dirtyTabs={dirtyTabs}
      conflictTabs={conflictTabs}
      files={files}
      layout={{ previewMode, splitDirection, splitSize, autocompleteEnabled }}
      isTouch={isTouch}
      isMobile={isMobile}
      activeDiff={activeDiff}
      editorDiffHunks={editorDiffHunks}
      jumpRequest={myJump}
      editorInsert={myInsert}
      projectName={projectName}
      worktree={worktree}
      voice={voice.editor}
      instanceId={instanceId}
      editorSplit={editorSplit}
      pathsOpenElsewhere={pathsOpenElsewhere}
      onDiscardDirty={commands.acceptDisk}
      onSelectTab={handleSelectTab}
      onDoubleClickTab={handleDoubleClickTab}
      onCloseTab={handleCloseTab}
      onLayoutUpdate={actions.updateLayout}
      onSaveFile={commands.saveFile}
      onForceSave={commands.forceSave}
      onAcceptDisk={commands.acceptDisk}
      onUpdateDraft={commands.updateDraft}
      onUpdateViewport={commands.updateViewport}
      onSetJumpRequest={actions.setJumpRequest}
      onNavigateToFile={commands.openFile}
      onNavigateDir={handleNavigateDir}
      onFocusEditor={handleFocusEditor}
      compareContext={compareContext}
    />
  )
}

// The panel's registry entry. Co-located with the component it registers; the
// integrator (fl-panel-integrate) assembles these defs into the registry.
// eslint-disable-next-line react-refresh/only-export-components
export const editorPanelDef: PanelDefinition = {
  ...PANEL_META.editor,
  Component: EditorPanel,
}
