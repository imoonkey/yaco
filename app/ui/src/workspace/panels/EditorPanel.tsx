// EditorPanel — the editor BODY for ONE instance (design: VSCode Tab Groups /
// vt-bodies). Under the flat tab-group model an editor instance IS a single tab;
// the GROUP owns the tab strip. So this panel reads its `instanceId` from
// `usePanelInstance()`, resolves its ONE tab (a file path or `diff:` id) from the
// group tree via `editorTabByInstance`, and renders that single file/diff. It owns
// no `openTabs` list and no tab bar.
//
// Chrome: UNFRAMED. It owns breadcrumbs + editor body via `WorkspaceEditorColumn`;
// desktop file tabs/actions live in the group tab bar, and mobile tabs/actions live
// in `MobilePanelProjection`.
//
// It is a pure consumer of the workspace contexts:
//   env       — viewport (isMobile) + project (name/worktree)
//   data      — git.changes (editor gutter diff)
//   selection — the group tree (its tab payload) + shared per-path file state
//   layout    — editor prefs (previewMode/splitDirection/splitSize/autocomplete)
//   commands  — file/focus/close commands + raw layout/tab actions
//   voice     — the single screen-level voice surface (editor control + insert)
//
// Voice is NOT owned here. The workspace has one screen-level voice surface (one
// `useVoice` + one `ComposeTray`); this panel consumes its editor control slot
// (eligibility/handlers decided by the screen) and the `editorInsert` the screen
// routes to it on confirm.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { isDiffTab, isFileTab, parseDiffTab } from '../../hooks/useWorkspaceState'
import { editorTabByInstance } from '../../hooks/useLayoutState'
import { editorTabView } from '../panelLayoutModel'
import { fetchGitCompare } from '../../hooks/useApi'
import type { GitChange } from '../../types'
import type { CompareContext } from '../diff/DiffTab'
import {
  useWorkspaceEnv, useWorkspaceDataContext, useWorkspaceSelection,
  useWorkspaceEditorBuffers, useWorkspaceEditorTabs,
  useWorkspaceLayout, useWorkspaceCommands, useWorkspaceVoiceSurface,
} from '../context'
import { usePanelInstance } from '../panelInstance'
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
  const { files, jumpRequest } = useWorkspaceEditorBuffers()
  const { conflictTabs } = useWorkspaceEditorTabs()
  const { layout, panelLayout } = useWorkspaceLayout()
  const commands = useWorkspaceCommands()
  const voice = useWorkspaceVoiceSurface()
  const actions = commands.actions

  const { name: projectName, worktree } = env.project
  const { isMobile } = env.viewport
  const tree = panelLayout.desktop
  // Which editor instance this pane is. Outside a PanelHost (isolation tests) there
  // is no instance context → the active editor instance.
  const instanceId = usePanelInstance()?.instanceId ?? selection.activeEditorId
  // The single file/diff this instance shows comes from ITS tab in the group tree —
  // NOT the tab bar, NOT another instance's tab.
  const myTab = editorTabByInstance(tree, instanceId)
  const activeTab = myTab?.tabId ?? null
  // The md/html view (previewMode/splitDirection/splitSize) is PER-TAB — read it off
  // THIS instance's tab. Autocomplete stays a GLOBAL editor preference.
  const { previewMode, splitDirection, splitSize } = editorTabView(myTab)
  const { autocompleteEnabled } = layout
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
    // Open in THIS pane's group (instance-scoped), not the active editor, so
    // compare-nav from a non-active editor stays in the editor the user clicked.
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

  const handleFocusEditor = useCallback(() => commands.focusPane('editor', instanceId), [commands, instanceId])
  // The editor's own close request (Cmd+W) closes THIS instance's tab; the session/
  // file is unaffected beyond the shared-buffer GC. The strip-level close lives in
  // the group tab bar.
  const handleCloseTab = useCallback(() => commands.closePane(instanceId), [commands, instanceId])
  // Breadcrumb directory navigation awaits the result; the command is fire-and-
  // forget, so adapt it to the async prop shape.
  const handleNavigateDir = useCallback(async (dir: string) => {
    commands.expandFolderInFiles(dir)
  }, [commands])

  // Per-instance routing of go-to-line + voice insert: consume only requests
  // aimed at this pane (design: §E). Go-to-line matches by path AND the stamped
  // instanceId (every producer stamps it), so a same-path sibling tab never jumps;
  // the voice insert must ALSO target this pane and the file it currently shows.
  const myJump = jumpRequest && jumpRequest.path === activeFilePath
    && jumpRequest.instanceId === instanceId ? jumpRequest : null
  const insert = voice.editorInsert as TargetedInsert | null
  const myInsert = insert && insert.instanceId === instanceId && insert.filePath === activeTab ? insert : null

  return (
    <WorkspaceEditorColumn
      activeTab={activeTab}
      conflictTabs={conflictTabs}
      files={files}
      layout={{ previewMode, splitDirection, splitSize, autocompleteEnabled }}
      isMobile={isMobile}
      activeDiff={activeDiff}
      editorDiffHunks={editorDiffHunks}
      jumpRequest={myJump}
      editorInsert={myInsert}
      projectName={projectName}
      worktree={worktree}
      instanceId={instanceId}
      onSetView={(patch) => commands.setTabView(instanceId, patch)}
      onSaveFile={commands.saveFile}
      onForceSave={commands.forceSave}
      onAcceptDisk={commands.acceptDisk}
      onUpdateDraft={commands.updateDraft}
      onUpdateViewport={commands.updateViewport}
      onSetJumpRequest={actions.setJumpRequest}
      onNavigateToFile={commands.openFile}
      onNavigateDir={handleNavigateDir}
      onFocusEditor={handleFocusEditor}
      onCloseTab={handleCloseTab}
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
