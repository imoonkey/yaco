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
//
// Voice + insertion are NOT owned here. The workspace has a single screen-level
// voice surface (one `useVoice` + one `ComposeTray`) shared by the editor and
// terminal; a panel-private machine would be dead (it could never confirm into a
// tray it does not render). So this panel renders without its voice button until
// fl-panel-integrate exposes the screen-level voice + `editorInsert` to panels.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { isDiffTab, isFileTab, parseDiffTab } from '../../hooks/useWorkspaceState'
import { TASKS_FILE_PATH } from '../../hooks/useTaskGraph'
import { fetchGitCompare } from '../../hooks/useApi'
import type { CapabilityState, InteractionState } from '../../hooks/useVoice'
import type { GitChange } from '../../types'
import type { CompareContext } from '../diff/DiffTab'
import {
  useWorkspaceEnv, useWorkspaceDataContext, useWorkspaceSelection,
  useWorkspaceLayout, useWorkspaceCommands,
} from '../context'
import { useWorkspaceDiff } from '../useWorkspaceDiff'
import { WorkspaceEditorColumn } from '../WorkspaceEditorColumn'
import type { PanelDefinition } from '../panelRegistry'

// Inert voice: `eligible: false` keeps the column from rendering its voice button
// (the capability/state fields are only read when eligible). fl-panel-integrate
// replaces this with the screen-level voice surface.
// TODO(fl-panel-integrate): consume the single screen-level voice surface here.
const INERT_EDITOR_VOICE: {
  eligible: boolean
  capability: CapabilityState
  state: InteractionState
  elapsedMs: number
  onStart: () => void
  onStop: () => void
} = {
  eligible: false,
  capability: { status: 'checking' },
  state: 'idle',
  elapsedMs: 0,
  onStart: () => {},
  onStop: () => {},
}

export function EditorPanel() {
  const env = useWorkspaceEnv()
  const data = useWorkspaceDataContext()
  const selection = useWorkspaceSelection()
  const { layout } = useWorkspaceLayout()
  const commands = useWorkspaceCommands()
  const actions = commands.actions

  const { name: projectName, worktree } = env.project
  const { isMobile, isTouch } = env.viewport
  const { openTabs, activeTab, previewTab, activeSession } = selection
  const { files, dirtyTabs, conflictTabs, jumpRequest } = selection.editor
  const { previewMode, splitDirection, splitSize, autocompleteEnabled } = layout
  const changes = data.git.changes
  const liveSessionHandles = data.sessions.liveSessionHandles

  // Derived tab state (mirrors the inline editor body).
  const activeFilePath = isFileTab(activeTab) ? activeTab : null
  const activeDiffTab = isDiffTab(activeTab)
  const parsedDiff = activeDiffTab && activeTab ? parseDiffTab(activeTab) : null
  const activeDiffPath = parsedDiff?.path ?? null

  // Panel-private diff cache: the active diff tab + the editor gutter for a
  // changed open file. Compare refs (when present) key the fetch.
  const { activeDiff, editorDiffHunks } = useWorkspaceDiff({
    activeDiffPath, activeFilePath, projectName, worktree,
    changes, gitData: data.git,
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
    actions.openPreviewDiffTabById(tabId)
    commands.setFocusTarget('editor')
  }, [compareBase, compareHead, actions, commands])

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

  // Tab interactions not covered by a named command: promote-preview-to-pinned
  // (double click) and the close-tab event wrapper.
  const handleDoubleClickTab = useCallback((tab: string) => {
    if (tab !== previewTab) return
    if (isFileTab(tab)) actions.openFileTab(tab)
    if (isDiffTab(tab)) actions.openDiffTab(tab.slice(5))
  }, [previewTab, actions])

  const handleCloseTab = useCallback((tab: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    commands.closeTab(tab)
  }, [commands])

  const handleFocusEditor = useCallback(() => commands.setFocusTarget('editor'), [commands])
  const handleOpenTasksFile = useCallback(() => commands.openFile(TASKS_FILE_PATH), [commands])
  // Breadcrumb directory navigation awaits the result; the command is fire-and-
  // forget, so adapt it to the async prop shape.
  const handleNavigateDir = useCallback(async (dir: string) => {
    commands.expandFolderInFiles(dir)
  }, [commands])

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
      jumpRequest={jumpRequest}
      // TODO(fl-panel-integrate): consume editorInsert from the single
      // screen-level voice surface (not exposed by the T1b contexts yet).
      editorInsert={null}
      projectName={projectName}
      worktree={worktree}
      voice={INERT_EDITOR_VOICE}
      onSelectTab={commands.selectTab}
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
      onOpenTasksFile={handleOpenTasksFile}
      compareContext={compareContext}
      activeSession={activeSession}
      liveSessionHandles={liveSessionHandles}
      onOpenTerminal={commands.openTerminalForSession}
    />
  )
}

// The panel's registry entry. Co-located with the component it registers; the
// integrator (fl-panel-integrate) assembles these defs into the registry.
// eslint-disable-next-line react-refresh/only-export-components
export const editorPanelDef: PanelDefinition = {
  id: 'editor',
  title: 'Editor',
  chrome: 'unframed',
  mobileDock: 'editor',
  mobileOrder: 0,
  minSize: { width: 320, height: 200 },
  Component: EditorPanel,
}
