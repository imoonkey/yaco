// WorkspaceEditorColumn — the editor BODY (design: VSCode Tab Groups / vt-bodies).
//
// Under the flat tab-group model an editor instance IS a single tab; the GROUP
// owns the tab strip (file/diff names, dirty dots, close ×, split). So this body
// renders only: a slim action bar (preview-mode + suggestions, plus the mobile-only
// mic), breadcrumbs, and the editor area for the ONE active file/diff. It holds no
// `openTabs` list and no per-editor tab bar.
import { useCallback } from 'react'
import { isDiffTab, isFileTab, type FileState, type PreviewMode, type SplitDirection } from '../hooks/workspaceTypes'
import type { WorkspaceLayout } from '../hooks/workspaceTypes'
import type { CapabilityState, InteractionState } from '../hooks/useVoice'
import { WorkspaceBreadcrumbs } from './WorkspaceBreadcrumbs'
import { WorkspaceEditorArea } from './WorkspaceEditorArea'
import { EditorActions } from './EditorActions'
import { VoiceControl } from '../components/VoiceControl'
import { clampLine } from './markdown'
import { isBinaryPreviewFile, isHtmlFile, isMarkdownFile, isPreviewableFile } from '../lib/binaryFiles'
import type { DiffState } from './useWorkspaceDiff'
import type { DiffHunk } from '../lib/parseDiff'
import type { CompareContext } from './diff/DiffTab'

type JumpRequest = { key: number; path: string; line: number; scroll?: boolean; instanceId?: string }

interface EditorColumnVoice {
  eligible: boolean
  capability: CapabilityState
  state: InteractionState
  onRecord: () => void
  onStop: () => void
}

export interface WorkspaceEditorColumnProps {
  // The single file/diff this editor instance shows (its tab's tabId), or null.
  activeTab: string | null
  conflictTabs: Set<string>
  files: Record<string, FileState>
  layout: { previewMode: PreviewMode; splitDirection: SplitDirection; splitSize: number; autocompleteEnabled: boolean }
  isTouch: boolean
  isMobile: boolean
  activeDiff: DiffState | null
  editorDiffHunks: DiffHunk[]
  jumpRequest: JumpRequest | null
  editorInsert: { text: string; key: number } | null
  projectName: string
  worktree?: string | null
  voice: EditorColumnVoice
  compareContext?: CompareContext
  // Per-instance identity (design: §B). Stamps the in-editor self-jump so only this
  // pane consumes it.
  instanceId: string
  onLayoutUpdate: (patch: Partial<WorkspaceLayout>) => void
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
    files, layout, isTouch, isMobile,
    activeDiff, editorDiffHunks, jumpRequest, editorInsert,
    projectName, worktree, voice, compareContext,
    instanceId, onLayoutUpdate,
    onSaveFile, onForceSave, onAcceptDisk, onUpdateDraft, onUpdateViewport,
    onSetJumpRequest, onNavigateToFile, onNavigateDir, onFocusEditor, onCloseTab,
  } = props

  const { previewMode, splitDirection, splitSize, autocompleteEnabled } = layout

  // Derive from activeTab (the tab's tabId).
  const activeFilePath = isFileTab(activeTab) ? activeTab : null
  const activeDiffTab = isDiffTab(activeTab)
  const isMd = !!activeFilePath && isMarkdownFile(activeFilePath)
  const isHtml = !!activeFilePath && isHtmlFile(activeFilePath)
  const canTogglePreview = !!activeFilePath && isPreviewableFile(activeFilePath) && !isBinaryPreviewFile(activeFilePath)
  const activeFileState = activeFilePath ? files[activeFilePath] : null
  const activeFileContent = activeFileState?.draft ?? activeFileState?.serverContent ?? null
  const activeFileLoading = activeFilePath != null && activeFileContent === null && activeFileState?.status !== 'missing'
  const activeViewportLine = activeFileState?.viewportLine ?? 1
  const hasConflict = !!activeFilePath && conflictTabs.has(activeFilePath)
  const showSuggestionsToggle = !activeDiffTab
  // Per-pane mic is MOBILE-only: on desktop the GlobalVoiceControl in the app top
  // bar is the single voice surface (design: §G). The editor view controls (the
  // suggestions sparkle + preview-mode toggle) live in the GROUP TAB BAR on desktop;
  // mobile has no tab bar, so this body keeps a slim action row (mic + EditorActions).
  const showMic = isMobile && voice.eligible
  const showActionBar = isMobile && (canTogglePreview || showSuggestionsToggle || showMic)

  const handleViewportLine = useCallback((line: number) => {
    if (activeFilePath) onUpdateViewport(activeFilePath, Math.max(1, line))
  }, [activeFilePath, onUpdateViewport])

  const handleActivateLine = useCallback((line: number) => {
    if (!activeFilePath) return
    // Stamp this pane's instanceId so the go-to-line is consumed only here
    // (design: §B — the last bare jumpRequest producer).
    onSetJumpRequest({ key: Date.now(), path: activeFilePath, line: clampLine(line), scroll: false, instanceId })
    if (previewMode !== 'split') onLayoutUpdate({ previewMode: 'edit' })
    onFocusEditor()
  }, [activeFilePath, previewMode, instanceId, onSetJumpRequest, onLayoutUpdate, onFocusEditor])

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ backgroundColor: 'var(--sol-editor-bg)' }} onMouseDown={onFocusEditor}>
      {showActionBar && (
        <div className="flex items-center justify-end gap-1 shrink-0 px-2" style={{ height: 28, backgroundColor: 'var(--sol-bg)', borderBottom: '1px solid var(--sol-border)' }}>
          {showMic && (
            <VoiceControl
              capability={voice.capability}
              state={voice.state}
              onRecord={voice.onRecord}
              onStop={voice.onStop}
            />
          )}
          <EditorActions
            tabId={activeTab ?? ''}
            previewMode={previewMode}
            splitDirection={splitDirection}
            autocompleteEnabled={autocompleteEnabled}
            isTouch={isTouch}
            onSetEditorPrefs={onLayoutUpdate}
          />
        </div>
      )}

      <WorkspaceBreadcrumbs activeTab={activeTab} onNavigateDir={onNavigateDir} />

      <WorkspaceEditorArea
        activeTab={activeTab}
        activeFilePath={activeFilePath}
        activeFileContent={activeFileContent}
        activeFileLoading={activeFileLoading}
        activeViewportLine={activeViewportLine}
        isDiffTab={activeDiffTab}
        activeDiff={activeDiff}
        isMd={isMd}
        isHtml={isHtml}
        previewMode={previewMode}
        splitDirection={splitDirection}
        splitSize={splitSize}
        onSplitResize={(size) => onLayoutUpdate({ splitSize: size })}
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
