// GroupTabBar — the working-area group's mixed editor+terminal tab strip.
//
// One flat, freely-orderable strip per group: each open file is its own editor
// tab (file/diff name from its `tabId` + dirty/conflict markers + disambiguation),
// each terminal its own tab (provider icon + bound session name, or "Terminal"
// when unbound). Selecting a tab activates it; each tab carries a close ×.
//
// The split affordance has two dismiss-safe routes onto ONE shared menu (Bug 2):
// a visible split button via `useContextMenu.openFromTrigger` (never the left-click
// `menu.open` antipattern), and the tab-bar empty area via `menu.bind()`'s
// `onContextMenu`. The menu stays open until a Split Up/Down/Left/Right (or, for an
// empty group, Close Group) choice. Within-group drag reorders tabs.
//
// Group-native callbacks are wired by `PanelGroup`; session metadata + `isTouch`
// are read from context here, and `useContextMenu` is instantiated internally.
import { useCallback, useContext, useMemo, useState } from 'react'
import { X, AlertTriangle, SplitSquareHorizontal } from 'lucide-react'
import { isDiffTab } from '../hooks/useWorkspaceState'
import { WorkspaceDataContext, WorkspaceEnvContext, type SplitSide, type EditorPrefs } from './context'
import type { GroupTab, PreviewMode, SplitDirection } from '../hooks/workspaceTypes'
import { tabIdToPath } from './panelLayoutModel'
import { tabName, computeDisambigSuffixes } from './tabLabels'
import { EditorActions } from './EditorActions'
import { FileTypeIcon } from '../components/fileExplorerIcons'
import { ProviderIcon } from '../components/SessionIcons'
import { Menu, MenuItem, MenuDivider } from '../components/Menu'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useContextMenu } from '../components/useContextMenu'

export type GroupTabBarProps = {
  /** The group's structural node id — the target for select/close/split/reorder. */
  groupId: string
  /** The group's ordered, mixed editor+terminal tabs (interleaved). */
  tabs: GroupTab[]
  /** The active tab's instanceId, or '' for an empty group. */
  activeTab: string
  /** True when this is the active/open-target group: its tab labels render in the
   *  stronger foreground; inactive groups render dimmer (VSCode group emphasis). */
  isActiveGroup: boolean
  /** Dirty editor tabIds (file path or diff id) — the dirty dot + dirty-close confirm. */
  dirtyTabs: ReadonlySet<string>
  /** Editor tabIds whose file changed on disk — the conflict marker. */
  conflictTabs: ReadonlySet<string>
  /** instanceId → bound session name for terminal tabs (absent ⇒ unbound "Terminal"). */
  terminalBindings: Record<string, string>
  /** Underlying file paths open in 2+ editor tabs tree-wide — dirty-close is loss-free for these. */
  pathsOpenElsewhere: ReadonlySet<string>
  /** Activate a tab in this group (sets the group's active tab + focus). */
  onSelectTab: (instanceId: string) => void
  /** Close a tab in this group (its file / its terminal pane; the session keeps running). */
  onCloseTab: (instanceId: string) => void
  /** Split this group to a sibling on `side`; the new group becomes the open target. */
  onSplit: (side: SplitSide) => void
  /** Reorder a tab within this group to `toIndex` (within-group DnD). */
  onReorderTab: (instanceId: string, toIndex: number) => void
  /** Close this (empty) group — the "Close Group" context item. */
  onCloseGroup: () => void
  /** Focus this (possibly empty) group as the open/close target on a tab-bar click. */
  onActivateGroup: () => void
  /** Discard a file's draft (→ clean) on an explicit dirty-close of its last view. */
  onDiscardDirty: (path: string) => void
  /** The active editor tab's view prefs + setter — renders the right-aligned editor
   *  actions (suggestions sparkle + preview-mode toggle) when an editor tab is active.
   *  Omitted in isolation tests (no editor actions render then). */
  editorPrefs?: { previewMode: PreviewMode; splitDirection: SplitDirection; autocompleteEnabled: boolean }
  onSetEditorPrefs?: (patch: Partial<EditorPrefs>) => void
}

// 28px high bar, matching the editor tab strip the group replaces.
const BAR_STYLE: React.CSSProperties = {
  height: 28, backgroundColor: 'var(--sol-bg)', borderBottom: '1px solid var(--sol-border)',
}

const TAB_STYLE_BASE: React.CSSProperties = {
  borderRight: '1px solid var(--sol-border)',
  marginBottom: -1,
  transition: 'background-color 120ms cubic-bezier(0.2, 0, 0, 1), color 120ms cubic-bezier(0.2, 0, 0, 1)',
}

const SPLIT_BTN_STYLE: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 24, height: 22, padding: 0, border: 'none', borderRadius: 3,
  cursor: 'pointer', background: 'transparent', color: 'var(--sol-text-dim)',
}

