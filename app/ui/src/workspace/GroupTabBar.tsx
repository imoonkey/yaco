// GroupTabBar — the working-area group's mixed editor+terminal tab strip.
//
// SHELL ONLY (owner: vt-render). This file ships the STABLE props contract that
// `vt-group-tabbar` implements against; `PanelGroup` is the sole call site and
// passes exactly these props. The body here is a minimal, non-interactive
// placeholder — no select/close/split menu, no reorder DnD, no `openFromTrigger`.
// `vt-group-tabbar` fills in the strip behavior by editing THIS file's internals
// only, never the `PanelGroup` call site.
//
// Contract notes for the implementer:
//   - `tabs` is the group's ORDERED, MIXED strip (editor + terminal interleaved as
//     the user arranged). Render one tab per entry, branching on `tab.kind`:
//       editor  → file/diff name from `tab.tabId` (reuse `tabName`/`computeDisambig`
//                 from WorkspaceTabBar) + dirty dot (`dirtyTabs.has(tab.tabId)`) +
//                 conflict (`conflictTabs.has(tab.tabId)`) + preview italics
//                 (`tab.preview`).
//       terminal→ provider icon + session name (`terminalBindings[tab.instanceId]`,
//                 or "Terminal" when unbound). Session provider/metadata is read
//                 from `useWorkspaceDataContext().sessions` INSIDE this file (it is
//                 global, not group-scoped — no prop needed).
//   - `activeTab` is the shown tab's instanceId ('' when the group is empty).
//   - callbacks are GROUP-NATIVE and instance-keyed; `PanelGroup` owns the wiring:
//       onSelectTab(instanceId)        — activate that tab (sets active + focus)
//       onCloseTab(instanceId)         — close that tab (the session keeps running)
//       onSplit(side)                  — split this group to an empty sibling
//       onReorderTab(instanceId, idx)  — within-group reorder
//   - `pathsOpenElsewhere` holds the underlying file paths open in OTHER groups, so
//     the dirty-close confirm can be a no-op when the file survives elsewhere.
//   - `isTouch` and session metadata are read from context inside this file.
import type { SplitSide } from './context'
import type { GroupTab } from '../hooks/workspaceTypes'

export type GroupTabBarProps = {
  /** The group's structural node id — the target for select/close/split/reorder. */
  groupId: string
  /** The group's ordered, mixed editor+terminal tabs (interleaved). */
  tabs: GroupTab[]
  /** The active tab's instanceId, or '' for an empty group. */
  activeTab: string
  /** Dirty editor tabIds (file path or diff id) — the dirty dot + dirty-close confirm. */
  dirtyTabs: ReadonlySet<string>
  /** Editor tabIds whose file changed on disk — the conflict marker. */
  conflictTabs: ReadonlySet<string>
  /** instanceId → bound session name for terminal tabs (absent ⇒ unbound "Terminal"). */
  terminalBindings: Record<string, string>
  /** Underlying file paths open in OTHER groups — dirty-close is loss-free for these. */
  pathsOpenElsewhere: ReadonlySet<string>
  /** Activate a tab in this group (sets the group's active tab + focus). */
  onSelectTab: (instanceId: string) => void
  /** Close a tab in this group (its file / its terminal pane; the session keeps running). */
  onCloseTab: (instanceId: string) => void
  /** Split this group to an empty sibling on `side`; the new group becomes the open target. */
  onSplit: (side: SplitSide) => void
  /** Reorder a tab within this group to `toIndex` (within-group DnD). */
  onReorderTab: (instanceId: string, toIndex: number) => void
}

// 28px high bar, matching the editor tab strip the group replaces.
const BAR_STYLE: React.CSSProperties = {
  height: 28, backgroundColor: 'var(--sol-bg)', borderBottom: '1px solid var(--sol-border)',
}

/** A tab's short label for the placeholder strip: an editor tab's file basename,
 *  a terminal tab's bound session name (or "Terminal" when unbound). */
function placeholderLabel(tab: GroupTab, terminalBindings: Record<string, string>): string {
  if (tab.kind === 'terminal') return terminalBindings[tab.instanceId] || 'Terminal'
  return tab.tabId.split('/').pop() || tab.tabId
}

export function GroupTabBar(props: GroupTabBarProps) {
  const { groupId, tabs, activeTab, terminalBindings } = props
  return (
    <div className="flex items-center shrink-0 overflow-x-auto" style={BAR_STYLE} data-group-tab-bar={groupId}>
      {tabs.length === 0 ? (
        <span className="px-3 text-ui-sm shrink-0" style={{ color: 'var(--sol-text)' }}>No files open</span>
      ) : tabs.map((tab) => (
        <span
          key={tab.instanceId}
          data-tab-instance={tab.instanceId}
          data-tab-kind={tab.kind}
          data-tab-active={tab.instanceId === activeTab || undefined}
          className="px-2 h-full flex items-center text-ui-sm shrink-0"
          style={{
            borderRight: '1px solid var(--sol-border)',
            color: tab.instanceId === activeTab ? 'var(--sol-text-dark)' : 'var(--sol-text)',
          }}
        >
          {placeholderLabel(tab, terminalBindings)}
        </span>
      ))}
    </div>
  )
}
