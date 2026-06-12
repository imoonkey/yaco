import { useCallback } from 'react'
import { isDiffTab, isFileTab, type FileState, type PreviewMode, type SplitDirection } from '../hooks/workspaceTypes'
import type { WorkspaceLayout } from '../hooks/workspaceTypes'
import type { CapabilityState, InteractionState } from '../hooks/useVoice'
import { Sparkles } from 'lucide-react'
import { WorkspaceTabBar, type EditorSplitChrome } from './WorkspaceTabBar'
import { WorkspaceBreadcrumbs } from './WorkspaceBreadcrumbs'
import { WorkspaceEditorArea } from './WorkspaceEditorArea'
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
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
  dirtyTabs: Set<string>
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
  // Per-instance identity + chrome (design: §E). instanceId stamps the in-editor
  // self-jump so only this pane consumes it; editorSplit drives the tab-bar Split/
  // Move/Close control (suppressed on mobile); pathsOpenElsewhere lets the tab bar
  // skip its dirty-close confirm when a file is still open in another view.
  instanceId: string
  editorSplit?: EditorSplitChrome
  pathsOpenElsewhere?: ReadonlySet<string>
  // Discards the draft (→ clean) on an explicit "Close Without Saving" of a file's
  // last view, so the shared buffer GC drops it instead of resurrecting the edit.
  onDiscardDirty?: (path: string) => void
  onSelectTab: (tab: string) => void
  onDoubleClickTab: (tab: string) => void
  onCloseTab: (tab: string, e?: React.MouseEvent) => void
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
}

export function WorkspaceEditorColumn(props: WorkspaceEditorColumnProps) {
  const {
    openTabs, activeTab, previewTab, dirtyTabs, conflictTabs,
    files, layout, isTouch, isMobile,
    activeDiff, editorDiffHunks, jumpRequest, editorInsert,
    projectName, worktree, voice, compareContext,
    instanceId, editorSplit, pathsOpenElsewhere, onDiscardDirty,
    onSelectTab, onDoubleClickTab, onCloseTab, onLayoutUpdate,
    onSaveFile, onForceSave, onAcceptDisk, onUpdateDraft, onUpdateViewport,
    onSetJumpRequest, onNavigateToFile, onNavigateDir, onFocusEditor,
  } = props

  const { previewMode, splitDirection, splitSize, autocompleteEnabled } = layout

  // Derive from activeTab
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
  const suggestionsLabel = autocompleteEnabled
    ? 'Suggestions: disable inline suggestions'
    : 'Suggestions: enable inline suggestions'
  const suggestionsTitle = autocompleteEnabled
    ? 'Disable inline suggestions'
    : 'Enable inline suggestions - sends nearby markdown text to the model provider'

  const handleSaveTab = useCallback((tab: string) => {
    const f = files[tab]
    const content = f?.draft ?? f?.serverContent
    if (isFileTab(tab) && content != null) void onSaveFile(tab, content)
  }, [files, onSaveFile])

  const handleViewportLine = useCallback((line: number) => {
    if (activeFilePath) onUpdateViewport(activeFilePath, Math.max(1, line))
  }, [activeFilePath, onUpdateViewport])

  const handleActivateLine = useCallback((line: number) => {
    if (!activeFilePath) return
    // Stamp this pane's instanceId so the go-to-line is consumed only here
    // (design: §E — the last bare jumpRequest producer).
    onSetJumpRequest({ key: Date.now(), path: activeFilePath, line: clampLine(line), scroll: false, instanceId })
    if (previewMode !== 'split') onLayoutUpdate({ previewMode: 'edit' })
    onFocusEditor()
  }, [activeFilePath, previewMode, instanceId, onSetJumpRequest, onLayoutUpdate, onFocusEditor])

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ backgroundColor: 'var(--sol-editor-bg)' }} onMouseDown={onFocusEditor}>
      <WorkspaceTabBar
        openTabs={openTabs}
        activeTab={activeTab}
        previewTab={previewTab}
        dirtyTabs={dirtyTabs}
        conflictTabs={conflictTabs}
        canTogglePreview={canTogglePreview}
        previewMode={previewMode}
        splitDirection={splitDirection}
        isTouch={isTouch}
        onSelectTab={onSelectTab}
        onDoubleClickTab={onDoubleClickTab}
        onCloseTab={onCloseTab}
        onPreviewModeChange={(mode) => onLayoutUpdate({ previewMode: mode })}
        onSplitDirectionChange={(dir) => onLayoutUpdate({ splitDirection: dir })}
        onSaveTab={handleSaveTab}
        editorSplit={isMobile ? undefined : editorSplit}
        pathsOpenElsewhere={pathsOpenElsewhere}
        onDiscardDirty={onDiscardDirty}
        rightActions={<>
          {/* Per-pane mic is MOBILE-only: on desktop the GlobalVoiceControl in the
              app top bar is the single voice surface (design: §G). */}
          {isMobile && voice.eligible && (
            <VoiceControl
              capability={voice.capability}
              state={voice.state}
              onRecord={voice.onRecord}
              onStop={voice.onStop}
            />
          )}
          {showSuggestionsToggle && (
            <button
              onClick={() => onLayoutUpdate({ autocompleteEnabled: !autocompleteEnabled })}
              title={suggestionsTitle}
              aria-label={suggestionsLabel}
              aria-pressed={autocompleteEnabled}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 22, padding: 0,
                fontSize: 'var(--text-ui-sm)', border: 'none', borderRadius: 3, cursor: 'pointer',
                background: autocompleteEnabled ? 'color-mix(in srgb, var(--sol-blue) 8%, transparent)' : 'transparent',
                color: autocompleteEnabled ? 'var(--sol-text)' : 'var(--sol-text-dim)',
                opacity: autocompleteEnabled ? 1 : 0.6,
              }}
            >
              <Sparkles size={13} aria-hidden="true" />
            </button>
          )}
        </>}
      />

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
        onCloseTab={() => activeTab && onCloseTab(activeTab)}
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
