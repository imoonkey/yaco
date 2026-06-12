// PanelGroup — renders one working-area group (a `tabs` node) as a VSCode-style
// tab group: a `GroupTabBar` over the active tab's body. Owner: vt-render (full
// ownership stays here — the typed contract, the command wiring, the landmark +
// marker placement, the active-tab body wrapper and its `data-*`).
//
// The group container carries `data-group-id` and, for the FIRST group, the
// `role="main"` landmark. The active tab's body wrapper carries `data-instance-id`
// + `data-panel-leaf="<kind>"` (so the geometry probe + focus markers resolve) and
// the bright/dim focus border from `paneMarker`. An EMPTY group renders the tab bar
// with NO body wrapper — a valid render state, not a crash.
//
// The body is mounted through `PanelHost` (which publishes the per-instance
// `PanelInstanceContext`); the editor/terminal bodies read their `instanceId` from
// that context and resolve their own payload from the tree (`tabByInstance`) — they
// never read the tab bar. So `vt-bodies` renders against the instance context only.
//
// Command wiring goes through the PUBLIC command surface (`useWorkspaceCommands`):
// select/close/split are fully wired; within-group reorder needs a group-native
// `reorderGroupTab` on the command surface (not exposed to render yet) and is inert
// until vt-group-tabbar + the command surface land it.
import { useCallback, useMemo, type CSSProperties } from 'react'
import { PanelHost } from './PanelHost'
import { GroupTabBar } from './GroupTabBar'
import {
  useWorkspaceSelection, useWorkspaceCommands, useWorkspaceLayout,
  type PanelId, type SplitSide,
} from './context'
import type { PaneMarker } from './panelInstance'
import { editorInstancesInOrder, groupOf, tabIdToPath } from './panelLayoutModel'
import { editorTabByInstance } from '../hooks/useLayoutState'
import type { TabsNode } from '../hooks/workspaceTypes'

// Marker colors: bright accent for the focused pane, a dimmed accent for the
// active-but-unfocused instance (design: §D). Mirrors the editor/terminal pane
// border the multi-instance renderer used.
const FOCUS_ACCENT = 'var(--sol-accent)'
const ACTIVE_ACCENT = 'color-mix(in srgb, var(--sol-accent) 40%, transparent)'

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
  const tree = useWorkspaceLayout().panelLayout.desktop

  // Underlying file paths open in OTHER groups: closing a dirty tab here is
  // loss-free when the file still shows elsewhere (shared per-path buffer), so the
  // tab bar's dirty-close confirm no-ops for these.
  const pathsOpenElsewhere = useMemo(() => {
    const set = new Set<string>()
    for (const id of editorInstancesInOrder(tree)) {
      if (groupOf(tree, id) === group.id) continue
      const t = editorTabByInstance(tree, id)
      if (t) set.add(tabIdToPath(t.tabId))
    }
    return set
  }, [tree, group.id])

  // Group-native callbacks, wired onto the public command surface. `selectTab`/
  // `closePane` are keyed by instanceId and work for both editor and terminal tabs.
  const onSelectTab = useCallback((instanceId: string) => {
    const t = group.tabs.find((x) => x.instanceId === instanceId)
    commands.selectTab(t && t.kind === 'editor' ? t.tabId : '', instanceId)
  }, [commands, group.tabs])

  const onCloseTab = useCallback((instanceId: string) => {
    commands.closePane(instanceId)
  }, [commands])

  // Split this group to an empty sibling. The public surface resolves the split
  // source from a tab instance, so reference the active (or first) tab; the new
  // empty group becomes the open target via the reducer's `activeGroupId`.
  const onSplit = useCallback((side: SplitSide) => {
    commands.splitEditor(group.activeTab || group.tabs[0]?.instanceId || '', side)
  }, [commands, group.activeTab, group.tabs])

  // Within-group reorder is a pure tree edit (REORDER_GROUP_TAB); it needs a
  // group-native command on the public surface, which the render layer cannot reach
  // yet. vt-group-tabbar wires the DnD against this prop; inert until the command
  // surface exposes `reorderGroupTab`.
  const onReorderTab = useCallback((_instanceId: string, _toIndex: number) => {}, [])

  const activeTabNode = group.tabs.find((t) => t.instanceId === group.activeTab) ?? null
  const marker = activeTabNode ? markerFor(activeTabNode.kind, activeTabNode.instanceId) : null
  // Reserve a 2px top border (transparent when unmarked) so the marker never shifts
  // layout (box-sizing: border-box).
  const borderTop = `2px solid ${marker?.focused ? FOCUS_ACCENT : marker?.active ? ACTIVE_ACCENT : 'transparent'}`

  return (
    <div
      data-group-id={group.id}
      role={isMain ? 'main' : undefined}
      style={sizing}
      className="flex flex-col min-w-0 min-h-0"
    >
      <GroupTabBar
        groupId={group.id}
        tabs={group.tabs}
        activeTab={group.activeTab}
        dirtyTabs={selection.editor.dirtyTabs}
        conflictTabs={selection.editor.conflictTabs}
        terminalBindings={selection.terminalBindings}
        pathsOpenElsewhere={pathsOpenElsewhere}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onSplit={onSplit}
        onReorderTab={onReorderTab}
      />
      {activeTabNode && (
        <div
          data-instance-id={activeTabNode.instanceId}
          data-panel-leaf={activeTabNode.kind}
          data-focused={marker?.focused || undefined}
          data-active={marker?.active || undefined}
          style={{ borderTop }}
          className="flex flex-col flex-1 min-w-0 min-h-0"
        >
          <PanelHost id={activeTabNode.kind} instanceId={activeTabNode.instanceId} />
        </div>
      )}
    </div>
  )
}
