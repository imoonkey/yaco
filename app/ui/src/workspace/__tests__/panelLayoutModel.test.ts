// Unit tests for the panel layout model (group model). Pure data/logic — no DOM.
// Pins the group-node invariants: payload-preserving normalization, the empty-
// group invariant, the dock-leaf guard, the group helpers, the structural ops,
// and idempotency.
import { describe, it, expect } from 'vitest'
import {
  PANEL_IDS,
  isPanelId,
  isDockPanel,
  MOBILE_DOCKS,
  isMobileDock,
  DEFAULT_MOBILE_DOCK,
  defaultDesktopTree,
  defaultWorkspacePanelLayout,
  normalizeDesktopTree,
  normalizeRegions,
  normalizeLayout,
  firstGroupId,
  regionsOf,
  centerOf,
  firstCenterGroupId,
  groupOf,
  tabsInGroup,
  editorTabsInGroup,
  terminalTabsInGroup,
  tabByInstance,
  editorTabPaths,
  editorInstancesInOrder,
  terminalInstancesInOrder,
  newInstanceId,
  collectIds,
  splitBeside,
  DEFAULT_SPLIT_BASIS,
  closeGroup,
  ensureCenterGroup,
  mapGroup,
  moveLeaf,
  moveLeafToEdge,
  sidebarVisibility,
  leafPanelsInOrder,
  resolveActiveEditor,
  resolveActiveTerminal,
} from '../panelLayoutModel'
import type { LayoutNode, SplitNode, SplitChild, TabsNode, WorkspacePanelLayout } from '../../hooks/workspaceTypes'

function asSplit(node: LayoutNode): SplitNode {
  if (node.kind !== 'split') throw new Error(`expected split, got ${node.kind}`)
  return node
}
function asTabs(node: LayoutNode): TabsNode {
  if (node.kind !== 'tabs') throw new Error(`expected tabs, got ${node.kind}`)
  return node
}

/** A layout wrapping a raw desktop tree (normalized through the default). */
function layoutWith(desktop: unknown): WorkspacePanelLayout {
  return { ...defaultWorkspacePanelLayout(), desktop: normalizeDesktopTree(desktop) }
}

const ed = (instanceId: string, tabId: string, extra: Record<string, unknown> = {}) =>
  ({ instanceId, kind: 'editor', tabId, ...extra })
const term = (instanceId: string) => ({ instanceId, kind: 'terminal' })
const group = (id: string, tabs: unknown[], activeTab = '') => ({ kind: 'tabs', id, tabs, activeTab })

/** The center group of a normalized tree (the working area's first group). Most
 *  `normalizeGroup` cases feed a bare group, which `normalizeRegions` wraps as the
 *  center child of a region row — this unwraps it for the per-group assertions. */
const centerGroup = (raw: unknown): TabsNode => asTabs(centerOf(normalizeDesktopTree(raw))!)

// --- Guards + canonical sets ------------------------------------------------

describe('guards + canonical sets', () => {
  it('recognizes the seven panel ids', () => {
    expect([...PANEL_IDS].sort()).toEqual(
      ['changes', 'editor', 'files', 'projects', 'sessions', 'tasks', 'terminal'].sort(),
    )
    expect(isPanelId('files')).toBe(true)
    expect(isPanelId('nope')).toBe(false)
  })

  it('dock panels are exactly the four singletons (editor/terminal/tasks are not docks)', () => {
    for (const p of ['projects', 'files', 'changes', 'sessions'] as const) {
      expect(isDockPanel(p)).toBe(true)
    }
    expect(isDockPanel('editor')).toBe(false)
    expect(isDockPanel('terminal')).toBe(false)
    expect(isDockPanel('tasks')).toBe(false)
  })

  it('recognizes mobile docks', () => {
    expect([...MOBILE_DOCKS]).toContain(DEFAULT_MOBILE_DOCK)
    expect(isMobileDock('browse')).toBe(true)
    expect(isMobileDock('nope')).toBe(false)
  })
})

// --- Defaults ---------------------------------------------------------------

describe('default tree', () => {
  it('is a dock column + one empty working group + an activity column', () => {
    const root = asSplit(defaultDesktopTree())
    expect(root.axis).toBe('row')
    const gid = firstGroupId(root)
    expect(gid).toBe('group:1')
    const g = asTabs(tabsNode(root, 'group:1'))
    expect(g.tabs).toEqual([])
    expect(g.activeTab).toBe('')
    // editor/terminal/tasks are never dock leaves (tasks is the desktop overlay)
    const leafPanels = collectLeafPanels(root)
    expect(leafPanels.sort()).toEqual(['changes', 'files', 'projects', 'sessions'])
  })

  it('normalizes idempotently', () => {
    const once = normalizeLayout(defaultWorkspacePanelLayout())
    const twice = normalizeLayout(once)
    expect(twice).toEqual(once)
  })
})

