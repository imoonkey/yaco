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
  projectActions: ReactNode
  explorerActions: ReactNode
  explorerBody: ReactNode
  searchBody: ReactNode
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
  searchSplit: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }
  searchHeight: number
  changesSplit: { onMouseDown: (e: React.MouseEvent) => void; isDragging: boolean }
  changesHeight: number
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
    projectName, projectListBody, projectActions, explorerActions, explorerBody,
    searchBody,
    gitStale, changesBadge, changesBody, tasksBody,
    sessionsActions, sessionsBody,
    editorPane, terminalContent,
    rootRef, sidebarRef, left, right, searchSplit, searchHeight, changesSplit, changesHeight, projectSplit, projectHeight, sessionSplit, sessionHeight,
    hasOpenTabs,
    onInteractionCapture, onFilesPaneFocus, searchOverlay,
  } = props

  const { showSidebar, showRightPanel, showProjects, showExplorer, showChanges, showSessions, showTasks, showTextSearch } = layout
  // When Explorer is collapsed, first expanded bottom section gets flex:1
  const flexFallback = !showExplorer
    ? (showTextSearch ? 'search' : showChanges ? 'changes' : showTasks ? 'tasks' : null)
    : null
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
          <div className="shrink-0 border-b border-[var(--sol-base2)] px-3 py-1" style={{ backgroundColor: C.editorBg }}>
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
                <SectionHeader title="Projects" collapsed={!showProjects} onToggle={() => onLayoutUpdate({ showProjects: !showProjects })} actions={projectActions} />
                {showProjects && <div className="shrink-0">{projectListBody}</div>}

                <SectionHeader title={projectName || 'Explorer'} collapsed={!showExplorer} onToggle={() => onLayoutUpdate({ showExplorer: !showExplorer })} actions={explorerActions} />
                {showExplorer && <div className="flex-1 min-h-0 flex flex-col">{explorerBody}</div>}

                <SectionHeader title="Search" collapsed={!showTextSearch} onToggle={() => onLayoutUpdate({ showTextSearch: !showTextSearch })} />
                {showTextSearch && <div className="flex-1 min-h-0 flex flex-col">{searchBody}</div>}

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
                <SectionHeader title="Projects" collapsed={!showProjects} onToggle={() => onLayoutUpdate({ showProjects: !showProjects })} actions={projectActions} />
                {showProjects && <div className="shrink-0 overflow-y-auto" style={{ height: projectHeight }}>{projectListBody}</div>}

                {showProjects && showExplorer && <HResizeHandle onMouseDown={projectSplit.onMouseDown} isDragging={projectSplit.isDragging} />}

                <SectionHeader title={projectName || 'Explorer'} collapsed={!showExplorer} onToggle={() => onLayoutUpdate({ showExplorer: !showExplorer })} actions={explorerActions} />
                {showExplorer && (
                  <div className="min-h-0 flex flex-col" style={{ flex: 1, minHeight: 80 }}>
                    {explorerBody}
                  </div>
                )}

                {showExplorer && (showTextSearch || showChanges) && (
                  <HResizeHandle
                    onMouseDown={showTextSearch ? searchSplit.onMouseDown : changesSplit.onMouseDown}
                    isDragging={showTextSearch ? searchSplit.isDragging : changesSplit.isDragging}
                  />
                )}

                <SectionHeader title="Search" collapsed={!showTextSearch} onToggle={() => onLayoutUpdate({ showTextSearch: !showTextSearch })} />
                {showTextSearch && (
                  <div
                    className="min-h-0 flex flex-col"
                    style={flexFallback === 'search' ? { flex: 1 } : { height: searchHeight, minHeight: 50, overflowY: 'auto' }}
                  >
                    {searchBody}
                  </div>
                )}

                {showTextSearch && showChanges && <HResizeHandle onMouseDown={changesSplit.onMouseDown} isDragging={changesSplit.isDragging} />}

                <SectionHeader title={gitStale ? 'Changes (stale)' : 'Changes'} collapsed={!showChanges} onToggle={() => onLayoutUpdate({ showChanges: !showChanges })} badge={changesBadge} />
                {showChanges && (
                  <div
                    className="min-h-0 py-1 px-1"
                    style={flexFallback === 'changes' ? { flex: 1, overflowY: 'auto' } : { height: changesHeight, minHeight: 50, overflowY: 'auto' }}
                  >
                    {changesBody}
                  </div>
                )}

                <SectionHeader title="Tasks" collapsed={!showTasks} onToggle={() => onLayoutUpdate({ showTasks: !showTasks })} />
                {showTasks && (
                  <div
                    className={flexFallback === 'tasks' ? 'px-2 py-2 min-h-0' : 'px-2 py-2'}
                    style={flexFallback === 'tasks' ? { flex: 1 } : undefined}
                  >
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
