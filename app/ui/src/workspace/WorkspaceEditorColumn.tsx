// WorkspaceEditorColumn — the editor BODY (design: VSCode Tab Groups / vt-bodies).
//
// Under the flat tab-group model an editor instance IS a single tab; the GROUP
// owns the tab strip (file/diff names, dirty dots, close ×, split). So this body
// renders only: breadcrumbs and the editor area for the ONE active file/diff. It
// holds no `openTabs` list and no per-editor tab bar; desktop group actions live in
// `GroupTabBar`, while mobile actions live in `MobilePanelProjection`'s tab row.
import { useCallback } from 'react'
import { isDiffTab, isFileTab, type FileState, type PreviewMode, type SplitDirection, type EditorTabView } from '../hooks/workspaceTypes'
import { WorkspaceBreadcrumbs } from './WorkspaceBreadcrumbs'
import { WorkspaceEditorArea } from './WorkspaceEditorArea'
import { clampLine } from './markdown'
import { isDelimitedFile, isHtmlFile, isMarkdownFile } from '../lib/binaryFiles'
import type { DiffState } from './useWorkspaceDiff'
import type { DiffHunk } from '../lib/parseDiff'
import type { CompareContext } from './diff/DiffTab'

type JumpRequest = { key: number; path: string; line: number; scroll?: boolean; instanceId?: string }

export interface WorkspaceEditorColumnProps {
  // The single file/diff this editor instance shows (its tab's tabId), or null.
  activeTab: string | null
  conflictTabs: Set<string>
  files: Record<string, FileState>
  layout: { previewMode: PreviewMode; splitDirection: SplitDirection; splitSize: number; autocompleteEnabled: boolean }
  isMobile: boolean
  activeDiff: DiffState | null
  editorDiffHunks: DiffHunk[]
  jumpRequest: JumpRequest | null
  editorInsert: { text: string; key: number } | null
  projectName: string
  worktree?: string | null
  compareContext?: CompareContext
  // Per-instance identity (design: §B). Stamps the in-editor self-jump so only this
  // pane consumes it.
  instanceId: string
  onSetView: (patch: Partial<EditorTabView>) => void
  onSaveFile: (path: string, content: string) => Promise<{ conflict: boolean }>
  onForceSave: (path: string, content: string) => Promise<void>
  onAcceptDisk: (path: string) => void
  onUpdateDraft: (path: string, content: string) => void
  onUpdateViewport: (path: string, line: number) => void
  onSetJumpRequest: (req: JumpRequest) => void
  onNavigateToFile: (path: string) => void
  onNavigateDir: (dir: string) => Promise<void>
  onFocusEditor: () => void
  // Closes THIS instance's tab (the editor's Cmd+W / close request); the group tab
  // bar owns the strip-level close.
  onCloseTab: () => void
}

export function WorkspaceEditorColumn(props: WorkspaceEditorColumnProps) {
  const {
    activeTab, conflictTabs,
    files, layout, isMobile,
    activeDiff, editorDiffHunks, jumpRequest, editorInsert,
    projectName, worktree, compareContext,
    instanceId, onSetView,
    onSaveFile, onForceSave, onAcceptDisk, onUpdateDraft, onUpdateViewport,
    onSetJumpRequest, onNavigateToFile, onNavigateDir, onFocusEditor, onCloseTab,
  } = props

  const { previewMode, splitDirection, splitSize, autocompleteEnabled } = layout

  // Derive from activeTab (the tab's tabId).
  const activeFilePath = isFileTab(activeTab) ? activeTab : null
  const activeDiffTab = isDiffTab(activeTab)
  const isMd = !!activeFilePath && isMarkdownFile(activeFilePath)
  const isHtml = !!activeFilePath && isHtmlFile(activeFilePath)
  const isDelimited = !!activeFilePath && isDelimitedFile(activeFilePath)
  const activeFileState = activeFilePath ? files[activeFilePath] : null
  const activeFileContent = activeFileState?.draft ?? activeFileState?.serverContent ?? null
  const activeFileError = activeFileState?.loadError ?? null
  const activeFileLoading = activeFilePath != null && activeFileContent === null && activeFileState?.status !== 'missing' && activeFileError == null
  const activeViewportLine = activeFileState?.viewportLine ?? 1
  const hasConflict = !!activeFilePath && conflictTabs.has(activeFilePath)
  const handleViewportLine = useCallback((line: number) => {
    if (activeFilePath) onUpdateViewport(activeFilePath, Math.max(1, line))
  }, [activeFilePath, onUpdateViewport])

  const handleActivateLine = useCallback((line: number) => {
    if (!activeFilePath) return
    // Stamp this pane's instanceId so the go-to-line is consumed only here
    // (design: §B — the last bare jumpRequest producer).
    onSetJumpRequest({ key: Date.now(), path: activeFilePath, line: clampLine(line), scroll: false, instanceId })
    if (previewMode !== 'split') onSetView({ previewMode: 'edit' })
    onFocusEditor()
  }, [activeFilePath, previewMode, instanceId, onSetJumpRequest, onSetView, onFocusEditor])

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ backgroundColor: 'var(--sol-editor-bg)' }} onMouseDown={onFocusEditor}>
      <WorkspaceBreadcrumbs activeTab={activeTab} onNavigateDir={onNavigateDir} />

      <WorkspaceEditorArea
        activeTab={activeTab}
        activeFilePath={activeFilePath}
        activeFileContent={activeFileContent}
        activeFileLoading={activeFileLoading}
        activeFileError={activeFileError}
        activeViewportLine={activeViewportLine}
        isDiffTab={activeDiffTab}
        activeDiff={activeDiff}
        isMd={isMd}
        isHtml={isHtml}
        isDelimited={isDelimited}
        previewMode={previewMode}
        splitDirection={splitDirection}
        splitSize={splitSize}
        onSplitResize={(size) => onSetView({ splitSize: size })}
        hasConflict={hasConflict}
        jumpRequest={jumpRequest}
        onAcceptDisk={() => activeFilePath && onAcceptDisk(activeFilePath)}
        onForceSave={() => activeFilePath && void onForceSave(activeFilePath, activeFileContent ?? '')}
        onViewportLine={handleViewportLine}
        onActivateLine={handleActivateLine}
        onNavigateToFile={onNavigateToFile}
        onNavigateDir={onNavigateDir}
        onFocus={onFocusEditor}
        onCloseTab={onCloseTab}
        onDraftChange={(content) => activeFilePath && onUpdateDraft(activeFilePath, content)}
        onSave={async (content) => { if (activeFilePath) await onSaveFile(activeFilePath, content) }}
        diffHunks={editorDiffHunks}
        insertText={editorInsert?.text}
        insertRequestKey={editorInsert?.key}
        autocompleteEnabled={autocompleteEnabled}
        isMobile={isMobile}
        compareContext={compareContext}
        projectName={projectName}
        worktree={worktree}
      />
    </div>
  )
}