// helper: find a tabs node by id
function tabsNode(node: LayoutNode, id: string): LayoutNode {
  let hit: LayoutNode | null = null
  const walk = (n: LayoutNode) => {
    if (n.kind === 'tabs' && n.id === id) hit = n
    else if (n.kind === 'split') n.children.forEach((c) => walk(c.node))
  }
  walk(node)
  if (!hit) throw new Error(`no group ${id}`)
  return hit
}
function collectLeafPanels(node: LayoutNode, out: string[] = []): string[] {
  if (node.kind === 'leaf') out.push(node.panel)
  else if (node.kind === 'split') node.children.forEach((c) => collectLeafPanels(c.node, out))
  return out
}

// --- normalizeGroup ---------------------------------------------------------

describe('normalizeGroup — payload-preserving', () => {
  it('NEVER collapses an empty group', () => {
    const g = centerGroup(group('group:1', []))
    expect(g.kind).toBe('tabs')
    expect(g.tabs).toEqual([])
    expect(g.activeTab).toBe('')
  })

  it('preserves valid editor tabs and drops only malformed ones', () => {
    const g = centerGroup(group('group:1', [
      ed('editor:1', 'a.ts'),
      { instanceId: 'editor:2', kind: 'editor' }, // malformed: no tabId
      { instanceId: 'x', kind: 'bogus' }, // malformed: bad kind
      ed('editor:3', 'b.ts'),
    ], 'editor:1'))
    expect(g.tabs.map((t) => t.instanceId)).toEqual(['editor:1', 'editor:3'])
    expect(g.tabs.map((t) => (t.kind === 'editor' ? t.tabId : null))).toEqual(['a.ts', 'b.ts'])
  })

  it('re-ids a duplicate instanceId, keeping its tabId/preview/pinned payload', () => {
    const g = centerGroup(group('group:1', [
      ed('editor:1', 'a.ts'),
      ed('editor:1', 'b.ts', { pinned: true }), // duplicate id
    ], 'editor:1'))
    expect(g.tabs).toHaveLength(2)
    const [first, second] = g.tabs
    expect(first.instanceId).toBe('editor:1')
    expect(second.instanceId).not.toBe('editor:1')
    expect(second.kind === 'editor' && second.tabId).toBe('b.ts')
    expect(second.kind === 'editor' && second.pinned).toBe(true)
  })

  it('keeps exactly one preview editor tab (first in document order wins)', () => {
    const g = centerGroup(group('group:1', [
      ed('editor:1', 'a.ts', { preview: true }),
      ed('editor:2', 'b.ts', { preview: true }),
    ], 'editor:1'))
    expect(g.tabs.filter((t) => t.kind === 'editor' && t.preview)).toHaveLength(1)
    expect(g.tabs[0].kind === 'editor' && g.tabs[0].preview).toBe(true)
    expect(g.tabs[1].kind === 'editor' && g.tabs[1].preview).toBeUndefined()
  })

  it('clamps activeTab to a surviving tab, following re-ids; empties to ""', () => {
    expect(centerGroup(group('group:1', [ed('editor:1', 'a.ts')], 'gone')).activeTab).toBe('editor:1') // fell back to first

    expect(centerGroup(group('group:1', [])).activeTab).toBe('')

    // active follows the re-id of a duplicate
    const reId = centerGroup(group('group:1', [
      ed('editor:1', 'a.ts'),
      ed('editor:1', 'b.ts'),
    ], 'editor:1'))
    expect(reId.activeTab).toBe('editor:1') // first occurrence kept the id
  })

  it('mixes editor + terminal tabs in one strip in order', () => {
    const g = centerGroup(group('group:1', [
      ed('editor:1', 'a.ts'), term('terminal:1'), ed('editor:2', 'b.ts'),
    ], 'terminal:1'))
    expect(g.tabs.map((t) => t.kind)).toEqual(['editor', 'terminal', 'editor'])
    expect(g.activeTab).toBe('terminal:1')
  })
})

// --- dock-leaf guard --------------------------------------------------------

describe('dock-leaf guard', () => {
  it('drops an editor/terminal leaf (those exist only as group tabs)', () => {
    const tree = normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: { kind: 'leaf', id: 'editor', panel: 'editor' } },
        { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } },
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { node: group('group:1', []) },
      ],
    })
    expect(collectLeafPanels(tree).sort()).toEqual(['files'])
  })

  it('keeps dock panels as singletons (a duplicate dock leaf drops)', () => {
    const tree = normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'col', children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { node: { kind: 'leaf', id: 'files-2', panel: 'files' } },
        { node: group('group:1', []) },
      ],
    })
    expect(collectLeafPanels(tree)).toEqual(['files'])
  })
})

