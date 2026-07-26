// PanelGroup — renders one working-area group (a `tabs` node) as a VSCode-style
// tab group: a `GroupTabBar` over the active tab's body. Owner: vt-render (full
// ownership stays here — the typed contract, the command wiring, the landmark +
// marker placement, the active-tab body wrapper and its `data-*`).
//
// The group container carries `data-group-id`, `data-group-active` (the active/
// open-target group), and, for the FIRST group, the `role="main"` landmark. The
// active tab's body wrapper carries `data-instance-id` + `data-panel-leaf="<kind>"`
// (so the geometry probe + focus tracking resolve) and `data-focused`/`data-active`
// from `paneMarker`. The GROUP-level active/inactive distinction is rendered as tab-
// label text emphasis in `GroupTabBar` (VSCode-style), not a coloured pane border.
// An EMPTY group renders the tab bar with NO body wrapper — a valid render state.
//
// The active tab is not the only MOUNTED one: recently visited terminal tabs stay
// mounted and hidden (`mountedTabs`), because a terminal body owns an xterm and a
// WebSocket attached to a tmux client — re-creating those is the entire cost of
// switching back. A hidden body is laid out at full size but `invisible`, is out of
// the focus/a11y trees, and carries NONE of the pane markers, so exactly one leaf per
// group stays resolvable.
//
// The body is mounted through `PanelHost` (which publishes the per-instance
// `PanelInstanceContext`); the editor/terminal bodies read their `instanceId` from
// that context and resolve their own payload from the tree (`tabByInstance`) — they
// never read the tab bar. So `vt-bodies` renders against the instance context only.
//
// Command wiring goes through the PUBLIC command surface (`useWorkspaceCommands`):
// select/close, the group-native `splitGroup`/`reorderGroupTab`/`closeGroup`/
// `setActiveGroup`, the editor view-pref toggles (`setEditorPrefs`), and the dirty-
// close draft discard (`acceptDisk`) are all wired here and handed to the tab bar.
import { useCallback, useMemo, useState, type CSSProperties } from 'react'
import { PanelHost } from './PanelHost'
import { GroupTabBar } from './GroupTabBar'
import { DropOverlay } from './DropOverlay'
import {
  useWorkspaceSelection, useWorkspaceCommands, useWorkspaceLayout,
  type PanelId, type SplitSide,
} from './context'
import type { PaneMarker } from './panelInstance'
import { collectIds, editorInstancesInOrder, editorTabView, groupCount, mountedTabs, regionsOf, tabIdToPath } from './panelLayoutModel'
import { editorTabByInstance } from '../hooks/useLayoutState'
import type { LayoutNode, TabsNode } from '../hooks/workspaceTypes'
import type { Region } from './dndGeometry'

export type PanelGroupProps = {
  /** The group (tabs) node to render. */
  group: TabsNode
  /** Flex sizing handed down from the parent split. */
  sizing: CSSProperties
  /** True for the first group in document order — carries `role="main"`. */
  isMain: boolean
  /** Focus/active marker for an editor/terminal pane (suppressed when single). */
  markerFor: (type: PanelId, instanceId: string) => PaneMarker
}

// How many bodies one group keeps mounted: the active tab plus its keep-alive
// terminals. Each kept terminal holds a tmux client + a PTY on the server, which
// the capacity guard budgets in the hundreds — this bounds a pathological group,
// it is not a tuning knob.
const MAX_MOUNTED_BODIES = 6

