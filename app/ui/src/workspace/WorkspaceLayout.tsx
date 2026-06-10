import type { ReactNode, RefObject } from 'react'
import { PaneSwitch } from '../components/PaneSwitch'
import { LandscapeNav } from '../components/LandscapeNav'
import { toggleTheme } from '../lib/theme'
import { Sun, Moon, FolderOpen, FileCode, ListTodo, SquareTerminal } from 'lucide-react'
import { VResizeHandle, HResizeHandle } from './ResizeHandle'
import { SectionHeader } from './SectionHeader'
import { PanelHost } from './PanelHost'
import { PanelChromeContext, type PanelChromeSlot } from './panelChrome'
import type { WorkspaceLayout as LayoutState } from '../hooks/useWorkspaceState'
import type { MobilePane } from '../hooks/workspaceTypes'
import type { PanelId } from './context'

type ResizeState = {
  size: number
  onMouseDown: (e: React.MouseEvent) => void
  isDragging: boolean
}

export type WorkspaceLayoutProps = {
  isMobile: boolean
  isLandscape: boolean
  isTouch: boolean
  layout: LayoutState
  mobilePane: MobilePane
  onLayoutUpdate: (partial: Partial<LayoutState>) => void
  onMobilePaneChange: (pane: MobilePane) => void

  // Tasks toggle (sidebar header on desktop / pane switch on mobile)
  onToggleTasks?: () => void

  // The active main panel (editor/tasks) shown in the desktop editor region. The
  // tree renderer reads this from the layout tree; the legacy renderer takes it as
  // a prop so it can render the real tasks panel instead of the removed fake tab.
  mainPanel: PanelId

  // Resize
  rootRef: RefObject<HTMLDivElement | null>
  sidebarRef: RefObject<HTMLDivElement | null>
  left: ResizeState
  right: ResizeState
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
  notificationBell?: ReactNode
}