// --- tasks tab singleton ----------------------------------------------------

describe('tasks tab singleton', () => {
  const task = (instanceId = 'tasks') => ({ instanceId, kind: 'tasks' })

  it('drops a second tasks tab (one tree-wide)', () => {
    const tree = normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { node: group('g1', [task(), task()], 'tasks') },
        { node: group('g2', [task()], '') },
      ],
    })
    const allTasks = [...tabsInGroup(tree, 'g1'), ...tabsInGroup(tree, 'g2')].filter((t) => t.kind === 'tasks')
    expect(allTasks).toHaveLength(1)
    expect(tabByInstance(tree, 'tasks')?.kind).toBe('tasks')
  })

  it('re-mints a non-tasks node that claims the reserved id, keeping it for the tasks tab', () => {
    const tree = normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { node: group('g1', [ed('tasks', 'a.ts'), task()], 'tasks') },
      ],
    })
    // 'tasks' resolves to the tasks tab; the editor that claimed it was re-minted.
    expect(tabByInstance(tree, 'tasks')?.kind).toBe('tasks')
    const tabs = tabsInGroup(tree, 'g1')
    const editor = tabs.find((t) => t.kind === 'editor')!
    expect(editor.instanceId).not.toBe('tasks')
    // No duplicate ids tree-wide (collectIds dedupes; length === distinct nodes).
    expect(collectIds(tree).has('tasks')).toBe(true)
    expect(tabs).toHaveLength(2)
  })

  it('round-trips idempotently with a tasks tab', () => {
    const src = {
      kind: 'split', id: 'root', axis: 'row', children: [
        { basis: 220, node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: group('g', [ed('editor:1', 'a.ts'), task()], 'tasks') },
      ],
    }
    const once = normalizeDesktopTree(src)
    expect(normalizeDesktopTree(once)).toEqual(once)
  })
})

// --- idempotency ------------------------------------------------------------

describe('idempotency', () => {
  it('re-normalizing a normalized tree is a no-op', () => {
    const src = {
      kind: 'split', id: 'root', axis: 'row', children: [
        { basis: 220, node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: group('g', [ed('editor:1', 'a.ts'), term('terminal:1')], 'editor:1') },
      ],
    }
    const once = normalizeDesktopTree(src)
    const twice = normalizeDesktopTree(once)
    expect(twice).toEqual(once)
  })
})

// --- group helpers ----------------------------------------------------------

describe('group helpers', () => {
  const tree = normalizeDesktopTree({
    kind: 'split', id: 'root', axis: 'row', children: [
      { node: group('g1', [ed('editor:1', 'a.ts'), ed('editor:2', 'diff:b.ts?base=main&compare=HEAD')], 'editor:1') },
      { node: group('g2', [term('terminal:1'), ed('editor:3', 'a.ts')], 'terminal:1') },
    ],
  })

  it('firstGroupId / groupOf', () => {
    expect(firstGroupId(tree)).toBe('g1')
    expect(groupOf(tree, 'editor:2')).toBe('g1')
    expect(groupOf(tree, 'terminal:1')).toBe('g2')
    expect(groupOf(tree, 'nope')).toBeNull()
  })

  it('tabsInGroup / editorTabsInGroup / terminalTabsInGroup', () => {
    expect(tabsInGroup(tree, 'g1').map((t) => t.instanceId)).toEqual(['editor:1', 'editor:2'])
    expect(editorTabsInGroup(tree, 'g2').map((t) => t.instanceId)).toEqual(['editor:3'])
    expect(terminalTabsInGroup(tree, 'g2').map((t) => t.instanceId)).toEqual(['terminal:1'])
  })

  it('tabByInstance', () => {
    const t = tabByInstance(tree, 'editor:2')
    expect(t && t.kind === 'editor' && t.tabId).toBe('diff:b.ts?base=main&compare=HEAD')
    expect(tabByInstance(tree, 'nope')).toBeNull()
  })

  it('editorTabPaths maps diff ids to underlying paths and de-dupes', () => {
    // a.ts (g1), b.ts (diff in g1), a.ts again (g2) -> unique [a.ts, b.ts]
    expect(editorTabPaths(tree)).toEqual(['a.ts', 'b.ts'])
  })

  it('editor/terminal instances in document order', () => {
    expect(editorInstancesInOrder(tree)).toEqual(['editor:1', 'editor:2', 'editor:3'])
    expect(terminalInstancesInOrder(tree)).toEqual(['terminal:1'])
  })

  it('newInstanceId is unique within the tree', () => {
    const id = newInstanceId(tree, 'terminal')
    expect(collectIds(tree).has(id)).toBe(false)
    expect(id).toBe('terminal') // the bare base id is free (only 'terminal:1' is taken)
    expect(newInstanceId(tree, 'editor')).toBe('editor') // bare 'editor' free; 'editor:1..3' taken
  })

  it('resolveActive* picks MRU-then-document-order, nullable when empty', () => {
    expect(resolveActiveEditor(tree, ['editor:3', 'editor:1'])).toBe('editor:3')
    expect(resolveActiveEditor(tree, [])).toBe('editor:1')
    expect(resolveActiveTerminal(tree, [])).toBe('terminal:1')
    const empty = normalizeDesktopTree(group('group:1', []))
    expect(resolveActiveEditor(empty, [])).toBeNull()
    expect(resolveActiveTerminal(empty, [])).toBeNull()
  })
})

