// GroupTabBar — the working-area group's mixed editor+terminal tab strip.
//
// One flat, freely-orderable strip per group: each open file is its own editor
// tab (file/diff name from its `tabId` + dirty/conflict markers + disambiguation),
// each terminal its own tab (provider icon + bound session name, or "Terminal"
// when unbound). Selecting a tab activates it; each tab carries a close ×.
//
// The split affordance has direct right/down icon buttons. The shared Split menu
// stays available from right-click / long-press on those icons, plus the tab-bar
// empty area and tab title context routes. Within-group drag reorders tabs.
//
// Group-native callbacks are wired by `PanelGroup`; session metadata + `isTouch`
// are read from context here, and `useContextMenu` is instantiated internally.
import { Fragment, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { X, AlertTriangle, Columns2, Rows2, FileDiff } from 'lucide-react'
import { isDiffTab, isFileTab } from '../hooks/useWorkspaceState'
import { WorkspaceDataContext, WorkspaceEnvContext, WorkspaceLayoutContext, WorkspaceCommandsContext, type GroupPlacement, type SplitSide, type EditorPrefs } from './context'
import type { GroupTab, PreviewMode, SplitDirection } from '../hooks/workspaceTypes'
import { tabIdToPath } from './panelLayoutModel'
import { tabName, computeDisambigSuffixes, tabCloseLabel } from './tabLabels'
import { EditorActions } from './EditorActions'
import { FileTypeIcon } from '../components/fileExplorerIcons'
import { ProviderIcon } from '../components/SessionIcons'
import { Menu, MenuItem, MenuDivider } from '../components/Menu'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useContextMenu } from '../components/useContextMenu'
import { useDrag, useDragControls, isPaneDrag } from './WorkspaceDragContext'
import { tabInsertIndex, legalZones, type Rect, type Region } from './dndGeometry'
import { InsertionMarker } from './InsertionMarker'

