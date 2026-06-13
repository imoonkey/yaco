// Unit tests for the flat tab-group reducer (vt-state). The reducer is pure, so
// these run without React. They pin: group-tab open/preview/close semantics, the
// empty-group invariant, atomic create+bind for terminals, split → empty focused
// group, retarget/close-under across ALL groups, and the activeGroupId/MRU/focus
// model (clamped on every transition).
import { describe, it, expect } from 'vitest'
import { instanceReducer, buildInstanceState, activeEditorTabOf, type InstanceState } from '../useLayoutState'
import {
  type WorkspacePanelLayout, type PersistedState, type LayoutNode, type TabsNode, type GroupTab,
  DEFAULT_LAYOUT,
} from '../workspaceTypes'
import {
  defaultWorkspacePanelLayout, normalizeLayout, firstGroupId, groupOf,
  tabsInGroup, editorTabPaths, editorInstancesInOrder, terminalInstancesInOrder,
} from '../../workspace/panelLayoutModel'

// --- Fixtures ---------------------------------------------------------------

function makeState(opts: {
  layout?: WorkspacePanelLayout
  terminalBindings?: Record<string, string>
  editorMru?: string[]
  terminalMru?: string[]
  activeGroupId?: string
}): InstanceState {
  const initial: PersistedState = {
    panelLayout: opts.layout ?? defaultWorkspacePanelLayout(),
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

/** A dock + one working group carrying `tabs`. */
function oneGroup(tabs: GroupTab[]): WorkspacePanelLayout {
  return normalizeLayout({
    desktop: {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: { kind: 'tabs', id: 'group:1', tabs, activeTab: tabs[0]?.instanceId ?? '' } },
      ],
    },
  })
}

/** Two working groups, each carrying its own tabs. */
function twoGroups(g1: GroupTab[], g2: GroupTab[]): WorkspacePanelLayout {
  return normalizeLayout({
    desktop: {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: g1, activeTab: g1[0]?.instanceId ?? '' } },
        { node: { kind: 'tabs', id: 'group:2', tabs: g2, activeTab: g2[0]?.instanceId ?? '' } },
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

const editor = (instanceId: string, tabId: string, extra: Partial<GroupTab> = {}): GroupTab =>
  ({ instanceId, kind: 'editor', tabId, ...extra } as GroupTab)

const NO_PROTECT: ReadonlySet<string> = new Set()

// --- Open a file into a focused EMPTY group ---------------------------------

describe('OPEN_TAB into a focused empty group', () => {
  it('appends the editor tab, activates + focuses it, sets activeGroupId', () => {
    let s = makeState({}) // default tree: empty group:1, activeGroupId group:1
    expect(tabsInGroup(s.panelLayout.desktop, 'group:1')).toEqual([])

    s = instanceReducer(s, { type: 'OPEN_TAB', groupId: 'group:1', tab: editor('editor', 'a.ts') })

    expect(tabsInGroup(s.panelLayout.desktop, 'group:1')).toEqual([editor('editor', 'a.ts')])
    expect(findGroup(s.panelLayout.desktop, 'group:1')?.activeTab).toBe('editor')
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'editor' })
    expect(s.activeGroupId).toBe('group:1')
    expect(s.editorMru[0]).toBe('editor')
  })

  it('dedups by exact tabId: a second open of the same tab just activates it', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts'), editor('editor:2', 'b.ts')]) })
    s = instanceReducer(s, { type: 'SET_ACTIVE_GROUP_TAB', groupId: 'group:1', instanceId: 'editor:2' })
    s = instanceReducer(s, { type: 'OPEN_TAB', groupId: 'group:1', tab: editor('editor:9', 'a.ts') })
    // No new tab — the existing 'a.ts' tab is activated, 'editor:9' unused.
    expect(tabsInGroup(s.panelLayout.desktop, 'group:1')).toEqual([editor('editor', 'a.ts'), editor('editor:2', 'b.ts')])
    expect(findGroup(s.panelLayout.desktop, 'group:1')?.activeTab).toBe('editor')
  })

  it('a.ts and diff:a.ts coexist (exact-tabId dedup, not path)', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts')]) })
    s = instanceReducer(s, { type: 'OPEN_DIFF_TAB', groupId: 'group:1', tabId: 'diff:a.ts', newId: 'editor:2' })
    expect(tabsInGroup(s.panelLayout.desktop, 'group:1').map((t) => (t.kind === 'editor' ? t.tabId : '')))
      .toEqual(['a.ts', 'diff:a.ts'])
  })
})