// --- structural ops ---------------------------------------------------------

describe('splitBeside / closeGroup / ensureCenterGroup / mapGroup', () => {
  it('splitBeside spawns an empty sibling group; axis from side', () => {
    const base = layoutWith(group('group:1', [ed('editor:1', 'a.ts')], 'editor:1'))
    const split = splitBeside(base, 'group:1', 'right', 'group:2')
    expect(firstGroupId(split.desktop)).toBeTruthy()
    const ids = collectIds(split.desktop)
    expect(ids.has('group:1')).toBe(true)
    expect(ids.has('group:2')).toBe(true)
    expect(tabsInGroup(split.desktop, 'group:2')).toEqual([])
    // a left/right split is a row axis wrapper
    const wrapper = findSplitContaining(split.desktop, 'group:2')
    expect(wrapper.axis).toBe('row')
  })

  it('splitBeside below uses a col axis', () => {
    const base = layoutWith(group('group:1', [], ''))
    const split = splitBeside(base, 'group:1', 'below', 'group:2')
    expect(findSplitContaining(split.desktop, 'group:2').axis).toBe('col')
  })

  it('splitBeside seeds the new group at the provided basis (even-split), else DEFAULT_SPLIT_BASIS', () => {
    const base = layoutWith(group('group:1', [ed('editor:1', 'a.ts')], 'editor:1'))
    const childOf = (layout: WorkspacePanelLayout) =>
      findSplitContaining(layout.desktop, 'group:2').children.find(
        (c) => c.node.kind === 'tabs' && c.node.id === 'group:2',
      )!
    // The call site measures HALF the source group's size and passes it through —
    // the inserted group starts at that basis (a ~50-50 split), not a fixed strip.
    expect(childOf(splitBeside(base, 'group:1', 'right', 'group:2', 400)).basis).toBe(400)
    // A non-finite basis (NaN/Infinity — an unmeasured/zero DOM node) falls back to the default.
    expect(childOf(splitBeside(base, 'group:1', 'right', 'group:2', NaN)).basis).toBe(DEFAULT_SPLIT_BASIS.row)
    expect(childOf(splitBeside(base, 'group:1', 'right', 'group:2', Infinity)).basis).toBe(DEFAULT_SPLIT_BASIS.row)
    // No basis (geometry-free callers / tests) → the default strip basis.
    expect(childOf(splitBeside(base, 'group:1', 'right', 'group:2')).basis).toBe(DEFAULT_SPLIT_BASIS.row)
  })

  it('splitBeside is a no-op when the target is absent', () => {
    const base = layoutWith(group('group:1', []))
    expect(splitBeside(base, 'nope', 'right', 'group:2')).toEqual(base)
  })

  it('closeGroup removes the group and collapses the surrounding split', () => {
    const base = layoutWith(group('group:1', [ed('editor:1', 'a.ts')], 'editor:1'))
    const split = splitBeside(base, 'group:1', 'right', 'group:2')
    const closed = closeGroup(split, 'group:2')
    const ids = collectIds(closed.desktop)
    expect(ids.has('group:2')).toBe(false)
    expect(ids.has('group:1')).toBe(true)
    // surrounding split:group:2 collapsed away
    expect(hasNode(closed.desktop, 'split:group:2')).toBe(false)
  })

  it('closeGroup on the last group leaves exactly one empty group (ensureCenterGroup)', () => {
    const base = layoutWith(group('group:1', [ed('editor:1', 'a.ts')], 'editor:1'))
    const closed = closeGroup(base, 'group:1')
    const gid = firstGroupId(closed.desktop)
    expect(gid).toBeTruthy()
    expect(tabsInGroup(closed.desktop, gid!)).toEqual([])
  })

  it('ensureCenterGroup grafts an empty group into the center when none exists', () => {
    // A RAW (un-normalized) desktop with no group anywhere — the funnel always
    // canonicalizes a center group in, so this is the only way to observe the graft.
    const noGroup: WorkspacePanelLayout = {
      ...defaultWorkspacePanelLayout(),
      desktop: { kind: 'leaf', id: 'files', panel: 'files' },
    }
    expect(firstCenterGroupId(centerOf(noGroup.desktop))).toBeNull()
    const ensured = ensureCenterGroup(noGroup)
    const gid = firstCenterGroupId(centerOf(ensured.desktop))
    expect(gid).toBeTruthy()
    expect(tabsInGroup(ensured.desktop, gid!)).toEqual([])
    // already-has-a-center-group is a no-op (returns the same layout)
    expect(ensureCenterGroup(ensured)).toBe(ensured)
  })

  it('closeGroup of the last CENTER group keeps an empty center; a right-sidebar group is NOT promoted', () => {
    const base = layoutWith({
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: group('center', [ed('e1', 'a.ts')], 'e1') },
        { node: group('right', [term('t1')], 't1') }, // a right-sidebar terminal group
      ],
    })
    // Precondition: the right group really is the right region (not the center).
    expect(asTabs(centerOf(base.desktop)!).id).toBe('center')
    expect(asTabs(regionsOf(base.desktop).right!).id).toBe('right')

    const closed = closeGroup(base, 'center')
    const { center, right } = regionsOf(closed.desktop)
    // The center stays a (now empty) group; the right terminal group is untouched.
    expect(center).not.toBeNull()
    expect(asTabs(center!).tabs).toEqual([])
    expect(right).not.toBeNull()
    expect(terminalTabsInGroup(closed.desktop, asTabs(right!).id).map((t) => t.instanceId)).toEqual(['t1'])
  })

  it('closeGroup of an EMPTY last center group promotes the right group and keeps right docks right', () => {
    const base = layoutWith({
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: group('center', [], '') },
        {
          basis: 280,
          node: {
            kind: 'split', id: 'activity', axis: 'col', children: [
              { basis: 160, node: { kind: 'leaf', id: 'sessions', panel: 'sessions' } },
              { grow: true, node: group('right', [term('t1'), term('t2')], 't1') },
            ],
          },
        },
      ],
    })

    const closed = closeGroup(base, 'center')
    const { center, right } = regionsOf(closed.desktop)
    expect(asTabs(center!).id).toBe('right')
    expect(terminalTabsInGroup(closed.desktop, 'right').map((t) => t.instanceId)).toEqual(['t1', 't2'])
    expect(collectLeafPanels(right!)).toEqual(['sessions'])
  })

  it('mapGroup edits a group purely and re-normalizes', () => {
    const base = layoutWith(group('group:1', [ed('editor:1', 'a.ts')], 'editor:1'))
    const next = mapGroup(base, 'group:1', (g) => ({
      ...g,
      tabs: [...g.tabs, { instanceId: 'editor:2', kind: 'editor', tabId: 'b.ts' }],
      activeTab: 'editor:2',
    }))
    expect(tabsInGroup(next.desktop, 'group:1').map((t) => t.instanceId)).toEqual(['editor:1', 'editor:2'])
    expect(asTabs(tabsNode(next.desktop, 'group:1')).activeTab).toBe('editor:2')
  })
})

