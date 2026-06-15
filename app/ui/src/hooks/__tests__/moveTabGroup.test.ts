// Unit tests for the MOVE_TAB / MOVE_GROUP reducer actions (the universal tab mover
// + the whole-group mover). The reducer is pure, so these run without React. They
// pin: same-group reorder, cross-group editor/terminal moves with identity (terminal
// binding) preserved, focus/MRU/activeGroupId updates, preview-travel into clean vs
// dirty-protected targets, center-scoped vs sidebar empty-source handling, and the
// MOVE_GROUP beside/merge/self-drop cases.
import { describe, it, expect } from 'vitest'
import { instanceReducer, buildInstanceState, type InstanceState } from '../useLayoutState'
import {
  type WorkspacePanelLayout, type PersistedState, type LayoutNode, type TabsNode, type GroupTab,
  DEFAULT_LAYOUT,
} from '../workspaceTypes'
import { normalizeLayout, tabsInGroup } from '../../workspace/panelLayoutModel'

// --- Fixtures ---------------------------------------------------------------

function makeState(opts: {
  layout: WorkspacePanelLayout
  terminalBindings?: Record<string, string>
  editorMru?: string[]
  terminalMru?: string[]
  activeGroupId?: string
}): InstanceState {
  const initial: PersistedState = {
    panelLayout: opts.layout,
    terminalBindings: opts.terminalBindings ?? {},
    editorMru: opts.editorMru ?? [],
    terminalMru: opts.terminalMru ?? [],
    activeGroupId: opts.activeGroupId ?? 'group:1',
    mobilePane: 'files',
    layout: DEFAULT_LAYOUT,
    recentFiles: [],
  }
  return buildInstanceState(initial)
}

const ed = (instanceId: string, tabId: string, extra: Partial<GroupTab> = {}): GroupTab =>
  ({ instanceId, kind: 'editor', tabId, ...extra } as GroupTab)
/** A tab's preview flag (editor/terminal); tasks tabs carry none. */
const previewOf = (tab: GroupTab): boolean | undefined => (tab.kind === 'tasks' ? undefined : tab.preview)
const term = (instanceId: string): GroupTab => ({ instanceId, kind: 'terminal' })
const grp = (id: string, tabs: GroupTab[]): unknown =>
  ({ kind: 'tabs', id, tabs, activeTab: tabs[0]?.instanceId ?? '' })
const leaf = (panel: string): unknown => ({ kind: 'leaf', id: panel, panel })

/** Two groups inside the center split (both are CENTER groups). */
function twoCenterGroups(g1: GroupTab[], g2: GroupTab[]): WorkspacePanelLayout {
  return normalizeLayout({
    desktop: {
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: leaf('files') },
        { grow: true, node: { kind: 'split', id: 'center', axis: 'row', children: [
          { grow: true, node: grp('group:1', g1) },
          { node: grp('group:2', g2) },
        ] } },
        { node: leaf('sessions') },
      ],
    },
  })
}

/** One center group + one right-sidebar group. */
function centerAndRightGroup(g1: GroupTab[], gR: GroupTab[]): WorkspacePanelLayout {
  return normalizeLayout({
    desktop: {
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: leaf('files') },
        { grow: true, node: grp('group:1', g1) },
        { node: grp('group:R', gR) },
      ],
    },
  })
}

/** Three center groups (group:1/2/3 inside the center split). */
function threeCenterGroups(g1: GroupTab[], g2: GroupTab[], g3: GroupTab[]): WorkspacePanelLayout {
  return normalizeLayout({
    desktop: {
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: leaf('files') },
        { grow: true, node: { kind: 'split', id: 'center', axis: 'row', children: [
          { grow: true, node: grp('group:1', g1) },
          { node: grp('group:2', g2) },
          { node: grp('group:3', g3) },
        ] } },
        { node: leaf('sessions') },
      ],
    },
  })
}

function findGroup(tree: LayoutNode, id: string): TabsNode | null {
  if (tree.kind === 'tabs') return tree.id === id ? tree : null
  if (tree.kind === 'split') {
    for (const c of tree.children) { const hit = findGroup(c.node, id); if (hit) return hit }
  }
  return null
}

const ids = (tabs: GroupTab[]): string[] => tabs.map((t) => t.instanceId)
const NO_PROTECT: ReadonlySet<string> = new Set()

// --- MOVE_TAB ---------------------------------------------------------------

