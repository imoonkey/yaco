// MobilePanelProjection — the mobile flexible-panel renderer (engine: 'tree').
//
// Design (phase 6 / mobile-panel-projection): mobile keeps the current four-pane
// interaction model — browse / editor / tasks / terminal — but projects it
// through the SAME `PanelHost` + registry the desktop tree uses, instead of the
// hardcoded slots of the legacy `WorkspaceLayout` mobile branch. The pane set and
// the browse-dock membership come from the registry's mobile dock metadata
// (`mobileDockPanels`), so adding/moving a mobile panel is a registry edit.
//
// What stays MOBILE-specific (and out of the desktop tree renderer): the
// safe-area insets, the portrait `PaneSwitch` vs landscape `LandscapeNav`, and
// the notification-bell + theme-toggle placement. This file owns that chrome.
//
// Active-pane model: the projection reads the model field
// `panelLayout.mobile.activeDock` (a `MobileDock`), mirroring how
// `DesktopPanelTreeLayout` reads `panelLayout.desktop` rather than the flat
// layout. Pane switches still flow through the app's single `setMobilePane`
// write path (a `MobilePane`); the provider mirrors that onto `activeDock`. The
// `MobileDock` ⇄ `MobilePane` conversion is the only place the two vocabularies
// meet (`mobileDockToPane` for the switch UI, the provider's mirror for writes).
import { useMemo, type ReactNode, type RefObject } from 'react'
import { Sun, Moon, FolderOpen, FileCode, ListTodo, SquareTerminal } from 'lucide-react'
import { PaneSwitch } from '../components/PaneSwitch'
import { LandscapeNav } from '../components/LandscapeNav'
import { toggleTheme } from '../lib/theme'
import { PanelHost } from './PanelHost'
import { PanelChromeContext, type PanelChromeSlot } from './panelChrome'
import { collectFramedLeaves } from './desktopTreeSizing'
import { mobileDockPanels, type MobileDock } from './panelMeta'
import { useWorkspaceEnv, useWorkspaceLayout, useWorkspaceCommands, useWorkspaceSelection } from './context'
import { mobileDockToPane, type MobilePane } from '../hooks/workspaceTypes'

export type MobilePanelProjectionProps = {
  rootRef: RefObject<HTMLDivElement | null>
  searchOverlay: ReactNode | null
  onInteractionCapture: () => void
}

// Portrait pane-switcher options, in mobile dock order. Ids are `MobilePane`
// (the value `PaneSwitch`/`setMobilePane` speak); labels match `LandscapeNav` so
// either chrome names the panes identically.
const PANE_OPTIONS: { id: MobilePane; label: string; icon: ReactNode }[] = [
  { id: 'files', label: 'Browse', icon: <FolderOpen size={13} /> },
  { id: 'editor', label: 'Editor', icon: <FileCode size={13} /> },
  { id: 'tasks', label: 'Tasks', icon: <ListTodo size={13} /> },
  { id: 'terminal', label: 'Terminal', icon: <SquareTerminal size={13} /> },
]

// Per-browse-panel mobile section chrome, mirroring the legacy mobile slots: the
// expanded body flexes (projects stays content-sized), a collapsed section is
// header-only (`shrink-0`). The collapse flag itself comes from the tree leaf, so
// browse-dock collapse shares one source with the desktop tree.
const BROWSE_CHROME: Record<string, { expanded: string; body: string }> = {
  projects: { expanded: 'shrink-0 flex flex-col', body: 'shrink-0' },
  files: { expanded: 'flex-1 min-h-0 flex flex-col', body: 'flex-1 min-h-0 flex flex-col' },
  changes: { expanded: 'flex-1 min-h-0 flex flex-col', body: 'flex-1 min-h-0 overflow-y-auto py-1' },
  sessions: { expanded: 'flex-1 min-h-0 flex flex-col', body: 'flex-1 min-h-0 overflow-hidden' },
}

const COLLAPSED_CONTAINER = 'shrink-0 flex flex-col'

// Landscape safe-area shell: pad the side margins to the inset floor (36px) so the
// LandscapeNav toggle / right-margin chrome clear the device corners, matching the
// legacy landscape container.
const LANDSCAPE_PAD = {
  paddingLeft: 'max(env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px), 36px)',
  paddingRight: 'max(env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px), 36px)',
  paddingTop: 8,
  paddingBottom: 8,
} as const

const MARGIN_RIGHT = 'calc(max(env(safe-area-inset-left, 0px), env(safe-area-inset-right, 0px), 36px) - 34px)'
const MARGIN_TOP = 'max(env(safe-area-inset-top, 0px), 24px)'