function findSplitContaining(node: LayoutNode, childGroupId: string): SplitNode {
  let hit: SplitNode | null = null
  const walk = (n: LayoutNode) => {
    if (n.kind === 'split') {
      if (n.children.some((c) => c.node.kind === 'tabs' && c.node.id === childGroupId)) hit = n
      n.children.forEach((c) => walk(c.node))
    }
  }
  walk(node)
  if (!hit) throw new Error(`no split containing ${childGroupId}`)
  return hit
}
function hasNode(node: LayoutNode, id: string): boolean {
  if (node.id === id) return true
  if (node.kind === 'split') return node.children.some((c) => hasNode(c.node, id))
  return false
}

// --- normalizeRegions (the root region canonicalizer) -----------------------

describe('normalizeRegions — left/center/right canonicalizer', () => {
  const leaf = (panel: string) => ({ kind: 'leaf', id: panel, panel })
  // A split child: a bare node is wrapped to `{ node }`; an explicit `{ node, grow,
  // basis, hidden }` passes through.
  const wrap = (c: unknown) => (c && typeof c === 'object' && 'node' in c ? c : { node: c })
  const rowOf = (id: string, children: unknown[]) => ({ kind: 'split', id, axis: 'row', children: children.map(wrap) })
  const colOf = (id: string, children: unknown[]) => ({ kind: 'split', id, axis: 'col', children: children.map(wrap) })

  /** Every visible grow child of the root row. The region invariant: exactly one. */
  const visibleGrow = (root: LayoutNode): SplitChild[] =>
    asSplit(root).children.filter((c) => c.grow === true && c.hidden !== true)

  /** Assert the output is a canonical region row with one visible grow center, and
   *  re-normalizing is a no-op. Returns it for further per-case assertions. */
  const canon = (input: unknown): LayoutNode => {
    const out = normalizeRegions(input as LayoutNode)
    expect(out.kind).toBe('split')
    expect(asSplit(out).axis).toBe('row')
    expect(visibleGrow(out)).toHaveLength(1) // exactly one grow child = the center
    expect(normalizeRegions(out)).toEqual(out) // idempotent
    return out
  }

  it('the DEFAULT tree canonicalizes UNCHANGED (no migration)', () => {
    expect(normalizeRegions(defaultDesktopTree())).toEqual(defaultDesktopTree())
    // and through the full funnel
    expect(normalizeDesktopTree(defaultDesktopTree())).toEqual(defaultDesktopTree())
  })

  it('zero-grow: promotes the lone group child to the center', () => {
    const out = canon(rowOf('r', [{ node: leaf('files') }, { node: group('g', [ed('e1', 'a.ts')], 'e1') }]))
    const { left, center, right } = regionsOf(out)
    expect(asTabs(center!).id).toBe('g')
    expect((left as { panel?: string }).panel).toBe('files')
    expect(right).toBeNull()
  })

  it('multi-grow: keeps one center (most groups), demotes sidebars to fixed-basis', () => {
    const out = canon(rowOf('r', [
      { grow: true, node: leaf('files') },
      { grow: true, node: group('center', [ed('e1', 'a.ts')], 'e1') },
      { grow: true, node: leaf('sessions') },
    ]))
    const { left, center, right } = regionsOf(out)
    expect(asTabs(center!).id).toBe('center')
    expect((left as { panel?: string }).panel).toBe('files')
    expect((right as { panel?: string }).panel).toBe('sessions')
  })

  it('hidden-grow center: un-hides + grows the real center', () => {
    const out = canon(rowOf('r', [
      { node: leaf('files') },
      { grow: true, hidden: true, node: group('g', [ed('e1', 'a.ts')], 'e1') },
    ]))
    const centerChild = visibleGrow(out)[0]
    expect(asTabs(centerChild.node).id).toBe('g')
    expect(centerChild.hidden).toBeUndefined() // forced visible
  })

  it('growing sidebar: the center grows, the dock sidebar is fixed', () => {
    const out = canon(rowOf('r', [
      { grow: true, node: leaf('files') }, // a growing DOCK — must not be the center
      { node: group('g', [ed('e1', 'a.ts')], 'e1') },
    ]))
    const { left, center } = regionsOf(out)
    expect(asTabs(center!).id).toBe('g')
    // left is the demoted dock, with no grow flag
    const leftChild = asSplit(out).children[0]
    expect((left as { panel?: string }).panel).toBe('files')
    expect(leftChild.grow).toBeUndefined()
  })

  it('single-center bare node: wraps in a region row (never collapsed)', () => {
    const out = canon(group('only', [ed('e1', 'a.ts')], 'e1'))
    const { left, center, right } = regionsOf(out)
    expect(left).toBeNull()
    expect(right).toBeNull()
    expect(asTabs(center!).id).toBe('only')
  })

  it('no-sidebar: a center-only row stays a one-child region row', () => {
    const out = canon(rowOf('r', [{ grow: true, node: group('g', [], '') }]))
    expect(asSplit(out).children).toHaveLength(1)
    expect(regionsOf(out).left).toBeNull()
    expect(regionsOf(out).right).toBeNull()
  })

  it('all-hidden-root: forces the center visible', () => {
    const out = canon(rowOf('r', [
      { hidden: true, node: leaf('files') },
      { hidden: true, grow: true, node: group('g', [ed('e1', 'a.ts')], 'e1') },
    ]))
    expect(asTabs(regionsOf(out).center!).id).toBe('g')
  })

  it('dock-in-center: relocates the stray dock to the left', () => {
    const out = canon(rowOf('r', [
      { grow: true, node: colOf('mid', [leaf('files'), group('g', [ed('e1', 'a.ts')], 'e1')]) },
    ]))
    const { left, center } = regionsOf(out)
    expect((left as { panel?: string }).panel).toBe('files')
    // no dock survives inside the center
    expect(collectLeafPanels(center!)).toEqual([])
    expect(asTabs(center!).id).toBe('g')
  })

  it('group-in-left: relocates the stray group to the center', () => {
    const out = canon(rowOf('r', [
      { node: colOf('side', [leaf('files'), group('stray', [ed('e9', 'z.ts')], 'e9')]) },
      { grow: true, node: group('center', [ed('e1', 'a.ts')], 'e1') },
    ]))
    const { left, center } = regionsOf(out)
    // left keeps only the dock; the stray group moved into the center
    expect((left as { panel?: string }).panel).toBe('files')
    const centerGroups = collectGroupIds(center!)
    expect(centerGroups).toContain('center')
    expect(centerGroups).toContain('stray')
  })

  it('two-right-groups: merges the 2nd right group into the first', () => {
    const out = canon(rowOf('r', [
      { node: leaf('files') },
      { grow: true, node: group('c', [ed('e1', 'a.ts')], 'e1') },
      { node: group('r1', [ed('e2', 'b.ts')], 'e2') },
      { node: group('r2', [ed('e3', 'c.ts')], 'e3') },
    ]))
    const { right } = regionsOf(out)
    expect(collectGroupIds(right!)).toEqual(['r1']) // exactly one right group (r2 merged away)
    const merged = asTabs(right!)
    expect(merged.tabs.map((t) => t.instanceId)).toEqual(['e2', 'e3']) // both strips, in order
  })

  it('relocates a non-row root into a region row', () => {
    const out = canon(colOf('stack', [leaf('files'), group('g', [ed('e1', 'a.ts')], 'e1')]))
    expect(asSplit(out).axis).toBe('row')
    const { left, center } = regionsOf(out)
    expect((left as { panel?: string }).panel).toBe('files')
    expect(asTabs(center!).id).toBe('g')
  })

  it('an all-hidden sidebar folds into a fixed point (normalize twice == once)', () => {
    // Two hidden pre-center docks fold into one left col. Without the all-hidden
    // repair in foldSidebar, the next normalizeSplit pass un-hides the col's last
    // child and the tree diverges on the second normalize.
    const raw = rowOf('root', [
      { hidden: true, node: leaf('projects') },
      { hidden: true, node: leaf('files') },
      { grow: true, node: group('g', [ed('e1', 'a.ts')], 'e1') },
    ])
    const once = normalizeDesktopTree(raw)
    expect(normalizeDesktopTree(once)).toEqual(once)
    // The folded left col is not all-hidden (its last child was un-hidden).
    const { left } = regionsOf(once)
    expect(asSplit(left!).children.every((c) => c.hidden === true)).toBe(false)
  })
})