// --- Open a session into a focused empty group (atomic create+bind) ---------

describe('OPEN_BOUND_TERMINAL_TAB is create+bind atomic', () => {
  it('appends a terminal tab AND binds it in ONE transition', () => {
    let s = makeState({}) // empty group:1
    s = instanceReducer(s, { type: 'OPEN_BOUND_TERMINAL_TAB', groupId: 'group:1', session: 's1', newId: 'terminal', preview: false, protectedPaths: new Set() })

    expect(tabsInGroup(s.panelLayout.desktop, 'group:1')).toEqual([{ instanceId: 'terminal', kind: 'terminal' }])
    expect(s.terminalBindings).toEqual({ terminal: 's1' }) // bound in the same transition, survives GC
    expect(s.focusedPane).toEqual({ kind: 'terminal', instanceId: 'terminal' })
    expect(s.terminalMru[0]).toBe('terminal')
    expect(s.activeGroupId).toBe('group:1')
  })
})

// --- Split → empty focused group → open lands there -------------------------

describe('SPLIT_GROUP (seed: false) spawns an empty focused sibling', () => {
  it('creates an empty group and sets activeGroupId to it; the next open lands there', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts')]) })
    s = instanceReducer(s, { type: 'SPLIT_GROUP', fromGroupId: 'group:1', side: 'right', newGroupId: 'group:2', seed: false })

    expect(firstGroupId(s.panelLayout.desktop)).toBe('group:1')
    expect(tabsInGroup(s.panelLayout.desktop, 'group:2')).toEqual([]) // empty
    expect(s.activeGroupId).toBe('group:2') // focused via activeGroupId, not focusedPane

    // targetGroup resolves to the empty group:2, so OPEN_TAB lands there.
    s = instanceReducer(s, { type: 'OPEN_TAB', groupId: s.activeGroupId, tab: editor('editor:2', 'b.ts') })
    expect(tabsInGroup(s.panelLayout.desktop, 'group:2')).toEqual([editor('editor:2', 'b.ts')])
    expect(tabsInGroup(s.panelLayout.desktop, 'group:1')).toEqual([editor('editor', 'a.ts')]) // original kept its file
  })
})

// --- Split SEEDS the new group from the source's active tab (FIX 2) ----------

describe('SPLIT_GROUP (seed: true) seeds from the source active tab', () => {
  it('DUPLICATES an editor active tab into the new group (fresh instanceId, same tabId)', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts')]) })
    s = instanceReducer(s, { type: 'SPLIT_GROUP', fromGroupId: 'group:1', side: 'right', newGroupId: 'group:2', seed: true })

    // Source keeps its file; the new group shows the SAME file in a fresh tab.
    expect(tabsInGroup(s.panelLayout.desktop, 'group:1')).toEqual([editor('editor', 'a.ts')])
    const dup = tabsInGroup(s.panelLayout.desktop, 'group:2')
    expect(dup).toHaveLength(1)
    expect(dup[0]).toMatchObject({ kind: 'editor', tabId: 'a.ts' })
    expect(dup[0].instanceId).not.toBe('editor') // a distinct instance sharing the per-path buffer
    expect(s.activeGroupId).toBe('group:2')
  })

  it('MOVES a terminal active tab into the new group (same instanceId + binding, no new PTY)', () => {
    let s = makeState({
      layout: oneGroup([editor('editor', 'a.ts'), { instanceId: 'terminal', kind: 'terminal' }]),
      terminalBindings: { terminal: 's1' }, terminalMru: ['terminal'],
    })
    s = instanceReducer(s, { type: 'SET_ACTIVE_GROUP_TAB', groupId: 'group:1', instanceId: 'terminal' })
    s = instanceReducer(s, { type: 'SPLIT_GROUP', fromGroupId: 'group:1', side: 'right', newGroupId: 'group:2', seed: true })

    // The terminal moved out of the source (its active falls to the editor neighbour);
    // the SAME instance + binding now lives in the new group — no new terminal id.
    expect(tabsInGroup(s.panelLayout.desktop, 'group:1')).toEqual([editor('editor', 'a.ts')])
    expect(tabsInGroup(s.panelLayout.desktop, 'group:2')).toEqual([{ instanceId: 'terminal', kind: 'terminal' }])
    expect(terminalInstancesInOrder(s.panelLayout.desktop)).toEqual(['terminal']) // exactly one terminal, not two
    expect(s.terminalBindings).toEqual({ terminal: 's1' }) // binding preserved (no rebind)
    expect(s.activeGroupId).toBe('group:2')
  })

  it('leaves the new group EMPTY when the source group is empty', () => {
    let s = makeState({ layout: oneGroup([]) }) // empty group:1
    s = instanceReducer(s, { type: 'SPLIT_GROUP', fromGroupId: 'group:1', side: 'right', newGroupId: 'group:2', seed: true })
    expect(tabsInGroup(s.panelLayout.desktop, 'group:2')).toEqual([])
    expect(s.activeGroupId).toBe('group:2')
  })
})