export type GroupTabBarProps = {
  /** The group's structural node id — the target for select/close/split/move. */
  groupId: string
  /** The group's enforced region. The split affordance is offered only in `center`
   *  (a split on a sidebar group would just merge), and the tab-bar drop legality
   *  (`legalZones` on the `group` target) is region-scoped. */
  region: Region
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
  /** Move a tab into this group at `toIndex` (the universal tab mover — covers both a
   *  cross-group move and the within-group reorder, the from===to case). */
  onMoveTab: (fromGroupId: string, instanceId: string, toGroupId: string, toIndex: number) => void
  /** Pin this group's tab by instance id (clears preview). */
  onPinTab: (instanceId: string) => void
  /** Relocate a whole dragged group (beside a node, or merged into a group). The tab
   *  bar drops a group as a MERGE into this group. */
  onMoveGroup: (groupId: string, placement: GroupPlacement) => void
  /** Close this (empty) group — the "Close Group" context item. */
  onCloseGroup: () => void
  /** True when this group may be removed (more than one group exists) — gates the
   *  visible Close Group button on an empty group. The last group is never closable
   *  (it stays as the one empty working area). */
  canCloseGroup?: boolean
  /** Focus this (possibly empty) group as the open/close target on a tab-bar click. */
  onActivateGroup: () => void
  /** Discard a file's draft (→ clean) on an explicit dirty-close of its last view. */
  onDiscardDirty: (path: string) => void
  /** Save an editor file tab by tab id. No-op for diff/terminal tabs. */
  onSaveTab?: (tabId: string) => void
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
  width: 22, height: 22, padding: 0, border: 'none', borderRadius: 3,
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
    groupId, region, tabs, activeTab, isActiveGroup, dirtyTabs, conflictTabs, terminalBindings,
    pathsOpenElsewhere, onSelectTab, onCloseTab, onSplit, onMoveTab, onPinTab, onMoveGroup,
    onCloseGroup, canCloseGroup, onActivateGroup, onDiscardDirty, onSaveTab, editorPrefs, onSetEditorPrefs,
  } = props

  const menu = useContextMenu()
  // Source + drop handlers use the NON-subscribing controls so a tab/group dragstart
  // never re-renders this bar synchronously (which would abort the native drag); the
  // reactive `payload` (drag feedback: dimming, merge hint) is read separately and
  // only re-renders AFTER the drag has committed.
  const dragControls = useDragControls()
  const dragPayload = useDrag().payload
  const stripRef = useRef<HTMLDivElement>(null)
  // Drag feedback over the strip: the insertion index for a tab drop (the marker), and
  // a merge hint while a whole group hovers (its tabs would append here).
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [mergeHint, setMergeHint] = useState(false)
  // The split affordance is center-only; the right sidebar group can hold one group but
  // a "split" there would just merge, so it is not offered. An empty group still needs
  // its menu for Close Group, so bind/render the menu when there is something to show.
  const canSplit = region === 'center'
  const showMenu = canSplit || tabs.length === 0
  // Session metadata (terminal provider/icon) and the touch flag are global, not
  // group-scoped — read directly and optionally so the strip still renders in a
  // structural isolation harness that omits the data/env providers.
  const sessions = useContext(WorkspaceDataContext)?.sessions.projectSessions ?? []
  const isTouch = useContext(WorkspaceEnvContext)?.viewport.isTouch ?? false
  // Kind-routing toggle (design: separateKinds) — read the flag + command optionally so
  // the strip still renders in a structural isolation harness that omits the providers.
  const separateKinds = useContext(WorkspaceLayoutContext)?.panelLayout?.panelState?.separateKinds ?? false
  const toggleSeparateKinds = useContext(WorkspaceCommandsContext)?.toggleSeparateKinds

  const [pendingClose, setPendingClose] = useState<{ instanceId: string; tabId: string } | null>(null)
  const [contextTab, setContextTab] = useState<GroupTab | null>(null)

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

  const closeWithoutSaving = useCallback((tab: GroupTab) => {
    if (tab.kind === 'editor') onDiscardDirty(tabIdToPath(tab.tabId))
    onCloseTab(tab.instanceId)
  }, [onCloseTab, onDiscardDirty])

  // The tab strip is ONE drop target (not per-tab): the insertion index comes from the
  // pointer vs the live tab midpoints (`tabInsertIndex`), so a marker can show exactly
  // where the tab lands. A drop is accepted only with BOTH a live payload AND our pane
  // mime, and only when `legalZones` allows it on this region's `group` target (a tab →
  // {tab}, a group → {center: merge}; both empty outside the center). A tab move is the
  // universal mover (cross-group AND the from===to within-group reorder); a group is a
  // merge into this group.
  const measureTabs = useCallback((): Rect[] => {
    const root = stripRef.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('[data-testid="group-tab"]')).map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    })
  }, [])

  const clearDropFeedback = () => { setDropIndex(null); setMergeHint(false) }

  const onStripDragOver = useCallback((e: React.DragEvent) => {
    const payload = dragControls.peek()
    if (!payload || !isPaneDrag(e)) return
    const zones = legalZones({ kind: payload.kind }, { region, kind: 'group' })
    if (payload.kind === 'tab' && zones.has('tab')) {
      e.preventDefault()
      setDropIndex(tabInsertIndex(measureTabs(), e.clientX))
      setMergeHint(false)
    } else if (payload.kind === 'group' && zones.has('center')) {
      e.preventDefault()
      setMergeHint(payload.groupId !== groupId)
      setDropIndex(null)
    } else {
      clearDropFeedback() // illegal — render no feedback, leave the drop rejected
    }
  }, [dragControls, region, groupId, measureTabs])

  const onStripDragLeave = useCallback((e: React.DragEvent) => {
    if (!stripRef.current?.contains(e.relatedTarget as Node | null)) clearDropFeedback()
  }, [])

  const onStripDrop = useCallback((e: React.DragEvent) => {
    const payload = dragControls.peek()
    clearDropFeedback()
    if (!payload || !isPaneDrag(e)) return
    const zones = legalZones({ kind: payload.kind }, { region, kind: 'group' })
    if (payload.kind === 'tab' && zones.has('tab')) {
      e.preventDefault()
      const rawIndex = tabInsertIndex(measureTabs(), e.clientX)
      // MOVE_TAB removes the source tab BEFORE inserting at toIndex, so a SAME-group
      // rightward move (source sits left of the visual insertion point) must target one
      // slot earlier or it lands one too far. Cross-group moves are unaffected.
      const fromIndex = tabs.findIndex((t) => t.instanceId === payload.instanceId)
      const sameGroupRightward = payload.fromGroupId === groupId && fromIndex !== -1 && fromIndex < rawIndex
      onMoveTab(payload.fromGroupId, payload.instanceId, groupId, sameGroupRightward ? rawIndex - 1 : rawIndex)
    } else if (payload.kind === 'group' && zones.has('center')) {
      e.preventDefault()
      if (payload.groupId !== groupId) onMoveGroup(payload.groupId, { kind: 'merge', targetGroupId: groupId })
    }
    dragControls.clear()
  }, [dragControls, region, groupId, tabs, measureTabs, onMoveTab, onMoveGroup])

  const chooseSplit = (side: SplitSide) => { onSplit(side); menu.close() }

  // Feedback shows only while a drag is live; a drag that ends anywhere (drop/cancel)
  // flips the reactive payload to null and re-renders, clearing the marker/hint without
  // a cleanup effect.
  const dragging = !!dragPayload
  const showMarkerAt = (i: number) => dragging && dropIndex === i
  const splitMenuHandlers = menu.bind(() => setContextTab(null))

  return (
    <div className="flex items-center shrink-0" style={BAR_STYLE} data-group-tab-bar={groupId}>
      <div
        ref={stripRef}
        className="flex-1 min-w-0 flex items-center h-full overflow-x-auto"
        style={{ backgroundColor: dragging && mergeHint ? 'color-mix(in srgb, var(--sol-accent) 12%, transparent)' : undefined }}
        onDragOver={onStripDragOver}
        onDragLeave={onStripDragLeave}
        onDrop={onStripDrop}
      >
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
          const closeLabel = isEditor ? tabCloseLabel(tab.tabId) : 'Close terminal'
          // VSCode group emphasis (FIX C): the ACTIVE group reads in a strong
          // foreground at medium weight (its active tab strongest, the rest standard);
          // INACTIVE groups are uniformly muted in a distinctly fainter token — so it
          // is obvious at a glance which group is active.
          const labelColor = isActiveGroup
            ? (isActive ? 'var(--sol-text-dark)' : 'var(--sol-text)')
            : 'var(--sol-text-faint)'
          return (
            <Fragment key={tab.instanceId}>
              {showMarkerAt(index) && <InsertionMarker />}
              <div
                data-testid="group-tab"
                data-tab-instance={tab.instanceId}
                data-tab-kind={tab.kind}
                data-tab-active={isActive || undefined}
                draggable={!isTouch}
                onDragStart={(e) => dragControls.start(e, { kind: 'tab', fromGroupId: groupId, instanceId: tab.instanceId, tabKind: tab.kind })}
                onDragEnd={dragControls.clear}
                onClick={() => onSelectTab(tab.instanceId)}
                onDoubleClick={() => { if (tab.preview) onPinTab(tab.instanceId) }}
                {...(showMenu ? menu.bind(() => setContextTab(tab)) : {})}
                title={isEditor ? tab.tabId : label}
                className={`group flex items-center gap-1 px-1.5 h-full cursor-pointer text-ui-sm shrink-0 ${isActiveGroup ? 'font-medium' : ''}`}
                style={{
                  ...TAB_STYLE_BASE,
                  backgroundColor: isActive ? 'var(--sol-editor-bg)' : 'var(--sol-bg)',
                  color: labelColor,
                  borderTop: isActive ? `2px solid ${isConflict || isDiff ? 'var(--sol-warning)' : 'var(--sol-text)'}` : '2px solid transparent',
                  borderBottom: isActive ? '1px solid var(--sol-editor-bg)' : '1px solid var(--sol-border)',
                  fontStyle: isPreview ? 'italic' : undefined,
                  opacity: dragPayload?.kind === 'tab' && dragPayload.instanceId === tab.instanceId ? 0.4 : undefined,
                }}
              >
                {isEditor
                  ? (isDiff
                      ? <FileDiff size={13} aria-hidden="true" className="shrink-0" />
                      : <FileTypeIcon name={tab.tabId} />)
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
            </Fragment>
          )
        })}
        {showMarkerAt(tabs.length) && <InsertionMarker />}
        {/* The empty/background area is the WHOLE-GROUP drag source (mirrors VSCode
            "drag the tabs container") — distinct from a tab drag because tabs are
            sibling elements, so a tab dragstart never originates here. A left-click
            still focuses this group; a right-click opens the same Split menu. */}
        <div className="flex-1 self-stretch flex items-center" style={{ minWidth: 32 }}
          draggable={!isTouch}
          onDragStart={(e) => dragControls.start(e, { kind: 'group', groupId })}
          onDragEnd={dragControls.clear}
          onClick={onActivateGroup} {...(showMenu ? menu.bind(() => setContextTab(null)) : {})} data-testid="group-empty-area">
          {tabs.length === 0 && <span className="px-3 text-ui-sm shrink-0" style={{ color: 'var(--sol-text)' }}>No files open</span>}
        </div>
      </div>

      <div className="flex items-center shrink-0 gap-0.5 px-0.5" style={{ borderLeft: '1px solid var(--sol-border)' }}>
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
        {canSplit && (
          <button type="button" onClick={() => onSplit('right')} {...splitMenuHandlers}
            data-testid="split-group-right" title="Split group right" aria-label="Split group right" aria-haspopup="menu"
            style={SPLIT_BTN_STYLE}>
            <Columns2 size={13} aria-hidden="true" />
          </button>
        )}
        {canSplit && (
          <button type="button" onClick={() => onSplit('below')} {...splitMenuHandlers}
            data-testid="split-group-down" title="Split group down" aria-label="Split group down" aria-haspopup="menu"
            style={SPLIT_BTN_STYLE}>
            <Rows2 size={13} aria-hidden="true" />
          </button>
        )}
        {/* An empty group offers a VISIBLE Close Group button (FIX B) so the source
            group left behind by a terminal split-move is obviously closable — not
            only via the right-click menu. The last group is never closable. */}
        {tabs.length === 0 && canCloseGroup && (
          <button type="button" onClick={onCloseGroup}
            data-testid="close-group" title="Close group" aria-label="Close group"
            style={SPLIT_BTN_STYLE}>
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {showMenu && menu.position && (
        <Menu position={menu.position} exiting={menu.exiting} armed={menu.armed} focusOnOpen={menu.focusOnOpen} onExitDone={menu.onExitDone}>
          {contextTab && contextTab.kind === 'editor' && isFileTab(contextTab.tabId) && dirtyTabs.has(tabIdToPath(contextTab.tabId)) && onSaveTab && (
            <MenuItem label="Save" onClick={() => { onSaveTab(contextTab.tabId); menu.close() }} />
          )}
          {contextTab && (
            contextTab.kind === 'editor' && dirtyTabs.has(tabIdToPath(contextTab.tabId))
              ? <MenuItem label="Close Without Saving" danger onClick={() => { closeWithoutSaving(contextTab); menu.close() }} />
              : <MenuItem label={contextTab.kind === 'terminal' ? 'Close Terminal' : 'Close'} onClick={() => { onCloseTab(contextTab.instanceId); menu.close() }} />
          )}
          {contextTab && canSplit && <MenuDivider />}
          {canSplit && SPLIT_ITEMS.map(({ label, side }) => (
            <MenuItem key={side} label={label} onClick={() => chooseSplit(side)} />
          ))}
          {canSplit && (
            <>
              <MenuDivider />
              {/* A checkbox toggle: it stays open so the check flip is visible. */}
              <MenuItem
                label="Separate editors and terminals"
                checked={separateKinds}
                onClick={() => toggleSeparateKinds?.()}
              />
            </>
          )}
          {tabs.length === 0 && (
            <>
              {canSplit && <MenuDivider />}
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
