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
// The body is mounted through `PanelHost` (which publishes the per-instance
// `PanelInstanceContext`); the editor/terminal bodies read their `instanceId` from
// that context and resolve their own payload from the tree (`tabByInstance`) — they
// never read the tab bar. So `vt-bodies` renders against the instance context only.
//
// Command wiring goes through the PUBLIC command surface (`useWorkspaceCommands`):
// select/close, the group-native `splitGroup`/`reorderGroupTab`/`closeGroup`/
// `setActiveGroup`, the editor view-pref toggles (`setEditorPrefs`), and the dirty-
// close draft discard (`acceptDisk`) are all wired here and handed to the tab bar.
import { useCallback, useMemo, type CSSProperties } from 'react'
import { PanelHost } from './PanelHost'
import { GroupTabBar } from './GroupTabBar'
import {
  useWorkspaceSelection, useWorkspaceCommands, useWorkspaceLayout,
  type PanelId, type SplitSide,
} from './context'
import type { PaneMarker } from './panelInstance'
import { editorInstancesInOrder, tabIdToPath } from './panelLayoutModel'
import { editorTabByInstance } from '../hooks/useLayoutState'
import type { TabsNode } from '../hooks/workspaceTypes'

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

export function PanelGroup({ group, sizing, isMain, markerFor }: PanelGroupProps) {
  const selection = useWorkspaceSelection()
  const commands = useWorkspaceCommands()
  const { layout, panelLayout } = useWorkspaceLayout()
  const tree = panelLayout.desktop
  const isActiveGroup = selection.activeGroupId === group.id

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

  // Within-group reorder — a pure tree edit (REORDER_GROUP_TAB) the tab bar's DnD
  // drives by group id.
  const onReorderTab = useCallback((instanceId: string, toIndex: number) => {
    commands.reorderGroupTab(group.id, instanceId, toIndex)
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

  const activeTabNode = group.tabs.find((t) => t.instanceId === group.activeTab) ?? null
  const marker = activeTabNode ? markerFor(activeTabNode.kind, activeTabNode.instanceId) : null

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
        tabs={group.tabs}
        activeTab={group.activeTab}
        isActiveGroup={isActiveGroup}
        dirtyTabs={selection.editor.dirtyTabs}
        conflictTabs={selection.editor.conflictTabs}
        terminalBindings={selection.terminalBindings}
        pathsOpenElsewhere={pathsOpenElsewhere}
        editorPrefs={{
          previewMode: layout.previewMode,
          splitDirection: layout.splitDirection,
          autocompleteEnabled: layout.autocompleteEnabled,
        }}
        onSetEditorPrefs={commands.setEditorPrefs}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onSplit={onSplit}
        onReorderTab={onReorderTab}
        onCloseGroup={onCloseGroup}
        onActivateGroup={onActivateGroup}
        onDiscardDirty={onDiscardDirty}
      />
      {activeTabNode && (
        <div
          data-instance-id={activeTabNode.instanceId}
          data-panel-leaf={activeTabNode.kind}
          data-focused={marker?.focused || undefined}
          data-active={marker?.active || undefined}
          className="flex flex-col flex-1 min-w-0 min-h-0"
        >
          <PanelHost id={activeTabNode.kind} instanceId={activeTabNode.instanceId} />
        </div>
      )}
    </div>
  )
}
