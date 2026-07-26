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
// the notification-bell + usage + theme-toggle placement. This file owns that chrome.
//
// Active-pane model: the projection reads the model field
// `panelLayout.mobile.activeDock` (a `MobileDock`), mirroring how
// `DesktopPanelTreeLayout` reads `panelLayout.desktop` rather than the flat
// layout. Pane switches still flow through the app's single `setMobilePane`
// write path (a `MobilePane`); the provider mirrors that onto `activeDock`. The
// `MobileDock` ⇄ `MobilePane` conversion is the only place the two vocabularies
// meet (`mobileDockToPane` for the switch UI, the provider's mirror for writes).
import { useCallback, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { Sun, Moon, X, AlertTriangle, FileDiff } from 'lucide-react'
import { PaneSwitch } from '../components/PaneSwitch'
import { LandscapeNav } from '../components/LandscapeNav'
import { toggleTheme } from '../lib/theme'
import { PanelHost } from './PanelHost'
import { PanelChromeContext, type PanelChromeSlot } from './panelChrome'
import { collectFramedLeaves } from './desktopTreeSizing'
import { editorTabsInGroup, terminalTabsInGroup, tabIdToPath, groupOf, editorTabView } from './panelLayoutModel'
import { tabName, computeDisambigSuffixes } from './tabLabels'
import { FileTypeIcon } from '../components/fileExplorerIcons'
import { mobileDockPanels, type MobileDock } from './panelMeta'
import {
  useWorkspaceEnv, useWorkspaceLayout, useWorkspaceCommands, useWorkspaceSelection,
  useWorkspaceEditorTabs, useWorkspaceVoiceSurface,
} from './context'
import { mobileDockToPane, isDiffTab, isFileTab, type MobilePane, type EditorGroupTab } from '../hooks/workspaceTypes'
import { Menu, MenuItem } from '../components/Menu'
import { useContextMenu } from '../components/useContextMenu'
import { VoiceControl } from '../components/VoiceControl'
import { EditorActions } from './EditorActions'

export type MobilePanelProjectionProps = {
  rootRef: RefObject<HTMLDivElement | null>
  searchOverlay: ReactNode | null
  onInteractionCapture: () => void
}

// Portrait pane-switcher options, in mobile dock order. Ids are `MobilePane`
// (the value `PaneSwitch`/`setMobilePane` speak); labels match `LandscapeNav` so
// either chrome names the panes identically. Labels only — a phone header holds
// four labelled segments OR labels plus glyphs, not both.
const PANE_OPTIONS: { id: MobilePane; label: string }[] = [
  { id: 'files', label: 'Browse' },
  { id: 'editor', label: 'Editor' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'terminal', label: 'Terminal' },
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
  const { viewport, notificationBell, usageIndicator } = useWorkspaceEnv()
  const { isLandscape, isTouch } = viewport
  const { panelLayout, layout } = useWorkspaceLayout()
  const commands = useWorkspaceCommands()
  const voice = useWorkspaceVoiceSurface()
  const setMobilePane = commands.actions.setMobilePane
  const collapsePanel = commands.collapsePanel

  const activeDock = panelLayout.mobile.activeDock
  const activePane = mobileDockToPane(activeDock)
  // Mobile shows the active editor/terminal instance across the full desktop tree.
  // A desktop group may live in a sidebar, but session/file clicks on mobile still
  // activate that instance and the mobile pane must follow it.
  const { activeEditorId, activeTerminalId } = useWorkspaceSelection()
  const tree = panelLayout.desktop
  const editorGroupId = activeEditorId ? groupOf(tree, activeEditorId) : null
  const groupEditorTabs = editorGroupId ? editorTabsInGroup(tree, editorGroupId) : []
  const editorInstanceId =
    groupEditorTabs.find((t) => t.instanceId === activeEditorId)?.instanceId
    ?? groupEditorTabs[0]?.instanceId
    ?? ''
  const activeEditorTabId = groupEditorTabs.find((t) => t.instanceId === editorInstanceId)?.tabId ?? ''
  // The mobile editor-actions toggle reflects the active editor tab's PER-TAB view.
  const activeEditorView = editorTabView(groupEditorTabs.find((t) => t.instanceId === editorInstanceId) ?? null)
  const showMobileEditorActions = voice.editor.eligible
    || (!!activeEditorTabId && !isDiffTab(activeEditorTabId))
  const terminalGroupId = activeTerminalId ? groupOf(tree, activeTerminalId) : null
  const groupTerminals = terminalGroupId ? terminalTabsInGroup(tree, terminalGroupId) : []
  const terminalInstanceId =
    groupTerminals.find((t) => t.instanceId === activeTerminalId)?.instanceId
    ?? groupTerminals[0]?.instanceId
    ?? null

  // The mobile editor tab strip — the active group's editor tabs, switchable +
  // closable (FIX D). Mobile renders a single instance body, so without this strip a
  // multi-tab group shows only its active tab with no way to switch between them.
  const editorTabStrip = (
    <MobileEditorTabs
      tabs={groupEditorTabs}
      activeInstanceId={editorInstanceId}
      onSelect={(tabId, instanceId) => commands.selectTab(tabId, instanceId)}
      onClose={(instanceId) => commands.closePane(instanceId)}
      onSave={(tabId) => {
        const path = tabIdToPath(tabId)
        const file = commands.actions.filesRef.current[path]
        if (file) void commands.saveFile(path, file.draft ?? file.serverContent ?? '')
      }}
      onCloseWithoutSaving={(tab) => {
        commands.acceptDisk(tabIdToPath(tab.tabId))
        commands.closePane(tab.instanceId)
      }}
      actions={showMobileEditorActions ? (
        <>
          {voice.editor.eligible && (
            <VoiceControl
              capability={voice.editor.capability}
              state={voice.editor.state}
              onRecord={voice.editor.onRecord}
              onStop={voice.editor.onStop}
            />
          )}
          {activeEditorTabId && (
            <EditorActions
              tabId={activeEditorTabId}
              previewMode={activeEditorView.previewMode}
              splitDirection={activeEditorView.splitDirection}
              autocompleteEnabled={layout.autocompleteEnabled}
              isTouch={isTouch}
              onSetView={(patch) => commands.setTabView(editorInstanceId, patch)}
              onSetAutocomplete={commands.setAutocomplete}
            />
          )}
        </>
      ) : null}
    />
  )

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
              {/* Usage quota — right margin, below the bell. */}
              <div
                className="absolute z-50 flex items-center justify-center"
                style={{ top: `calc(${MARGIN_TOP} + 36px)`, right: MARGIN_RIGHT, width: 32, height: 32 }}
              >
                {usageIndicator}
              </div>
              {/* Theme toggle — right margin, below the usage icon. */}
              <button
                className="absolute z-50 flex items-center justify-center rounded-lg cursor-pointer theme-toggle-single"
                style={{
                  top: `calc(${MARGIN_TOP} + 72px)`,
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
            <div className="shrink-0 border-b border-[var(--sol-border)] px-2 py-2 flex items-center gap-1.5" style={{ backgroundColor: 'var(--sol-editor-bg)' }}>
              <div className="flex-1 min-w-0">
                <PaneSwitch
                  options={PANE_OPTIONS}
                  value={activePane}
                  onChange={(v) => setMobilePane(v as MobilePane)}
                />
              </div>
              {usageIndicator}
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
              editorInstanceId={editorInstanceId}
              terminalInstanceId={terminalInstanceId}
              editorTabStrip={editorTabStrip}
            />
          </div>
        </div>
      </div>
    </PanelChromeContext.Provider>
  )
}

// Project the active dock's panels straight from the registry's mobile dock
// metadata (`mobileDockPanels`). Only the genuinely dock-specific wrapper chrome
// lives outside that map — the browse scroll surface + explorer-focus, the editor
// tab strip + body, and the terminal flex column — so a metadata change to ANY dock
// (membership or order) changes what projects here, not just the browse dock. The
// editor/terminal panels render the ACTIVE GROUP's instance ('' editor ⇒ "No file
// open"; no terminal ⇒ the idle 'terminal' placeholder).
function ActiveDockPanes({ dock, onBrowseFocus, editorInstanceId, terminalInstanceId, editorTabStrip }: {
  dock: MobileDock; onBrowseFocus: () => void; editorInstanceId: string; terminalInstanceId: string | null
  editorTabStrip: ReactNode
}) {
  const instanceOf = (panel: string): string | undefined =>
    panel === 'editor' ? editorInstanceId : panel === 'terminal' ? (terminalInstanceId ?? 'terminal') : undefined
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
  // editor: the switchable editor tab strip (FIX D) over the active tab's body.
  if (dock === 'editor') {
    return <>{editorTabStrip}{panels}</>
  }
  // tasks: unframed panel owns its chrome — no extra wrapper.
  return <>{panels}</>
}

// Mobile editor tab strip — the active group's editor tabs, switchable + closable.
// Mobile renders a single instance body (no desktop group tab bar), so without this
// strip a multi-tab group shows only its active tab with no way to switch (the FIX D
// regression). Editor tabs only — terminals have their own mobile pane. On touch a
// clean tab shows its close ×; a dirty tab shows only its dot (no destructive close
// without a confirm), mirroring the desktop strip's touch behaviour.
function MobileEditorTabs({ tabs, activeInstanceId, onSelect, onClose, onSave, onCloseWithoutSaving, actions }: {
  tabs: EditorGroupTab[]
  activeInstanceId: string
  onSelect: (tabId: string, instanceId: string) => void
  onClose: (instanceId: string) => void
  onSave: (tabId: string) => void
  onCloseWithoutSaving: (tab: EditorGroupTab) => void
  actions?: ReactNode
}) {
  // Dirty/conflict membership is subscribed HERE (the tab-strip leaf), not passed by
  // the projection wrapper — so a keystroke (which never flips membership) re-renders
  // neither the wrapper nor this strip.
  const { dirtyTabs, conflictTabs } = useWorkspaceEditorTabs()
  const disambig = useMemo(() => computeDisambigSuffixes(tabs.map((t) => t.tabId)), [tabs])
  const menu = useContextMenu()
  const [contextTab, setContextTab] = useState<EditorGroupTab | null>(null)
  const closeContextTab = useCallback((tab: EditorGroupTab) => {
    onClose(tab.instanceId)
    menu.close()
  }, [menu, onClose])
  if (tabs.length === 0) return null
  return (
    <div
      className="flex items-center shrink-0 min-w-0"
      style={{ height: 34, backgroundColor: 'var(--sol-bg)', borderBottom: '1px solid var(--sol-border)' }}
      data-testid="mobile-editor-tabs"
    >
      <div data-testid="mobile-editor-tab-list" className="flex-1 min-w-0 h-full flex items-center overflow-x-auto overflow-y-hidden">
        {tabs.map((tab) => {
          const isActive = tab.instanceId === activeInstanceId
          const path = tabIdToPath(tab.tabId)
          const isDirty = dirtyTabs.has(path)
          const isConflict = conflictTabs.has(path)
          const isDiff = isDiffTab(tab.tabId)
          const suffix = disambig.get(tab.tabId)
          return (
            <div
              key={tab.instanceId}
              data-testid="mobile-editor-tab"
              data-tab-instance={tab.instanceId}
              data-tab-active={isActive || undefined}
              onClick={() => onSelect(tab.tabId, tab.instanceId)}
              {...menu.bind(() => setContextTab(tab))}
              title={tab.tabId}
              className="flex items-center gap-1 px-2 h-full cursor-pointer text-ui-sm shrink-0"
              style={{
                borderRight: '1px solid var(--sol-border)',
                backgroundColor: isActive ? 'var(--sol-editor-bg)' : 'var(--sol-bg)',
                color: isActive ? 'var(--sol-text-dark)' : 'var(--sol-text)',
                borderTop: isActive ? `2px solid ${isConflict || isDiff ? 'var(--sol-warning)' : 'var(--sol-text)'}` : '2px solid transparent',
                fontStyle: tab.preview ? 'italic' : undefined,
              }}
            >
              {isDiff
                ? <FileDiff size={13} aria-hidden="true" className="shrink-0" />
                : <FileTypeIcon name={tab.tabId} />}
              <span className="truncate max-w-[140px]">{tabName(tab.tabId)}</span>
              {suffix && <span className="text-ui-xs ml-0.5 shrink-0" style={{ color: 'var(--sol-text-faint)' }}>{suffix}</span>}
              {isConflict ? (
                <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0" style={{ color: 'var(--sol-warning)' }} title="File changed on disk"><AlertTriangle size={11} /></span>
              ) : isDirty ? (
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: 'var(--sol-text-dark)' }} />
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); onClose(tab.instanceId) }}
                  className="w-4 h-4 flex items-center justify-center rounded cursor-pointer hover:bg-sol-hover-bg shrink-0"
                  style={{ color: 'var(--sol-text-dim)' }}
                  aria-label={`Close ${tabName(tab.tabId)}`}
                ><X size={12} /></button>
              )}
            </div>
          )
        })}
      </div>
      {actions && (
        <div
          data-testid="mobile-editor-actions"
          className="relative z-10 h-full flex items-center shrink-0 gap-1 px-1"
          style={{ borderLeft: '1px solid var(--sol-border)', backgroundColor: 'var(--sol-bg)' }}
        >
          {actions}
        </div>
      )}
      {menu.position && contextTab && (() => {
        const path = tabIdToPath(contextTab.tabId)
        const dirty = dirtyTabs.has(path)
        return (
          <Menu position={menu.position} exiting={menu.exiting} armed={menu.armed} focusOnOpen={menu.focusOnOpen} onExitDone={menu.onExitDone}>
            {dirty && isFileTab(contextTab.tabId) && (
              <MenuItem label="Save" onClick={() => { onSave(contextTab.tabId); menu.close() }} />
            )}
            {dirty ? (
              <MenuItem label="Close Without Saving" danger onClick={() => { onCloseWithoutSaving(contextTab); menu.close() }} />
            ) : (
              <MenuItem label="Close" onClick={() => closeContextTab(contextTab)} />
            )}
          </Menu>
        )
      })()}
    </div>
  )
}