/** Every group id under `node`, in document order. */
function collectGroupIds(node: LayoutNode, out: string[] = []): string[] {
  if (node.kind === 'tabs') out.push(node.id)
  else if (node.kind === 'split') node.children.forEach((c) => collectGroupIds(c.node, out))
  return out
}

const dockLeaf = (panel: string) => ({ kind: 'leaf', id: panel, panel })

describe('moveLeafToEdge — root-edge sidebar reveal (HIGH 1 regression)', () => {
  it('creates a RIGHT sidebar holding the dock — NOT evicted back to the left', () => {
    // left col [projects, files] · center group:1 · (no right sidebar)
    const base = layoutWith({
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: { kind: 'split', id: 'dock', axis: 'col', children: [
          { node: dockLeaf('projects') }, { grow: true, node: dockLeaf('files') },
        ] } },
        { grow: true, node: group('group:1', [ed('editor:1', 'src/a.ts')], 'editor:1') },
      ],
    })
    expect(regionsOf(base.desktop).right).toBeNull()
    const out = moveLeafToEdge(base, 'files', 'right')
    const { left, right } = regionsOf(out.desktop)
    // The whole point: a right-edge move lands the dock in the RIGHT region, where
    // `moveLeaf` beside the center would have had the funnel evict it to the left.
    expect(right).not.toBeNull()
    expect(leafPanelsInOrder(right!)).toContain('files')
    expect(leafPanelsInOrder(left!)).toEqual(['projects'])
  })

  it('reveals the LEFT sidebar from a left-edge move (still works)', () => {
    const base = layoutWith({
      kind: 'split', id: 'root', axis: 'row', children: [
        { grow: true, node: group('group:1', [ed('editor:1', 'src/a.ts')], 'editor:1') },
        { node: dockLeaf('sessions') },
      ],
    })
    expect(regionsOf(base.desktop).left).toBeNull()
    const out = moveLeafToEdge(base, 'sessions', 'left')
    const { left, right } = regionsOf(out.desktop)
    expect(left).not.toBeNull()
    expect(leafPanelsInOrder(left!)).toContain('sessions')
    expect(right).toBeNull()
  })

  it('is a no-op for an absent leaf', () => {
    const base = layoutWith({
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: dockLeaf('files') },
        { grow: true, node: group('group:1', [ed('editor:1', 'src/a.ts')], 'editor:1') },
      ],
    })
    expect(moveLeafToEdge(base, 'nope', 'right')).toBe(base)
  })
})

