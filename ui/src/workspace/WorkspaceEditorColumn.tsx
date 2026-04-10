import { useCallback } from 'react'
import { isDiffTab, isFileTab, isTasksTab, type FileState, type MdMode } from '../hooks/workspaceTypes'
import type { WorkspaceLayout } from '../hooks/workspaceTypes'
import type { CapabilityState, InteractionState } from '../hooks/useVoice'
import { WorkspaceTabBar } from './WorkspaceTabBar'
import { WorkspaceBreadcrumbs } from './WorkspaceBreadcrumbs'
import { WorkspaceEditorArea } from './WorkspaceEditorArea'
import { VoiceControl } from '../components/VoiceControl'
import { TaskGraphScreen } from '../tasks/TaskGraphScreen'
import { clampLine } from './markdown'
import type { DiffState } from './useWorkspaceDiff'
import type { DiffHunk } from '../lib/parseDiff'

type JumpRequest = { key: number; path: string; line: number; scroll?: boolean }

interface EditorColumnVoice {
  eligible: boolean
  capability: CapabilityState
  state: InteractionState
  elapsedMs: number
  onStart: () => void
  onStop: () => void
}

export interface WorkspaceEditorColumnProps {
  openTabs: string[]
  activeTab: string | null
  previewTab: string | null
  dirtyTabs: Set<string>
  conflictTabs: Set<string>
  files: Record<string, FileState>
  layout: { mdMode: MdMode; splitSize: number; autocompleteEnabled: boolean }
  isTouch: boolean
  isMobile: boolean
  activeDiff: DiffState | null
  editorDiffHunks: DiffHunk[]
  jumpRequest: JumpRequest | null
  editorInsert: { text: string; key: number } | null
  projectName: string
  voice: EditorColumnVoice
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
  onOpenTasksFile: () => void
}

export function WorkspaceEditorColumn(props: WorkspaceEditorColumnProps) {
  const {
    openTabs, activeTab, previewTab, dirtyTabs, conflictTabs,
    files, layout, isTouch, isMobile,
    activeDiff, editorDiffHunks, jumpRequest, editorInsert,
    projectName, voice,
    onSelectTab, onDoubleClickTab, onCloseTab, onLayoutUpdate,
    onSaveFile, onForceSave, onAcceptDisk, onUpdateDraft, onUpdateViewport,
    onSetJumpRequest, onNavigateToFile, onNavigateDir, onFocusEditor, onOpenTasksFile,
  } = props

  const { mdMode, splitSize, autocompleteEnabled } = layout

  // Derive from activeTab
  const activeFilePath = isFileTab(activeTab) ? activeTab : null
  const activeDiffTab = isDiffTab(activeTab)
  const activeTasksTab = isTasksTab(activeTab)
  const isMd = activeFilePath?.endsWith('.md')
  const activeFileState = activeFilePath ? files[activeFilePath] : null
  const activeFileContent = activeFileState?.draft ?? activeFileState?.serverContent ?? null
  const activeFileLoading = activeFilePath != null && activeFileContent === null && activeFileState?.status !== 'missing'
  const activeViewportLine = activeFileState?.viewportLine ?? 1
  const hasConflict = !!activeFilePath && conflictTabs.has(activeFilePath)

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
    onSetJumpRequest({ key: Date.now(), path: activeFilePath, line: clampLine(line), scroll: false })
    if (mdMode !== 'split') onLayoutUpdate({ mdMode: 'edit' })
    onFocusEditor()
  }, [activeFilePath, mdMode, onSetJumpRequest, onLayoutUpdate, onFocusEditor])

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ backgroundColor: 'var(--sol-editor-bg)' }} onMouseDown={onFocusEditor}>
      <WorkspaceTabBar
        openTabs={openTabs}
        activeTab={activeTab}
        previewTab={previewTab}
        dirtyTabs={dirtyTabs}
        conflictTabs={conflictTabs}
        canToggleMdMode={!!isMd}
        mdMode={mdMode}
        isTouch={isTouch}
        onSelectTab={onSelectTab}
        onDoubleClickTab={onDoubleClickTab}
        onCloseTab={onCloseTab}
        onMdModeChange={(mode) => onLayoutUpdate({ mdMode: mode })}
        onSaveTab={handleSaveTab}
        rightActions={<>
          {voice.eligible && (
            <VoiceControl
              capability={voice.capability}
              state={voice.state}
              elapsedMs={voice.elapsedMs}
              onStart={voice.onStart}
              onStop={voice.onStop}
            />
          )}
          <button
            onClick={() => onLayoutUpdate({ autocompleteEnabled: !autocompleteEnabled })}
            title={autocompleteEnabled ? 'Disable autocomplete' : 'Enable autocomplete'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
              fontSize: 11, border: 'none', borderRadius: 3, cursor: 'pointer',
              background: autocompleteEnabled ? 'color-mix(in srgb, var(--sol-blue) 8%, transparent)' : 'transparent',
              color: autocompleteEnabled ? 'var(--sol-text)' : 'var(--sol-text-dim)',
              opacity: autocompleteEnabled ? 1 : 0.6,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 1v2M8 13v2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M1 8h2M13 8h2M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
            </svg>
            AI
          </button>
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
        isTasksTab={activeTasksTab}
        activeDiff={activeDiff}
        isMd={isMd}
        mdMode={mdMode}
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
        tasksPane={activeTasksTab ? <TaskGraphScreen projectName={projectName} onOpenTasksFile={onOpenTasksFile} /> : null}
        insertText={editorInsert?.text}
        insertRequestKey={editorInsert?.key}
        autocompleteEnabled={autocompleteEnabled}
        isMobile={isMobile}
      />
    </div>
  )
}