// --- Terminal tabs preview / pin like file tabs (FIX 1) ----------------------

describe('OPEN_BOUND_TERMINAL_TAB preview + one-preview-per-group', () => {
  it('a preview terminal replaces the group\'s current preview editor tab', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts', { preview: true })]) })
    s = instanceReducer(s, { type: 'OPEN_BOUND_TERMINAL_TAB', groupId: 'group:1', session: 's1', newId: 'terminal', preview: true, protectedPaths: new Set() })

    // The clean preview editor tab was dropped; the preview terminal is the only preview.
    const tabs = tabsInGroup(s.panelLayout.desktop, 'group:1')
    expect(tabs).toEqual([{ instanceId: 'terminal', kind: 'terminal', preview: true }])
  })

  it('keeps a DIRTY (protected) preview editor and pins it instead of dropping', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts', { preview: true })]) })
    s = instanceReducer(s, { type: 'OPEN_BOUND_TERMINAL_TAB', groupId: 'group:1', session: 's1', newId: 'terminal', preview: true, protectedPaths: new Set(['a.ts']) })

    const tabs = tabsInGroup(s.panelLayout.desktop, 'group:1')
    expect(tabs).toEqual([
      editor('editor', 'a.ts'), // dirty preview pinned (preview flag cleared), not dropped
      { instanceId: 'terminal', kind: 'terminal', preview: true },
    ])
  })

  it('PIN_TAB clears a terminal tab\'s preview flag (promote on re-click/interaction)', () => {
    let s = makeState({ layout: oneGroup([]) })
    s = instanceReducer(s, { type: 'OPEN_BOUND_TERMINAL_TAB', groupId: 'group:1', session: 's1', newId: 'terminal', preview: true, protectedPaths: new Set() })
    expect(tabsInGroup(s.panelLayout.desktop, 'group:1')[0]).toMatchObject({ preview: true })
    s = instanceReducer(s, { type: 'PIN_TAB', groupId: 'group:1', instanceId: 'terminal' })
    expect(tabsInGroup(s.panelLayout.desktop, 'group:1')).toEqual([{ instanceId: 'terminal', kind: 'terminal' }])
  })
})

// --- Close last tab → one empty group survives ------------------------------