export function MobilePanelProjection({ rootRef, searchOverlay, onInteractionCapture }: MobilePanelProjectionProps) {
  const { viewport, notificationBell } = useWorkspaceEnv()
  const { isLandscape, isTouch } = viewport
  const { panelLayout } = useWorkspaceLayout()
  const commands = useWorkspaceCommands()
  const setMobilePane = commands.actions.setMobilePane
  const collapsePanel = commands.collapsePanel

  const activeDock = panelLayout.mobile.activeDock
  const activePane = mobileDockToPane(activeDock)
  // Mobile projects the ACTIVE editor/terminal instance (design: §D) — the editor
  // pane renders the active editor's view, the terminal pane the active terminal's
  // binding. Other panels are singletons (instanceId === type).
  const { activeEditorId, activeTerminalId } = useWorkspaceSelection()

  // Browse-dock section chrome: collapse + body sizing for each framed panel,
  // read by its `PanelHost` through `PanelChromeContext`. Collapse comes from the
  // tree leaf (shared with the desktop tree); body classes are the mobile ones.
  const chromeSlots = useMemo(() => {
    const slots: Record<string, PanelChromeSlot> = {}
    for (const leaf of collectFramedLeaves(panelLayout.desktop)) {
      const chrome = BROWSE_CHROME[leaf.panel]
      if (!chrome) continue
      slots[leaf.panel] = {
        collapsed: leaf.collapsed,
        onToggle: () => collapsePanel(leaf.panel, !leaf.collapsed),
        containerClassName: leaf.collapsed ? COLLAPSED_CONTAINER : chrome.expanded,
        bodyClassName: chrome.body,
      }
    }
    return slots
  }, [panelLayout.desktop, collapsePanel])

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
        <div
          className="flex-1 min-w-0 flex flex-col relative"
          style={isLandscape ? LANDSCAPE_PAD : undefined}
        >
          {isLandscape ? (
            <>
              <LandscapeNav activePane={activePane} onPaneChange={setMobilePane} />
              {/* Notification bell — right margin, mirroring the toggle position. */}
              <div
                className="absolute z-50 flex items-center justify-center"
                style={{ top: MARGIN_TOP, right: MARGIN_RIGHT, width: 32, height: 32 }}
              >
                {notificationBell}
              </div>
              {/* Theme toggle — right margin, below the bell. */}
              <button
                className="absolute z-50 flex items-center justify-center rounded-lg cursor-pointer theme-toggle-single"
                style={{
                  top: `calc(${MARGIN_TOP} + 36px)`,
                  right: MARGIN_RIGHT,
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
                  options={PANE_OPTIONS}
                  value={activePane}
                  onChange={(v) => setMobilePane(v as MobilePane)}
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
            <ActiveDockPanes
              dock={activeDock}
              onBrowseFocus={() => commands.setFocusTarget('explorer')}
              activeEditorId={activeEditorId}
              activeTerminalId={activeTerminalId}
            />
          </div>
        </div>
      </div>
    </PanelChromeContext.Provider>
  )
}

// Project the active dock's panels straight from the registry's mobile dock
// metadata (`mobileDockPanels`). Only the genuinely dock-specific wrapper chrome
// lives outside that map — the browse scroll surface + explorer-focus, and the
// terminal flex column — so a metadata change to ANY dock (membership or order)
// changes what projects here, not just the browse dock. The editor/terminal
// panels render the ACTIVE instance (its instanceId), so mobile shows one of N.
function ActiveDockPanes({ dock, onBrowseFocus, activeEditorId, activeTerminalId }: {
  dock: MobileDock; onBrowseFocus: () => void; activeEditorId: string; activeTerminalId: string | null
}) {
  const instanceOf = (panel: string): string | undefined =>
    panel === 'editor' ? activeEditorId : panel === 'terminal' ? (activeTerminalId ?? 'terminal') : undefined
  const panels = mobileDockPanels(dock).map((panel) => (
    <PanelHost key={panel} id={panel} instanceId={instanceOf(panel)} />
  ))
  if (dock === 'browse') {
    return (
      <div
        className="h-full flex flex-col overflow-y-auto"
        style={{ backgroundColor: 'var(--sol-bg)' }}
        onMouseDown={onBrowseFocus}
      >
        {panels}
      </div>
    )
  }
  if (dock === 'terminal') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ backgroundColor: 'var(--sol-bg)' }}>
        {panels}
      </div>
    )
  }
  // editor / tasks: unframed panels own their chrome — no extra wrapper.
  return <>{panels}</>
}