// Split U/D/L/R — left/right become a row split, up/down a column split (the
// reducer derives the axis from `side`).
const SPLIT_ITEMS: { label: string; side: SplitSide }[] = [
  { label: 'Split Up', side: 'above' },
  { label: 'Split Down', side: 'below' },
  { label: 'Split Left', side: 'left' },
  { label: 'Split Right', side: 'right' },
]

export function GroupTabBar(props: GroupTabBarProps) {
  const {
    groupId, tabs, activeTab, isActiveGroup, dirtyTabs, conflictTabs, terminalBindings,
    pathsOpenElsewhere, onSelectTab, onCloseTab, onSplit, onReorderTab,
    onCloseGroup, onActivateGroup, onDiscardDirty, editorPrefs, onSetEditorPrefs,
  } = props

  const menu = useContextMenu()
  // Session metadata (terminal provider/icon) and the touch flag are global, not
  // group-scoped — read directly and optionally so the strip still renders in a
  // structural isolation harness that omits the data/env providers.
  const sessions = useContext(WorkspaceDataContext)?.sessions.projectSessions ?? []
  const isTouch = useContext(WorkspaceEnvContext)?.viewport.isTouch ?? false

  const [pendingClose, setPendingClose] = useState<{ instanceId: string; tabId: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  // Disambiguate same-basename files by their shortest unique parent suffix.
  const disambig = useMemo(
    () => computeDisambigSuffixes(tabs.flatMap((t) => (t.kind === 'editor' ? [t.tabId] : []))),
    [tabs],
  )

  // The active editor tab's tabId (null when a terminal tab / empty group is active) —
  // gates the right-aligned editor view controls (FIX 4).
  const activeTabNode = tabs.find((t) => t.instanceId === activeTab)
  const activeEditorTabId = activeTabNode && activeTabNode.kind === 'editor' ? activeTabNode.tabId : null

  // Dirty-close confirm (design: §B): the LAST view of a dirty file prompts before
  // discarding; a file still open in another tab closes immediately (the shared
  // per-path buffer survives there), as does any terminal tab. Dirty/conflict are
  // keyed by the underlying PATH, so a diff tab reflects its file's state too.
  const requestClose = useCallback((tab: GroupTab, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (tab.kind === 'editor') {
      const path = tabIdToPath(tab.tabId)
      if (dirtyTabs.has(path) && !pathsOpenElsewhere.has(path)) {
        setPendingClose({ instanceId: tab.instanceId, tabId: tab.tabId })
        return
      }
    }
    onCloseTab(tab.instanceId)
  }, [dirtyTabs, pathsOpenElsewhere, onCloseTab])

  const onDrop = useCallback((toIndex: number) => (e: React.DragEvent) => {
    e.preventDefault()
    if (dragId) onReorderTab(dragId, toIndex)
    setDragId(null)
  }, [dragId, onReorderTab])

  const chooseSplit = (side: SplitSide) => { onSplit(side); menu.close() }

  return (
    <div className="flex items-center shrink-0" style={BAR_STYLE} data-group-tab-bar={groupId}>
      <div className="flex-1 min-w-0 flex items-center h-full overflow-x-auto">
        {tabs.map((tab, index) => {
          const isActive = tab.instanceId === activeTab
          const isEditor = tab.kind === 'editor'
          const isDirty = isEditor && dirtyTabs.has(tabIdToPath(tab.tabId))
          const isConflict = isEditor && conflictTabs.has(tabIdToPath(tab.tabId))
          const isDiff = isEditor && isDiffTab(tab.tabId)
          const isPreview = !!tab.preview
          const suffix = isEditor ? disambig.get(tab.tabId) : undefined
          const session = !isEditor ? terminalBindings[tab.instanceId] : undefined
          const provider = session ? sessions.find((s) => s.name === session)?.provider : undefined
          const label = isEditor ? tabName(tab.tabId) : (session || 'Terminal')
          const closeLabel = isEditor ? `Close ${tabName(tab.tabId)}` : 'Close terminal'
          // VSCode group emphasis: the active group's labels read in the stronger
          // foreground (its active tab strongest), inactive groups dimmer.
          const labelColor = isActiveGroup
            ? (isActive ? 'var(--sol-text-dark)' : 'var(--sol-text)')
            : (isActive ? 'var(--sol-text)' : 'var(--sol-text-faint)')
          return (
            <div
              key={tab.instanceId}
              data-testid="group-tab"
              data-tab-instance={tab.instanceId}
              data-tab-kind={tab.kind}
              data-tab-active={isActive || undefined}
              draggable={!isTouch}
              onDragStart={() => setDragId(tab.instanceId)}
              onDragOver={(e) => { if (dragId) e.preventDefault() }}
              onDrop={onDrop(index)}
              onDragEnd={() => setDragId(null)}
              onClick={() => onSelectTab(tab.instanceId)}
              title={isEditor ? tab.tabId : label}
              className={`group flex items-center gap-1 px-1.5 h-full cursor-pointer text-ui-sm shrink-0 ${isActiveGroup && isActive ? 'font-medium' : ''}`}
              style={{
                ...TAB_STYLE_BASE,
                backgroundColor: isActive ? 'var(--sol-editor-bg)' : 'var(--sol-bg)',
                color: labelColor,
                borderTop: isActive ? `2px solid ${isConflict || isDiff ? 'var(--sol-warning)' : 'var(--sol-text)'}` : '2px solid transparent',
                borderBottom: isActive ? '1px solid var(--sol-editor-bg)' : '1px solid var(--sol-border)',
                fontStyle: isPreview ? 'italic' : undefined,
                opacity: dragId === tab.instanceId ? 0.4 : undefined,
              }}
            >
              {isEditor
                ? !isDiff && <FileTypeIcon name={tab.tabId} />
                : <ProviderIcon provider={provider ?? 'terminal'} className="w-3.5 h-3.5 shrink-0" />}
              <span className="truncate max-w-[120px]">{label}</span>
              {suffix && <span className="text-ui-xs ml-0.5 shrink-0" style={{ color: 'var(--sol-text-faint)' }}>{suffix}</span>}
              {isConflict ? (
                <span className="w-3 h-3 flex items-center justify-center shrink-0" style={{ color: 'var(--sol-warning)' }} title="File changed on disk"><AlertTriangle size={10} /></span>
              ) : isDirty ? (
                <span className="relative w-3 h-3 flex items-center justify-center shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 group-hover:hidden" style={{ backgroundColor: 'var(--sol-text-dark)' }} />
                  <button onClick={(e) => requestClose(tab, e)}
                    className="hidden group-hover:flex w-3 h-3 items-center justify-center rounded cursor-pointer hover:bg-sol-hover-bg absolute inset-0" style={{ color: 'var(--sol-text-dim)', transition: 'background-color 120ms' }}
                    aria-label={closeLabel}
                  ><X size={10} /></button>
                </span>
              ) : (
                <button onClick={(e) => requestClose(tab, e)}
                  className={`w-3 h-3 flex items-center justify-center rounded cursor-pointer hover:bg-sol-hover-bg ${isTouch ? '' : 'opacity-0 group-hover:opacity-100'}`}
                  style={{ color: 'var(--sol-text-dim)', transition: 'opacity 120ms, background-color 120ms' }}
                  aria-label={closeLabel}
                ><X size={10} /></button>
              )}
            </div>
          )
        })}
        {/* The empty area: a left-click focuses this (possibly empty) group as the
            open/close target; a right-click here opens the same Split menu as the button. */}
        <div className="flex-1 self-stretch flex items-center" style={{ minWidth: 32 }} onClick={onActivateGroup} {...menu.bind()} data-testid="group-empty-area">
          {tabs.length === 0 && <span className="px-3 text-ui-sm shrink-0" style={{ color: 'var(--sol-text)' }}>No files open</span>}
        </div>
      </div>

      <div className="flex items-center shrink-0 gap-1 px-1" style={{ borderLeft: '1px solid var(--sol-border)' }}>
        {activeEditorTabId && editorPrefs && onSetEditorPrefs && (
          <EditorActions
            tabId={activeEditorTabId}
            previewMode={editorPrefs.previewMode}
            splitDirection={editorPrefs.splitDirection}
            autocompleteEnabled={editorPrefs.autocompleteEnabled}
            isTouch={isTouch}
            onSetEditorPrefs={onSetEditorPrefs}
          />
        )}
        <button type="button" onClick={menu.openFromTrigger}
          data-testid="split-group" title="Split editor group" aria-label="Split editor group" aria-haspopup="menu"
          style={SPLIT_BTN_STYLE}>
          <SplitSquareHorizontal size={13} aria-hidden="true" />
        </button>
      </div>

      {menu.position && (
        <Menu position={menu.position} exiting={menu.exiting} armed={menu.armed} focusOnOpen={menu.focusOnOpen} onExitDone={menu.onExitDone}>
          {SPLIT_ITEMS.map(({ label, side }) => (
            <MenuItem key={side} label={label} onClick={() => chooseSplit(side)} />
          ))}
          {tabs.length === 0 && (
            <>
              <MenuDivider />
              <MenuItem label="Close Group" danger onClick={() => { onCloseGroup(); menu.close() }} />
            </>
          )}
        </Menu>
      )}

      {pendingClose && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          description={`${tabName(pendingClose.tabId)} has unsaved changes that will be lost.`}
          confirmLabel="Close Without Saving"
          danger
          onConfirm={() => { onDiscardDirty(tabIdToPath(pendingClose.tabId)); onCloseTab(pendingClose.instanceId) }}
          onClose={() => setPendingClose(null)}
        />
      )}
    </div>
  )
}