describe('sidebarVisibility — DnD visibility reconcile (HIGH 2 regression)', () => {
  const threeRegions = () => layoutWith({
    kind: 'split', id: 'root', axis: 'row', children: [
      { node: dockLeaf('files') },
      { grow: true, node: group('group:1', [ed('editor:1', 'src/a.ts')], 'editor:1') },
      { node: dockLeaf('sessions') },
    ],
  })

  it('reports both sidebars visible for the default tree', () => {
    expect(sidebarVisibility(defaultDesktopTree())).toEqual({ left: true, right: true })
  })

  it('flips a sidebar flag to hidden when its LAST dock is dragged out (auto-hide)', () => {
    const out = moveLeaf(threeRegions(), 'files', { targetId: 'sessions', side: 'below' })
    expect(regionsOf(out.desktop).left).toBeNull() // left emptied → absent region
    // The exact boolean the provider mirror writes onto showSidebar.
    expect(sidebarVisibility(out.desktop)).toEqual({ left: false, right: true })
  })

  it('flips a sidebar flag to visible on an edge reveal', () => {
    const base = layoutWith({
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: dockLeaf('files') },
        { grow: true, node: group('group:1', [ed('editor:1', 'src/a.ts')], 'editor:1') },
      ],
    })
    expect(sidebarVisibility(base.desktop).right).toBe(false)
    const out = moveLeafToEdge(base, 'files', 'right')
    expect(sidebarVisibility(out.desktop).right).toBe(true)
  })

  it('treats a toggled-HIDDEN sidebar as not visible (distinct from absent)', () => {
    const hidden = layoutWith({
      kind: 'split', id: 'root', axis: 'row', children: [
        { node: dockLeaf('files') },
        { grow: true, node: group('group:1', [ed('editor:1', 'src/a.ts')], 'editor:1') },
        { hidden: true, node: dockLeaf('sessions') },
      ],
    })
    expect(regionsOf(hidden.desktop).right).not.toBeNull() // present in the row...
    expect(sidebarVisibility(hidden.desktop).right).toBe(false) // ...but hidden → not visible
  })
})