describe('MOVE_TAB', () => {
  it('reorders within a group (from===to) and focuses the moved tab', () => {
    let s = makeState({ layout: twoCenterGroups([ed('e1', 'a.ts'), ed('e2', 'b.ts'), ed('e3', 'c.ts')], [ed('e9', 'z.ts')]) })
    s = instanceReducer(s, { type: 'MOVE_TAB', fromGroupId: 'group:1', instanceId: 'e1', toGroupId: 'group:1', toIndex: 2, protectedPaths: NO_PROTECT })
    expect(ids(findGroup(s.panelLayout.desktop, 'group:1')!.tabs)).toEqual(['e2', 'e3', 'e1'])
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'e1' })
    expect(s.activeGroupId).toBe('group:1')
  })

  it('moves an editor tab across groups, focuses it + retargets the active group + MRU', () => {
    let s = makeState({ layout: twoCenterGroups([ed('e1', 'a.ts'), ed('e2', 'b.ts')], [ed('e9', 'z.ts')]), editorMru: ['e1'] })
    s = instanceReducer(s, { type: 'MOVE_TAB', fromGroupId: 'group:1', instanceId: 'e1', toGroupId: 'group:2', toIndex: 0, protectedPaths: NO_PROTECT })
    expect(ids(findGroup(s.panelLayout.desktop, 'group:1')!.tabs)).toEqual(['e2'])
    expect(ids(findGroup(s.panelLayout.desktop, 'group:2')!.tabs)).toEqual(['e1', 'e9'])
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'e1' })
    expect(s.activeGroupId).toBe('group:2')
    expect(s.editorMru[0]).toBe('e1')
  })

  it('moves a terminal tab across groups preserving its binding (identity travels)', () => {
    let s = makeState({
      layout: twoCenterGroups([term('t1'), ed('e1', 'a.ts')], [ed('e9', 'z.ts')]),
      terminalBindings: { t1: 's1' }, terminalMru: ['t1'],
    })
    s = instanceReducer(s, { type: 'MOVE_TAB', fromGroupId: 'group:1', instanceId: 't1', toGroupId: 'group:2', toIndex: 99, protectedPaths: NO_PROTECT })
    expect(findGroup(s.panelLayout.desktop, 'group:2')!.tabs).toContainEqual(term('t1'))
    expect(s.terminalBindings.t1).toBe('s1')
    expect(s.focusedPane).toEqual({ kind: 'terminal', instanceId: 't1' })
    expect(s.terminalMru[0]).toBe('t1')
  })

  it('preview travels: a clean preview in the target is dropped', () => {
    let s = makeState({ layout: twoCenterGroups([ed('e1', 'a.ts', { preview: true })], [ed('e2', 'b.ts', { preview: true })]) })
    s = instanceReducer(s, { type: 'MOVE_TAB', fromGroupId: 'group:1', instanceId: 'e1', toGroupId: 'group:2', toIndex: 0, protectedPaths: NO_PROTECT })
    const dst = findGroup(s.panelLayout.desktop, 'group:2')!
    // e2 was a clean preview → dropped; the moved preview e1 survives.
    expect(ids(dst.tabs)).toEqual(['e1'])
    expect(previewOf(dst.tabs[0])).toBe(true)
  })

  it('preview travels: a dirty PROTECTED editor preview in the target is pinned (kept)', () => {
    let s = makeState({ layout: twoCenterGroups([ed('e1', 'a.ts', { preview: true })], [ed('e2', 'b.ts', { preview: true })]) })
    s = instanceReducer(s, { type: 'MOVE_TAB', fromGroupId: 'group:1', instanceId: 'e1', toGroupId: 'group:2', toIndex: 0, protectedPaths: new Set(['b.ts']) })
    const dst = findGroup(s.panelLayout.desktop, 'group:2')!
    expect(ids(dst.tabs)).toEqual(['e1', 'e2'])
    expect(previewOf(dst.tabs.find((t) => t.instanceId === 'e2')!)).toBeUndefined()
    expect(previewOf(dst.tabs.find((t) => t.instanceId === 'e1')!)).toBe(true)
  })

  it('a center source that empties closes only when another center group exists', () => {
    let s = makeState({ layout: twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')]) })
    s = instanceReducer(s, { type: 'MOVE_TAB', fromGroupId: 'group:1', instanceId: 'e1', toGroupId: 'group:2', toIndex: 99, protectedPaths: NO_PROTECT })
    expect(findGroup(s.panelLayout.desktop, 'group:1')).toBeNull()
    expect(ids(findGroup(s.panelLayout.desktop, 'group:2')!.tabs)).toEqual(['e2', 'e1'])
  })

  it('the last center source that empties stays empty; a right-sidebar source is removed', () => {
    // Right-sidebar source empties → removed.
    let s = makeState({ layout: centerAndRightGroup([ed('e1', 'a.ts')], [ed('r1', 'r.ts')]) })
    s = instanceReducer(s, { type: 'MOVE_TAB', fromGroupId: 'group:R', instanceId: 'r1', toGroupId: 'group:1', toIndex: 99, protectedPaths: NO_PROTECT })
    expect(findGroup(s.panelLayout.desktop, 'group:R')).toBeNull()
    expect(ids(findGroup(s.panelLayout.desktop, 'group:1')!.tabs)).toEqual(['e1', 'r1'])

    // Last center source empties (a sidebar group exists) → stays empty.
    let s2 = makeState({ layout: centerAndRightGroup([ed('e1', 'a.ts')], [ed('r1', 'r.ts')]) })
    s2 = instanceReducer(s2, { type: 'MOVE_TAB', fromGroupId: 'group:1', instanceId: 'e1', toGroupId: 'group:R', toIndex: 99, protectedPaths: NO_PROTECT })
    expect(tabsInGroup(s2.panelLayout.desktop, 'group:1')).toEqual([])
    expect(ids(findGroup(s2.panelLayout.desktop, 'group:R')!.tabs)).toEqual(['r1', 'e1'])
  })

  it('is a no-op when the tab is not in the named source group', () => {
    const s = makeState({ layout: twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')]) })
    const next = instanceReducer(s, { type: 'MOVE_TAB', fromGroupId: 'group:2', instanceId: 'e1', toGroupId: 'group:2', toIndex: 0, protectedPaths: NO_PROTECT })
    expect(next).toBe(s)
  })
})

// --- MOVE_GROUP -------------------------------------------------------------

describe('MOVE_GROUP', () => {
  it('beside: relocates the group + targets it as the active group', () => {
    let s = makeState({ layout: twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')]) })
    s = instanceReducer(s, { type: 'MOVE_GROUP', groupId: 'group:2', placement: { kind: 'beside', targetId: 'group:1', side: 'below' } })
    expect(findGroup(s.panelLayout.desktop, 'group:1')).not.toBeNull()
    expect(findGroup(s.panelLayout.desktop, 'group:2')).not.toBeNull()
    expect(s.activeGroupId).toBe('group:2')
  })

  it('merge: folds the group into the target, focuses the merged-in active tab', () => {
    let s = makeState({ layout: twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')]) })
    s = instanceReducer(s, { type: 'MOVE_GROUP', groupId: 'group:1', placement: { kind: 'merge', targetGroupId: 'group:2' } })
    expect(findGroup(s.panelLayout.desktop, 'group:1')).toBeNull()
    expect(ids(findGroup(s.panelLayout.desktop, 'group:2')!.tabs)).toEqual(['e2', 'e1'])
    expect(s.activeGroupId).toBe('group:2')
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'e1' })
  })

  it('merge: preserves activeGroupId/focus when neither src nor dst was active', () => {
    let s = makeState({
      layout: threeCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')], [ed('e3', 'c.ts')]),
      activeGroupId: 'group:3', editorMru: ['e3'],
    })
    expect(s.activeGroupId).toBe('group:3')
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'e3' })
    // Merge two UNRELATED groups → the active group + focus must not move.
    s = instanceReducer(s, { type: 'MOVE_GROUP', groupId: 'group:1', placement: { kind: 'merge', targetGroupId: 'group:2' } })
    expect(findGroup(s.panelLayout.desktop, 'group:1')).toBeNull()
    expect(ids(findGroup(s.panelLayout.desktop, 'group:2')!.tabs)).toEqual(['e2', 'e1'])
    expect(s.activeGroupId).toBe('group:3')
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'e3' })
  })

  it('is a no-op on a self-drop (beside or merge onto itself)', () => {
    const s = makeState({ layout: twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')]) })
    expect(instanceReducer(s, { type: 'MOVE_GROUP', groupId: 'group:1', placement: { kind: 'beside', targetId: 'group:1', side: 'right' } })).toBe(s)
    expect(instanceReducer(s, { type: 'MOVE_GROUP', groupId: 'group:1', placement: { kind: 'merge', targetGroupId: 'group:1' } })).toBe(s)
  })
})