export function PanelGroup({ group, sizing, isMain, markerFor }: PanelGroupProps) {
  const selection = useWorkspaceSelection()
  const commands = useWorkspaceCommands()
  const { layout, panelLayout } = useWorkspaceLayout()
  const tree = panelLayout.desktop
  const isActiveGroup = selection.activeGroupId === group.id
  // An empty group can be closed only when it is not the last working group
  // (ensureFirstGroup keeps >=1) — gates the visible Close Group affordance.
  const canCloseGroup = groupCount(tree) > 1

  // The enforced region this group lives in (left = docks only; center = the grid;
  // right = the single sidebar group). DnD legality + the split-affordance gate are
  // region-scoped: a non-center group never splits (it would just merge) and its body
  // is not a drop target.
  const region = useMemo<Region>(() => {
    const regions = regionsOf(tree)
    const inNode = (n: LayoutNode | null) => !!n && collectIds(n).has(group.id)
    return inNode(regions.left) ? 'left' : inNode(regions.right) ? 'right' : 'center'
  }, [tree, group.id])

  // Underlying file paths open in 2+ editor tabs tree-wide: closing one view of a
  // dirty file is loss-free while another tab still holds the shared per-path
  // buffer — including a same-group file+diff pair — so the tab bar's dirty-close
  // confirm no-ops for these.
  const pathsOpenElsewhere = useMemo(() => {
    const counts = new Map<string, number>()
    for (const id of editorInstancesInOrder(tree)) {
      const t = editorTabByInstance(tree, id)
      if (!t) continue
      const path = tabIdToPath(t.tabId)
      counts.set(path, (counts.get(path) ?? 0) + 1)
    }
    const set = new Set<string>()
    for (const [path, n] of counts) if (n > 1) set.add(path)
    return set
  }, [tree])

  // Group-native callbacks, wired onto the public command surface. `selectTab`/
  // `closePane` are keyed by instanceId and work for both editor and terminal tabs.
  const onSelectTab = useCallback((instanceId: string) => {
    const t = group.tabs.find((x) => x.instanceId === instanceId)
    commands.selectTab(t && t.kind === 'editor' ? t.tabId : '', instanceId)
  }, [commands, group.tabs])

  const onCloseTab = useCallback((instanceId: string) => {
    commands.closePane(instanceId)
  }, [commands])

  // Split this group to an empty sibling. Group-native: it targets the group id
  // directly, so it works even when the group has no tabs (the new empty group
  // becomes the open target via the reducer's `activeGroupId`).
  const onSplit = useCallback((side: SplitSide) => {
    commands.splitGroup(group.id, side)
  }, [commands, group.id])

  // Close an EMPTY split-created group (the tab-bar "Close Group" context item).
  const onCloseGroup = useCallback(() => {
    commands.closeGroup(group.id)
  }, [commands, group.id])

  // Focus this (possibly empty) group as the open/close target on a tab-bar click,
  // so Cmd+W / Close Group act on it.
  const onActivateGroup = useCallback(() => {
    commands.setActiveGroup(group.id)
  }, [commands, group.id])

  // Discard a file's draft (→ clean) on an explicit dirty-close of its last view,
  // so the shared-buffer GC drops it instead of resurrecting the edit.
  const onDiscardDirty = useCallback((path: string) => {
    commands.acceptDisk(path)
  }, [commands])

  // Save a tab's live content. Reads `filesRef.current` (the draft updates every
  // keystroke) inside the handler, so PanelGroup never subscribes to the
  // per-keystroke buffers context — it must not re-render on a keystroke.
  const onSaveTab = useCallback((tabId: string) => {
    const path = tabIdToPath(tabId)
    const file = commands.actions.filesRef.current[path]
    if (!file) return
    void commands.saveFile(path, file.draft ?? file.serverContent ?? '')
  }, [commands])

  // Visit order of this group's tabs, most recent first — what decides which kept
  // terminal is dropped at the cap. Adjusted during render (the head IS the active
  // tab) rather than in an effect, so the mounted set never lags a switch by a frame.
  const [visitOrder, setVisitOrder] = useState<string[]>([group.activeTab])
  if (visitOrder[0] !== group.activeTab) {
    setVisitOrder([group.activeTab, ...visitOrder.filter((id) => id !== group.activeTab)])
  }
  const mounted = mountedTabs(group.tabs, group.activeTab, visitOrder, MAX_MOUNTED_BODIES)

  const activeTabNode = group.tabs.find((t) => t.instanceId === group.activeTab) ?? null
  const marker = activeTabNode ? markerFor(activeTabNode.kind, activeTabNode.instanceId) : null
  // The editor view shown in the tab bar's actions is the ACTIVE editor tab's own
  // per-tab view; its setter targets that instance. Autocomplete is global.
  const activeEditorTab = activeTabNode?.kind === 'editor' ? activeTabNode : null
  const activeView = editorTabView(activeEditorTab)

  return (
    <div
      data-group-id={group.id}
      data-group-active={isActiveGroup || undefined}
      role={isMain ? 'main' : undefined}
      style={sizing}
      className="flex flex-col min-w-0 min-h-0"
    >
      <GroupTabBar
        groupId={group.id}
        region={region}
        tabs={group.tabs}
        activeTab={group.activeTab}
        isActiveGroup={isActiveGroup}
        terminalBindings={selection.terminalBindings}
        pathsOpenElsewhere={pathsOpenElsewhere}
        editorPrefs={{
          previewMode: activeView.previewMode,
          splitDirection: activeView.splitDirection,
          autocompleteEnabled: layout.autocompleteEnabled,
        }}
        onSetView={(patch) => { if (activeEditorTab) commands.setTabView(activeEditorTab.instanceId, patch) }}
        onSetAutocomplete={commands.setAutocomplete}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onSplit={onSplit}
        onMoveTab={commands.moveTab}
        onPinTab={commands.pinTab}
        onMoveGroup={commands.moveGroup}
        onCloseGroup={onCloseGroup}
        canCloseGroup={canCloseGroup}
        onActivateGroup={onActivateGroup}
        onDiscardDirty={onDiscardDirty}
        onSaveTab={onSaveTab}
      />
      <DropOverlay
        groupId={group.id}
        region={region}
        tabCount={group.tabs.length}
        onMoveTab={commands.moveTab}
        onMoveTabToSplit={commands.moveTabToSplit}
        onMoveGroup={commands.moveGroup}
      >
        {mounted.map((tab) => {
          const isActive = tab.instanceId === group.activeTab
          // A kept-but-hidden body stays laid out at the body's full size —
          // `visibility` (not `display`), so xterm's cell measurement stays valid and
          // re-showing it needs no refit. `inert` is what makes it unreachable:
          // Chromium keeps a focused descendant focused (and keeps delivering
          // keydown to it) when an ancestor merely turns invisible, so without it a
          // switch to a body that claims no focus — the tasks tab, an empty group —
          // would leave the hidden terminal taking the user's keystrokes. It also
          // carries none of the pane markers: the geometry probe, focus tracking and
          // the split affordances must still resolve exactly ONE leaf per group.
          return (
            <div
              key={tab.instanceId}
              data-instance-id={isActive ? tab.instanceId : undefined}
              data-panel-leaf={isActive ? tab.kind : undefined}
              data-focused={(isActive && marker?.focused) || undefined}
              data-active={(isActive && marker?.active) || undefined}
              inert={!isActive}
              className={isActive
                ? 'flex flex-col flex-1 min-w-0 min-h-0'
                : 'absolute inset-0 flex flex-col invisible'}
            >
              <PanelHost id={tab.kind} instanceId={tab.instanceId} visible={isActive} />
            </div>
          )
        })}
      </DropOverlay>
    </div>
  )
}