describe('moveLeaf — basis preservation on reorder (FIX 1)', () => {
  // The basis of the dock leaf `panel` anywhere in the tree, or undefined.
  const basisOf = (node: LayoutNode, panel: string): number | undefined => {
    if (node.kind === 'split') {
      for (const c of node.children) {
        if (c.node.kind === 'leaf' && c.node.panel === panel) return c.basis
        const hit = basisOf(c.node, panel)
        if (hit !== undefined) return hit
      }
    }
    return undefined
  }
  // left col [projects(120), changes(160), files(grow)] · center group:1 · right sessions(280)
  const sidebarTree = () => layoutWith({
    kind: 'split', id: 'root', axis: 'row', children: [
      { node: { kind: 'split', id: 'dock', axis: 'col', children: [
        { basis: 120, node: dockLeaf('projects') },
        { basis: 160, node: dockLeaf('changes') },
        { grow: true, node: dockLeaf('files') },
      ] } },
      { grow: true, node: group('group:1', [ed('editor:1', 'src/a.ts')], 'editor:1') },
      { basis: 280, node: dockLeaf('sessions') },
    ],
  })

  it('keeps a reordered dock its OWN basis (order changes, size does not)', () => {
    // Move `changes` (basis 160) below `files` within the same left sidebar.
    const out = moveLeaf(sidebarTree(), 'changes', { targetId: 'files', side: 'below' })
    // It kept 160 — NOT snapped to DEFAULT_SPLIT_BASIS.col (180), the old jarring jump.
    expect(basisOf(out.desktop, 'changes')).toBe(160)
    expect(basisOf(out.desktop, 'changes')).not.toBe(DEFAULT_SPLIT_BASIS.col)
    // The undisturbed sibling keeps its basis too.
    expect(basisOf(out.desktop, 'projects')).toBe(120)
  })

  it('carries the dock basis across sidebars (left → right)', () => {
    // Move `projects` (basis 120) beside the right sessions dock. The moved dock keeps
    // its 120; the right sidebar COLUMN keeps its overall 280 width (sessions becomes
    // the column's grow absorber — its 280 rides on the wrapping region child).
    const out = moveLeaf(sidebarTree(), 'projects', { targetId: 'sessions', side: 'below' })
    expect(basisOf(out.desktop, 'projects')).toBe(120)
    const right = regionsOf(out.desktop).right!
    const rightChild = asSplit(out.desktop).children.find((c) => c.node.id === right.id)
    expect(rightChild?.basis).toBe(280) // the right region column width is unchanged
  })

  it('a grow (basis-less) dock takes the default when moved', () => {
    // `files` is the grow child (no basis); moving it gives it the default strip.
    const out = moveLeaf(sidebarTree(), 'files', { targetId: 'projects', side: 'above' })
    expect(basisOf(out.desktop, 'files')).toBe(DEFAULT_SPLIT_BASIS.col)
  })
})