describe('CLOSE_GROUP_TAB / empty-group invariant', () => {
  it('closing the last tab of the LAST group leaves one empty group', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts')]) })
    s = instanceReducer(s, { type: 'CLOSE_GROUP_TAB', groupId: 'group:1', instanceId: 'editor' })

    expect(firstGroupId(s.panelLayout.desktop)).toBe('group:1') // still there
    expect(tabsInGroup(s.panelLayout.desktop, 'group:1')).toEqual([]) // empty
    expect(editorInstancesInOrder(s.panelLayout.desktop)).toEqual([])
  })

  it('closing the last tab of a NON-last group removes that group', () => {
    let s = makeState({ layout: twoGroups([editor('editor', 'a.ts')], [editor('editor:2', 'b.ts')]) })
    s = instanceReducer(s, { type: 'CLOSE_GROUP_TAB', groupId: 'group:2', instanceId: 'editor:2' })
    expect(findGroup(s.panelLayout.desktop, 'group:2')).toBeNull() // group removed
    expect(firstGroupId(s.panelLayout.desktop)).toBe('group:1')
  })

  it('closing the active tab focuses the in-group neighbour (group.activeTab, focusedPane, selection all agree)', () => {
    let s = makeState({ layout: oneGroup([editor('a', 'a.ts'), editor('b', 'b.ts'), editor('c', 'c.ts')]) })
    s = instanceReducer(s, { type: 'SET_ACTIVE_GROUP_TAB', groupId: 'group:1', instanceId: 'b' })
    s = instanceReducer(s, { type: 'CLOSE_GROUP_TAB', groupId: 'group:1', instanceId: 'b' })
    // The neighbour at min(idx, len-1) is 'c' — and focus + MRU + the resolved
    // selection must all land on it, not on whatever the global MRU/doc-order picks.
    expect(findGroup(s.panelLayout.desktop, 'group:1')?.activeTab).toBe('c')
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'c' })
    expect(s.editorMru[0]).toBe('c')
    expect(activeEditorTabOf(s)?.tabId).toBe('c.ts')
  })

  it('an explicit CLOSE_GROUP removes an empty non-last group', () => {
    let s = makeState({ layout: twoGroups([editor('editor', 'a.ts')], []) })
    s = instanceReducer(s, { type: 'CLOSE_GROUP', groupId: 'group:2' })
    expect(findGroup(s.panelLayout.desktop, 'group:2')).toBeNull()
  })
})

// --- Dirty-close with the same path open elsewhere (spans all groups) -------

describe('buffer keep-set spans every group on the underlying path', () => {
  it('closing one of two editor tabs on a.ts keeps a.ts referenced', () => {
    let s = makeState({ layout: twoGroups([editor('editor', 'a.ts')], [editor('editor:2', 'a.ts')]) })
    expect(editorTabPaths(s.panelLayout.desktop)).toEqual(['a.ts']) // deduped union

    s = instanceReducer(s, { type: 'CLOSE_GROUP_TAB', groupId: 'group:1', instanceId: 'editor' })
    // group:2 still shows a.ts, so the path stays in the keep-set (no buffer drop).
    expect(editorTabPaths(s.panelLayout.desktop)).toEqual(['a.ts'])
  })

  it('a file tab and its diff tab count together on the underlying path', () => {
    const s = makeState({ layout: twoGroups([editor('editor', 'a.ts')], [editor('editor:2', 'diff:a.ts')]) })
    expect(editorTabPaths(s.panelLayout.desktop)).toEqual(['a.ts'])
  })
})

// --- Preview promote / replace ----------------------------------------------

describe('OPEN_PREVIEW_TAB promote/replace (re-homed onto the group)', () => {
  it('drops a clean old preview when a new preview opens', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts', { preview: true })]) })
    s = instanceReducer(s, { type: 'OPEN_PREVIEW_TAB', groupId: 'group:1', tabId: 'b.ts', newId: 'editor:2', protectedPaths: NO_PROTECT })
    const tabs = tabsInGroup(s.panelLayout.desktop, 'group:1')
    expect(tabs.map((t) => (t.kind === 'editor' ? t.tabId : ''))).toEqual(['b.ts']) // a.ts (clean preview) dropped
    expect(tabs[0].kind === 'editor' && tabs[0].preview).toBe(true)
  })

  it('keeps a DIRTY old preview (auto-pins it) when a new preview opens', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts', { preview: true })]) })
    s = instanceReducer(s, { type: 'OPEN_PREVIEW_TAB', groupId: 'group:1', tabId: 'b.ts', newId: 'editor:2', protectedPaths: new Set(['a.ts']) })
    const tabs = tabsInGroup(s.panelLayout.desktop, 'group:1')
    expect(tabs.map((t) => (t.kind === 'editor' ? t.tabId : ''))).toEqual(['a.ts', 'b.ts']) // a.ts kept
    expect(tabs[0].kind === 'editor' && !!tabs[0].preview).toBe(false) // a.ts auto-pinned
    expect(tabs[1].kind === 'editor' && tabs[1].preview).toBe(true)
  })

  it('just activates an already-pinned tab opened as preview (no demote)', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts'), editor('editor:2', 'b.ts')]) })
    s = instanceReducer(s, { type: 'OPEN_PREVIEW_TAB', groupId: 'group:1', tabId: 'b.ts', newId: 'editor:9', protectedPaths: NO_PROTECT })
    const g = findGroup(s.panelLayout.desktop, 'group:1')!
    expect(g.tabs.map((t) => (t.kind === 'editor' ? t.tabId : ''))).toEqual(['a.ts', 'b.ts'])
    expect(g.tabs.every((t) => t.kind !== 'editor' || !t.preview)).toBe(true) // none became preview
    expect(g.activeTab).toBe('editor:2')
  })

  it('PIN_TAB clears the preview flag', () => {
    let s = makeState({ layout: oneGroup([editor('editor', 'a.ts', { preview: true })]) })
    s = instanceReducer(s, { type: 'PIN_TAB', groupId: 'group:1', instanceId: 'editor' })
    const tab = tabsInGroup(s.panelLayout.desktop, 'group:1')[0]
    expect(tab.kind === 'editor' && !!tab.preview).toBe(false)
  })
})