// Each framed panel (projects/files/changes/sessions) renders its own
// SectionHeader-equivalent header + body via PanelHost → PanelFrame. The renderer
// supplies the per-section collapse state and body sizing through a chrome slot,
// so the body measures exactly like the old inline section wrapper and the
// collapse toggle drives the same `show*` layout flags. Desktop and mobile size
// the same panels differently, so the slots are built per render mode.
export function WorkspaceLayout(props: WorkspaceLayoutProps) {
  const {
    isMobile, isLandscape, isTouch,
    layout, mobilePane, onLayoutUpdate, onMobilePaneChange,
    onToggleTasks,
    mainPanel,
    rootRef, sidebarRef, left, right,
    changesSplit, changesHeight, projectSplit, projectHeight, sessionSplit, sessionHeight,
    hasOpenTabs,
    onInteractionCapture, onFilesPaneFocus, searchOverlay, notificationBell,
  } = props

  const { showSidebar, showRightPanel, showProjects, showExplorer, showChanges, showSessions, showTasks } = layout
  // When Explorer is collapsed, the first expanded bottom section grows to fill.
  const flexFallback = !showExplorer
    ? (showChanges ? 'changes' : showTasks ? 'tasks' : null)
    : null
  // The main region is occupied when there are open editor tabs OR the tasks
  // panel is the active main panel. Tasks no longer adds a fake editor tab, so
  // the activity column must size off this (not bare `hasOpenTabs`) or it would
  // flex-expand over the editor's docked width while Tasks fills the main region.
  const hasMainSurface = hasOpenTabs || mainPanel === 'tasks'
  const shouldShowEditorPane = hasMainSurface || !showRightPanel
  const changesGrows = flexFallback === 'changes'

  // Chrome slots: collapse + body sizing the framed PanelHosts read. Rebuilt each
  // render so live resize sizes (projectHeight/changesHeight/sessionHeight) and
  // collapse flags flow straight through to the section bodies.
  const chromeSlots: Record<string, PanelChromeSlot> = isMobile ? {
    projects: {
      collapsed: !showProjects,
      onToggle: () => onLayoutUpdate({ showProjects: !showProjects }),
      containerClassName: 'shrink-0 flex flex-col',
      bodyClassName: 'shrink-0',
    },
    files: {
      collapsed: !showExplorer,
      onToggle: () => onLayoutUpdate({ showExplorer: !showExplorer }),
      containerClassName: showExplorer ? 'flex-1 min-h-0 flex flex-col' : 'shrink-0 flex flex-col',
      bodyClassName: 'flex-1 min-h-0 flex flex-col',
    },
    changes: {
      collapsed: !showChanges,
      onToggle: () => onLayoutUpdate({ showChanges: !showChanges }),
      containerClassName: showChanges ? 'flex-1 min-h-0 flex flex-col' : 'shrink-0 flex flex-col',
      bodyClassName: 'flex-1 min-h-0 overflow-y-auto py-1',
    },
    sessions: {
      collapsed: !showSessions,
      onToggle: () => onLayoutUpdate({ showSessions: !showSessions }),
      containerClassName: showSessions ? 'flex-1 min-h-0 flex flex-col' : 'shrink-0 flex flex-col',
      bodyClassName: 'flex-1 min-h-0 overflow-hidden',
    },
  } : {
    projects: {
      collapsed: !showProjects,
      onToggle: () => onLayoutUpdate({ showProjects: !showProjects }),
      containerClassName: 'shrink-0 flex flex-col',
      bodyClassName: 'shrink-0 overflow-y-auto',
      bodyStyle: { height: projectHeight },
    },
    files: {
      collapsed: !showExplorer,
      onToggle: () => onLayoutUpdate({ showExplorer: !showExplorer }),
      containerClassName: showExplorer ? 'min-h-0 flex flex-col' : 'shrink-0 flex flex-col',
      containerStyle: showExplorer ? { flex: 1 } : undefined,
      bodyClassName: 'min-h-0 flex flex-col',
      bodyStyle: { flex: 1, minHeight: 80 },
    },
    changes: {
      collapsed: !showChanges,
      onToggle: () => onLayoutUpdate({ showChanges: !showChanges }),
      containerClassName: changesGrows ? 'min-h-0 flex flex-col' : 'shrink-0 flex flex-col',
      containerStyle: changesGrows ? { flex: 1 } : undefined,
      bodyClassName: 'min-h-0 py-1 overflow-y-auto',
      bodyStyle: changesGrows ? { flex: 1 } : { height: changesHeight, minHeight: 50 },
    },
    sessions: {
      collapsed: !showSessions,
      onToggle: () => onLayoutUpdate({ showSessions: !showSessions }),
      containerClassName: 'shrink-0 flex flex-col',
      bodyClassName: 'shrink-0 overflow-hidden',
      bodyStyle: { height: sessionHeight },
    },
  }

  return (
    <PanelChromeContext.Provider value={chromeSlots}>
    <div
      ref={rootRef}
      className={`flex h-full ${isTouch ? '' : 'select-none'}`}
      onMouseDownCapture={onInteractionCapture}
      onTouchStartCapture={onInteractionCapture}
      onKeyDownCapture={onInteractionCapture}
    >
      {searchOverlay}

      {isMobile ? (
        <div className="flex-1 min-w-0 flex flex-col relative"
          style={isLandscape ? {
            paddingLeft: 'max(env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px), 36px)',
            paddingRight: 'max(env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px), 36px)',
            paddingTop: 8,
            paddingBottom: 8,
          } : undefined}
        >
          {isLandscape ? (
            <>
              <LandscapeNav activePane={mobilePane} onPaneChange={(v) => onMobilePaneChange(v)} />
              {/* Notification bell — right margin, mirroring toggle position */}
              <div className="absolute z-50 flex items-center justify-center"
                style={{ top: 'max(env(safe-area-inset-top, 0px), 24px)', right: 'calc(max(env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px), 36px) - 34px)', width: 32, height: 32 }}
              >
                {notificationBell}
              </div>
              {/* Theme toggle — right margin, below bell */}
              <button
                className="absolute z-50 flex items-center justify-center rounded-lg cursor-pointer theme-toggle-single"
                style={{
                  top: 'calc(max(env(safe-area-inset-top, 0px), 24px) + 36px)',
                  right: 'calc(max(env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px), 36px) - 34px)',
                  width: 32,
                  height: 32,
                  color: 'var(--sol-text-dim)',
                  transition: 'color 120ms',
                }}
                onClick={toggleTheme}
                title="Toggle theme"
                aria-label="Toggle theme"
              >
                <Sun size={14} strokeWidth={2.5} className="icon-sun" />
                <Moon size={14} strokeWidth={2.5} className="icon-moon" />
              </button>
            </>
          ) : (
            <div className="shrink-0 border-b border-[var(--sol-border)] px-2 py-2 flex items-center gap-2" style={{ backgroundColor: 'var(--sol-editor-bg)' }}>
              <div className="flex-1 min-w-0 max-w-[80%]">
                <PaneSwitch
                  options={[
                    { id: 'files', label: 'Browse', icon: <FolderOpen size={13} /> },
                    { id: 'editor', label: 'Editor', icon: <FileCode size={13} /> },
                    { id: 'tasks', label: 'Tasks', icon: <ListTodo size={13} /> },
                    { id: 'terminal', label: 'Terminal', icon: <SquareTerminal size={13} /> },
                  ]}
                  value={mobilePane}
                  onChange={(v) => onMobilePaneChange(v as MobilePane)}
                />
              </div>
              {notificationBell}
              <button className="theme-toggle-single shrink-0 rounded p-1 cursor-pointer text-[var(--sol-text-dim)] hover:text-[var(--sol-text)]" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme" style={{ transition: 'color 120ms' }}>
                <Sun size={14} strokeWidth={2.5} className="icon-sun" />
                <Moon size={14} strokeWidth={2.5} className="icon-moon" />
              </button>
            </div>
          )}
          <div className="flex-1 min-h-0 flex flex-col">
            {mobilePane === 'files' && (
              <div className="h-full flex flex-col overflow-y-auto" style={{ backgroundColor: 'var(--sol-bg)' }} onMouseDown={onFilesPaneFocus}>
                <PanelHost id="projects" />
                <PanelHost id="files" />
                <PanelHost id="changes" />
                <PanelHost id="sessions" />
              </div>
            )}
            {mobilePane === 'editor' && <PanelHost id="editor" />}
            {mobilePane === 'tasks' && <PanelHost id="tasks" />}
            {mobilePane === 'terminal' && (
              <div className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ backgroundColor: 'var(--sol-bg)' }}>
                <PanelHost id="terminal" />
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Desktop sidebar: Projects + Explorer + Changes + Tasks */}
          {showSidebar && (
            <>
              <div ref={sidebarRef} role="navigation" aria-label="Sidebar" className="flex flex-col overflow-hidden" style={{ width: left.size, backgroundColor: 'var(--sol-bg)' }}>
                <PanelHost id="projects" />

                {showProjects && showExplorer && <HResizeHandle onMouseDown={projectSplit.onMouseDown} isDragging={projectSplit.isDragging} />}

                <PanelHost id="files" />

                {showExplorer && showChanges && <HResizeHandle onMouseDown={changesSplit.onMouseDown} isDragging={changesSplit.isDragging} />}

                <PanelHost id="changes" />

                {/* Tasks toggle — pinned at bottom */}
                <div className="mt-auto shrink-0">
                  <SectionHeader title="Tasks" collapsed={!showTasks} onToggle={onToggleTasks ?? (() => onLayoutUpdate({ showTasks: !showTasks }))} />
                </div>
              </div>
              <VResizeHandle onMouseDown={left.onMouseDown} isDragging={left.isDragging} />
            </>
          )}

          {/* Editor column */}
          {shouldShowEditorPane && (
            <>
              <div role="main" className="flex-1 min-w-0 flex flex-col">
                <PanelHost id={mainPanel} />
              </div>
              {showRightPanel && <VResizeHandle onMouseDown={right.onMouseDown} isDragging={right.isDragging} />}
            </>
          )}

          {/* Activity column: Terminal + Sessions */}
          {showRightPanel && (
            <div
              role="complementary"
              aria-label="Activity panel"
              className="flex flex-col overflow-hidden min-w-0"
              style={{
                flex: !hasMainSurface ? 1 : undefined,
                width: hasMainSurface ? right.size : undefined,
                backgroundColor: 'var(--sol-bg)',
              }}
            >
              <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                <PanelHost id="terminal" />
              </div>
              {showSessions && <HResizeHandle onMouseDown={sessionSplit.onMouseDown} isDragging={sessionSplit.isDragging} />}
              <PanelHost id="sessions" />
            </div>
          )}
        </>
      )}
    </div>
    </PanelChromeContext.Provider>
  )
}
