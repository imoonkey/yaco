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
  normalizeLayout,
  firstGroupId,
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
  ensureFirstGroup,
  mapGroup,
  resolveActiveEditor,
  resolveActiveTerminal,
} from '../panelLayoutModel'
import type { LayoutNode, SplitNode, TabsNode, WorkspacePanelLayout } from '../../hooks/workspaceTypes'

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
    const tree = normalizeDesktopTree(group('group:1', []))
    const g = asTabs(tree)
    expect(g.kind).toBe('tabs')
    expect(g.tabs).toEqual([])
    expect(g.activeTab).toBe('')
  })

  it('preserves valid editor tabs and drops only malformed ones', () => {
    const tree = normalizeDesktopTree(group('group:1', [
      ed('editor:1', 'a.ts'),
      { instanceId: 'editor:2', kind: 'editor' }, // malformed: no tabId
      { instanceId: 'x', kind: 'bogus' }, // malformed: bad kind
      ed('editor:3', 'b.ts'),
    ], 'editor:1'))
    const g = asTabs(tree)
    expect(g.tabs.map((t) => t.instanceId)).toEqual(['editor:1', 'editor:3'])
    expect(g.tabs.map((t) => (t.kind === 'editor' ? t.tabId : null))).toEqual(['a.ts', 'b.ts'])
  })

  it('re-ids a duplicate instanceId, keeping its tabId/preview/pinned payload', () => {
    const tree = normalizeDesktopTree(group('group:1', [
      ed('editor:1', 'a.ts'),
      ed('editor:1', 'b.ts', { pinned: true }), // duplicate id
    ], 'editor:1'))
    const g = asTabs(tree)
    expect(g.tabs).toHaveLength(2)
    const [first, second] = g.tabs
    expect(first.instanceId).toBe('editor:1')
    expect(second.instanceId).not.toBe('editor:1')
    expect(second.kind === 'editor' && second.tabId).toBe('b.ts')
    expect(second.kind === 'editor' && second.pinned).toBe(true)
  })

  it('keeps exactly one preview editor tab (first in document order wins)', () => {
    const tree = normalizeDesktopTree(group('group:1', [
      ed('editor:1', 'a.ts', { preview: true }),
      ed('editor:2', 'b.ts', { preview: true }),
    ], 'editor:1'))
    const g = asTabs(tree)
    expect(g.tabs.filter((t) => t.kind === 'editor' && t.preview)).toHaveLength(1)
    expect(g.tabs[0].kind === 'editor' && g.tabs[0].preview).toBe(true)
    expect(g.tabs[1].kind === 'editor' && g.tabs[1].preview).toBeUndefined()
  })

  it('clamps activeTab to a surviving tab, following re-ids; empties to ""', () => {
    const dropped = normalizeDesktopTree(group('group:1', [ed('editor:1', 'a.ts')], 'gone'))
    expect(asTabs(dropped).activeTab).toBe('editor:1') // fell back to first

    const empty = normalizeDesktopTree(group('group:1', []))
    expect(asTabs(empty).activeTab).toBe('')

    // active follows the re-id of a duplicate
    const reId = normalizeDesktopTree(group('group:1', [
      ed('editor:1', 'a.ts'),
      ed('editor:1', 'b.ts'),
    ], 'editor:1'))
    expect(asTabs(reId).activeTab).toBe('editor:1') // first occurrence kept the id
  })

  it('mixes editor + terminal tabs in one strip in order', () => {
    const tree = normalizeDesktopTree(group('group:1', [
      ed('editor:1', 'a.ts'), term('terminal:1'), ed('editor:2', 'b.ts'),
    ], 'terminal:1'))
    const g = asTabs(tree)
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

describe('splitBeside / closeGroup / ensureFirstGroup / mapGroup', () => {
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

  it('closeGroup on the last group leaves exactly one empty group (ensureFirstGroup)', () => {
    const base = layoutWith(group('group:1', [ed('editor:1', 'a.ts')], 'editor:1'))
    const closed = closeGroup(base, 'group:1')
    const gid = firstGroupId(closed.desktop)
    expect(gid).toBeTruthy()
    expect(tabsInGroup(closed.desktop, gid!)).toEqual([])
  })

  it('ensureFirstGroup grafts an empty group when none exists', () => {
    const noGroup: WorkspacePanelLayout = {
      ...defaultWorkspacePanelLayout(),
      desktop: normalizeDesktopTree({
        kind: 'split', id: 'root', axis: 'row', children: [
          { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        ],
      }),
    }
    expect(firstGroupId(noGroup.desktop)).toBeNull()
    const ensured = ensureFirstGroup(noGroup)
    const gid = firstGroupId(ensured.desktop)
    expect(gid).toBeTruthy()
    expect(tabsInGroup(ensured.desktop, gid!)).toEqual([])
    // already-has-a-group is a no-op (returns the same layout)
    expect(ensureFirstGroup(ensured)).toBe(ensured)
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