// --- Retarget / close-under across every group ------------------------------

describe('RETARGET_PATHS / CLOSE_TABS_UNDER fan out across all groups', () => {
  it('retargets a renamed path in every group (file + diff)', () => {
    let s = makeState({ layout: twoGroups([editor('editor', 'src/a.ts')], [editor('editor:2', 'diff:src/a.ts')]) })
    s = instanceReducer(s, { type: 'RETARGET_PATHS', oldPath: 'src/a.ts', newPath: 'src/b.ts' })
    expect(editorTabPaths(s.panelLayout.desktop)).toEqual(['src/b.ts'])
  })

  it('closes tabs under a deleted dir in every group', () => {
    let s = makeState({ layout: twoGroups([editor('editor', 'src/a.ts'), editor('e2', 'lib/x.ts')], [editor('editor:3', 'src/deep/y.ts')]) })
    s = instanceReducer(s, { type: 'CLOSE_TABS_UNDER', path: 'src' })
    expect(editorTabPaths(s.panelLayout.desktop).sort()).toEqual(['lib/x.ts'])
  })

  it('retargets a compare diff tab on its underlying path, preserving base/compare refs', () => {
    let s = makeState({ layout: oneGroup([editor('e1', 'diff:a.ts?base=main&compare=HEAD')]) })
    s = instanceReducer(s, { type: 'RETARGET_PATHS', oldPath: 'a.ts', newPath: 'b.ts' })
    const tab = tabsInGroup(s.panelLayout.desktop, 'group:1')[0]
    expect(tab.kind === 'editor' && tab.tabId).toBe('diff:b.ts?base=main&compare=HEAD')
  })

  it('closes a compare diff tab under a deleted dir (matches on the underlying path)', () => {
    let s = makeState({ layout: oneGroup([editor('e1', 'diff:src/a.ts?base=main&compare=HEAD'), editor('e2', 'lib/x.ts')]) })
    s = instanceReducer(s, { type: 'CLOSE_TABS_UNDER', path: 'src' })
    expect(editorTabPaths(s.panelLayout.desktop)).toEqual(['lib/x.ts'])
  })
})

// --- activeEditorTabOf — the ACTIVE GROUP's editor tab (selection API) -------

describe('activeEditorTabOf reflects the active group, not the global MRU editor', () => {
  it('returns the active group\'s active editor tab', () => {
    const s = makeState({ layout: oneGroup([editor('e1', 'a.ts')]) })
    expect(activeEditorTabOf(s)?.tabId).toBe('a.ts')
  })

  it('is null after splitting to a focused EMPTY group (empty group → null, not the old file)', () => {
    let s = makeState({ layout: oneGroup([editor('e1', 'a.ts')]) })
    s = instanceReducer(s, { type: 'SPLIT_GROUP', fromGroupId: 'group:1', side: 'right', newGroupId: 'group:2', seed: false })
    expect(s.activeGroupId).toBe('group:2')
    expect(activeEditorTabOf(s)).toBeNull()
  })

  it('is null when the active group\'s active tab is a terminal', () => {
    let s = makeState({ layout: oneGroup([editor('e1', 'a.ts'), { instanceId: 't1', kind: 'terminal' }]) })
    s = instanceReducer(s, { type: 'SET_ACTIVE_GROUP_TAB', groupId: 'group:1', instanceId: 't1' })
    expect(activeEditorTabOf(s)).toBeNull()
  })
})

