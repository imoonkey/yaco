import type { ReactNode, RefObject } from 'react'
import { PaneSwitch } from '../components/PaneSwitch'
import { SOLARIZED_LIGHT_UI as C } from '../lib/solarizedLight'
import { VResizeHandle, HResizeHandle } from './ResizeHandle'
import { SectionHeader } from './SectionHeader'
import type { WorkspaceLayout as LayoutState } from '../hooks/useWorkspaceState'

type ResizeState = {
  size: number
  onMouseDown: (e: React.MouseEvent) => void
  isDragging: boolean
}

export type WorkspaceLayoutProps = {
  isMobile: boolean
  isTouch: boolean
  layout: LayoutState
  mobilePane: 'files' | 'editor' | 'terminal'
  onLayoutUpdate: (partial: Partial<LayoutState>) => void
  onMobilePaneChange: (pane: 'files' | 'editor' | 'terminal') => void

  // Section content
  projectName: string
  projectListBody: ReactNode
  explorerActions: ReactNode
  explorerBody: ReactNode
  gitStale: boolean
  changesBadge?: number
  changesBody: ReactNode
  tasksBody: ReactNode
  sessionsActions: ReactNode
  sessionsBody: ReactNode

  // Main panes
  editorPane: ReactNode
  terminalContent: ReactNode

  // Resize
  rootRef: RefObject<HTMLDivElement | null>
  sidebarRef: RefObject<HTMLDivElement | null>
  left: ResizeState
  right: ResizeState
  explorerSplit: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }
  explorerHeight: number
  projectSplit: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }
  projectHeight: number
  sessionSplit: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }
  sessionHeight: number

  // Derived
  hasOpenTabs: boolean

  // Interactions
  onInteractionCapture: () => void
  onFilesPaneFocus: () => void
  searchOverlay: ReactNode | null
}

export function WorkspaceLayout(props: WorkspaceLayoutProps) {
  const {
    isMobile, isTouch,
    layout, mobilePane, onLayoutUpdate, onMobilePaneChange,
    projectName, projectListBody, explorerActions, explorerBody,
    gitStale, changesBadge, changesBody, tasksBody,
    sessionsActions, sessionsBody,
    editorPane, terminalContent,
    rootRef, sidebarRef, left, right, explorerSplit, explorerHeight, projectSplit, projectHeight, sessionSplit, sessionHeight,
    hasOpenTabs,
    onInteractionCapture, onFilesPaneFocus, searchOverlay,
  } = props

  const { showSidebar, showRightPanel, showExplorer, showChanges, showSessions, showTasks } = layout
  const shouldShowEditorPane = hasOpenTabs || !showRightPanel

  return (
    <div
      ref={rootRef}
      className={`flex h-full ${isTouch ? '' : 'select-none'}`}
      onMouseDownCapture={onInteractionCapture}
      onTouchStartCapture={onInteractionCapture}
      onKeyDownCapture={onInteractionCapture}
    >
      {searchOverlay}

      {isMobile ? (
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="shrink-0 border-b border-[var(--sol-base2)] px-3 py-2" style={{ backgroundColor: C.editorBg }}>
            <PaneSwitch
              options={[
                { id: 'files', label: 'Browse' },
                { id: 'editor', label: 'Editor' },
                { id: 'terminal', label: 'Terminal' },
              ]}
              value={mobilePane}
              onChange={(v) => onMobilePaneChange(v as 'files' | 'editor' | 'terminal')}
            />
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            {mobilePane === 'files' && (
              <div className="h-full flex flex-col overflow-y-auto" style={{ backgroundColor: C.bg }} onMouseDown={onFilesPaneFocus}>
                <SectionHeader title="Projects" collapsed={false} onToggle={() => {}} />
                <div className="shrink-0">{projectListBody}</div>

                <SectionHeader title={projectName || 'Explorer'} collapsed={!showExplorer} onToggle={() => onLayoutUpdate({ showExplorer: !showExplorer })} actions={explorerActions} />
                {showExplorer && <div className="flex-1 min-h-0 flex flex-col">{explorerBody}</div>}

                <SectionHeader title={gitStale ? 'Changes (stale)' : 'Changes'} collapsed={!showChanges} onToggle={() => onLayoutUpdate({ showChanges: !showChanges })} badge={changesBadge} />
                {showChanges && <div className="flex-1 min-h-0 overflow-y-auto py-1 px-1">{changesBody}</div>}

                <SectionHeader title="Tasks" collapsed={!showTasks} onToggle={() => onLayoutUpdate({ showTasks: !showTasks })} />
                {showTasks && <div className="shrink-0 px-2 py-2">{tasksBody}</div>}

                <SectionHeader title="Sessions" collapsed={!showSessions} onToggle={() => onLayoutUpdate({ showSessions: !showSessions })} actions={sessionsActions} />
                {showSessions && <div className="flex-1 min-h-0 overflow-y-auto py-1 px-1">{sessionsBody}</div>}
              </div>
            )}
            {mobilePane === 'editor' && editorPane}
            {mobilePane === 'terminal' && (
              <div className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ backgroundColor: C.bg }}>
                {terminalContent}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Desktop sidebar: Projects + Explorer + Changes + Tasks */}
          {showSidebar && (
            <>
              <div ref={sidebarRef} className="flex flex-col overflow-hidden" style={{ width: left.size, backgroundColor: C.bg, boxShadow: '1px 0 3px rgba(0,0,0,0.06)' }}>
                <SectionHeader title="Projects" collapsed={false} onToggle={() => {}} />
                <div className="shrink-0 overflow-y-auto" style={{ height: projectHeight }}>{projectListBody}</div>

                {showExplorer && <HResizeHandle onMouseDown={projectSplit.onMouseDown} isDragging={projectSplit.isDragging} />}

                <SectionHeader title={projectName || 'Explorer'} collapsed={!showExplorer} onToggle={() => onLayoutUpdate({ showExplorer: !showExplorer })} actions={explorerActions} />
                {showExplorer && (
                  <div className="shrink-0 min-h-0 flex flex-col" style={{ height: showChanges ? explorerHeight : undefined, flex: showChanges ? 'none' : 1 }}>
                    {explorerBody}
                  </div>
                )}

                {showExplorer && showChanges && <HResizeHandle onMouseDown={explorerSplit.onMouseDown} isDragging={explorerSplit.isDragging} />}

                <SectionHeader title={gitStale ? 'Changes (stale)' : 'Changes'} collapsed={!showChanges} onToggle={() => onLayoutUpdate({ showChanges: !showChanges })} badge={changesBadge} />
                {showChanges && (
                  <div className="flex-1 overflow-y-auto py-1 px-1 min-h-0">
                    {changesBody}
                  </div>
                )}

                <SectionHeader title="Tasks" collapsed={!showTasks} onToggle={() => onLayoutUpdate({ showTasks: !showTasks })} />
                {showTasks && (
                  <div className="shrink-0 px-2 py-2">
                    {tasksBody}
                  </div>
                )}
              </div>
              <VResizeHandle onMouseDown={left.onMouseDown} isDragging={left.isDragging} />
            </>
          )}

          {/* Editor column */}
          {shouldShowEditorPane && (
            <>
              {editorPane}
              {showRightPanel && <VResizeHandle onMouseDown={right.onMouseDown} isDragging={right.isDragging} />}
            </>
          )}

          {/* Activity column: Terminal + Sessions */}
          {showRightPanel && (
            <div
              className="flex flex-col overflow-hidden min-w-0"
              style={{
                flex: !hasOpenTabs ? 1 : undefined,
                width: hasOpenTabs ? right.size : undefined,
                backgroundColor: C.bg,
                boxShadow: '-1px 0 3px rgba(0,0,0,0.06)',
              }}
            >
              <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                {terminalContent}
              </div>
              {showSessions && <HResizeHandle onMouseDown={sessionSplit.onMouseDown} isDragging={sessionSplit.isDragging} />}
              <SectionHeader title="Sessions" collapsed={!showSessions} onToggle={() => onLayoutUpdate({ showSessions: !showSessions })} actions={sessionsActions} />
              {showSessions && (
                <div className="shrink-0 overflow-y-auto py-1 px-1" style={{ height: sessionHeight }}>
                  {sessionsBody}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