// --- activeGroupId clamp + focus model --------------------------------------

describe('activeGroupId / focus reconcile', () => {
  it('gcMaps clamps activeGroupId to the first group when its group disappears', () => {
    let s = makeState({ layout: twoGroups([editor('editor', 'a.ts')], [editor('editor:2', 'b.ts')]), activeGroupId: 'group:2' })
    expect(s.activeGroupId).toBe('group:2')
    // Closing group:2's only tab removes the group → activeGroupId clamps to group:1.
    s = instanceReducer(s, { type: 'CLOSE_GROUP_TAB', groupId: 'group:2', instanceId: 'editor:2' })
    expect(s.activeGroupId).toBe('group:1')
  })

  it('FOCUS_PANE sets activeGroupId to the focused instance group', () => {
    let s = makeState({ layout: twoGroups([editor('editor', 'a.ts')], [editor('editor:2', 'b.ts')]) })
    s = instanceReducer(s, { type: 'FOCUS_PANE', kind: 'editor', instanceId: 'editor:2' })
    expect(s.activeGroupId).toBe(groupOf(s.panelLayout.desktop, 'editor:2'))
    expect(s.activeGroupId).toBe('group:2')
    expect(s.editorMru[0]).toBe('editor:2')
  })

  it('REORDER_GROUP_TAB splices a tab to a new index', () => {
    let s = makeState({ layout: oneGroup([editor('a', 'a.ts'), editor('b', 'b.ts'), editor('c', 'c.ts')]) })
    s = instanceReducer(s, { type: 'REORDER_GROUP_TAB', groupId: 'group:1', instanceId: 'c', toIndex: 0 })
    expect(tabsInGroup(s.panelLayout.desktop, 'group:1').map((t) => t.instanceId)).toEqual(['c', 'a', 'b'])
  })
})

// --- SET_PANEL_LAYOUT GCs maps against the tree -----------------------------

describe('SET_PANEL_LAYOUT GCs maps/MRU/activeGroupId', () => {
  it('drops bindings/MRU for ids the new tree lacks and clamps activeGroupId', () => {
    let s = makeState({
      layout: twoGroups([editor('editor', 'a.ts')], [{ instanceId: 'terminal', kind: 'terminal' }]),
      terminalBindings: { terminal: 's1' },
      editorMru: ['editor'],
      terminalMru: ['terminal'],
      activeGroupId: 'group:2',
    })
    s = instanceReducer(s, { type: 'SET_PANEL_LAYOUT', update: defaultWorkspacePanelLayout() })
    expect(editorInstancesInOrder(s.panelLayout.desktop)).toEqual([])
    expect(terminalInstancesInOrder(s.panelLayout.desktop)).toEqual([])
    expect(s.terminalBindings).toEqual({})
    expect(s.editorMru).toEqual([])
    expect(s.terminalMru).toEqual([])
    expect(s.activeGroupId).toBe('group:1') // clamped to the default's only group
  })
})

// --- BIND_TERMINAL / buildInstanceState -------------------------------------

describe('BIND_TERMINAL / buildInstanceState', () => {
  it('binds and unbinds a terminal by instance id', () => {
    let s = makeState({ layout: oneGroup([{ instanceId: 'terminal', kind: 'terminal' }]) })
    s = instanceReducer(s, { type: 'BIND_TERMINAL', id: 'terminal', session: 's1' })
    expect(s.terminalBindings.terminal).toBe('s1')
    s = instanceReducer(s, { type: 'BIND_TERMINAL', id: 'terminal', session: '' })
    expect(s.terminalBindings.terminal).toBeUndefined()
  })

  it('seeds activeGroupId + focus from the restored MRU head; GCs ghost ids', () => {
    const s = makeState({
      layout: oneGroup([editor('editor', 'a.ts')]),
      editorMru: ['ghost', 'editor'],
      activeGroupId: 'gone',
    })
    expect(s.editorMru).toEqual(['editor']) // ghost dropped
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'editor' })
    expect(s.activeGroupId).toBe('group:1') // 'gone' clamped to the live group
  })
})
