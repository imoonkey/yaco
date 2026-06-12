// Unit tests for the multi-instance panel model (mi-model). The model is pure
// data/logic, so these run without a DOM. They pin the whitelist relaxation
// (editor/terminal may appear N times, dedup by id; non-whitelisted stay single),
// the reserved home-editor id, and the id-addressed structural ops
// (newInstanceId / splitBeside / closeLeaf / moveLeaf / *InstancesInOrder /
// resolveActive*). Idempotency is asserted alongside each structural edit.
import { describe, it, expect } from 'vitest'
import {
  MAIN_TABS_ID,
  HOME_EDITOR_ID,
  MULTI_INSTANCE_PANELS,
  isMulti,
  DEFAULT_SPLIT_BASIS,
  defaultDesktopTree,
  defaultWorkspacePanelLayout,
  normalizeDesktopTree,
  normalizeLayout,
  newInstanceId,
  splitBeside,
  closeLeaf,
  moveLeaf,
  editorInstancesInOrder,
  terminalInstancesInOrder,
  resolveActiveEditor,
  resolveActiveTerminal,
} from '../panelLayoutModel'
import type { LayoutNode, SplitNode, TabsNode, LeafNode, WorkspacePanelLayout } from '../../hooks/workspaceTypes'

// --- Narrowing helpers ------------------------------------------------------

function asSplit(node: LayoutNode): SplitNode {
  if (node.kind !== 'split') throw new Error(`expected split, got ${node.kind}`)
  return node
}
function asTabs(node: LayoutNode): TabsNode {
  if (node.kind !== 'tabs') throw new Error(`expected tabs, got ${node.kind}`)
  return node
}
function asLeaf(node: LayoutNode): LeafNode {
  if (node.kind !== 'leaf') throw new Error(`expected leaf, got ${node.kind}`)
  return node
}

/** Collect every leaf node (id + panel) in document order. */
function leaves(node: LayoutNode, out: LeafNode[] = []): LeafNode[] {
  if (node.kind === 'leaf') out.push(node)
  else if (node.kind === 'split') for (const c of node.children) leaves(c.node, out)
  return out
}

function findLeaf(node: LayoutNode, id: string): LeafNode | null {
  return leaves(node).find((l) => l.id === id) ?? null
}

/** A layout with the default tree plus an extra editor leaf and an extra terminal
 *  leaf — the canonical multi-instance shape the ops act on. */
function multiLayout(): WorkspacePanelLayout {
  return normalizeLayout({
    desktop: {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
        { node: { kind: 'leaf', id: 'editor:2', panel: 'editor' } },
        { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } },
        { node: { kind: 'leaf', id: 'terminal:2', panel: 'terminal' } },
      ],
    },
  })
}

// --- Whitelist + guards -----------------------------------------------------

describe('multi-instance whitelist', () => {
  it('whitelists exactly editor + terminal', () => {
    expect([...MULTI_INSTANCE_PANELS].sort()).toEqual(['editor', 'terminal'])
    expect(isMulti('editor')).toBe(true)
    expect(isMulti('terminal')).toBe(true)
    for (const p of ['projects', 'files', 'changes', 'sessions', 'tasks'] as const) {
      expect(isMulti(p)).toBe(false)
    }
  })

  it('reserves the home editor id', () => {
    expect(HOME_EDITOR_ID).toBe('editor')
  })
})

// --- Normalization: multiple whitelisted leaves survive ----------------------

describe('normalization keeps multiple editor/terminal instances', () => {
  it('keeps two terminal leaves (dedup by id, not type)', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } },
        { node: { kind: 'leaf', id: 'terminal:2', panel: 'terminal' } },
      ],
    }))
    expect(root.children.map((c) => asLeaf(c.node).id)).toEqual(['terminal', 'terminal:2'])
  })

  it('re-ids a terminal leaf whose id collides, keeping both panes', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } },
        { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } }, // id collision → re-id
      ],
    }))
    expect(root.children).toHaveLength(2)
    expect(root.children.map((c) => asLeaf(c.node).panel)).toEqual(['terminal', 'terminal'])
    const ids = root.children.map((c) => asLeaf(c.node).id)
    expect(ids[0]).toBe('terminal')
    expect(ids[1]).toBe('terminal:2') // fresh secondary id
    expect(new Set(ids).size).toBe(2) // unique
  })

  it('keeps the home editor (tabs) AND a secondary editor leaf side by side', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
        { node: { kind: 'leaf', id: 'editor:2', panel: 'editor' } },
      ],
    }))
    expect(root.children).toHaveLength(2)
    expect(asTabs(root.children[0].node).panels).toEqual(['editor', 'tasks'])
    expect(asLeaf(root.children[1].node)).toMatchObject({ id: 'editor:2', panel: 'editor' })
  })
})

// --- Home editor id is reserved, order-independent ---------------------------

describe('home editor id reservation', () => {
  it("re-ids an editor leaf claiming 'editor' that appears AFTER the main node", () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
        { node: { kind: 'leaf', id: 'editor', panel: 'editor' } }, // claims home id → re-id
      ],
    }))
    expect(asTabs(root.children[0].node).panels).toContain('editor') // home keeps 'editor'
    expect(asLeaf(root.children[1].node).panel).toBe('editor')
    expect(asLeaf(root.children[1].node).id).not.toBe('editor') // re-id'd to a secondary
  })

  it("re-ids an editor leaf claiming 'editor' that appears BEFORE the main node", () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'editor', panel: 'editor' } }, // claims home id → re-id
        { node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
      ],
    }))
    // The home editor's 'editor' id survives in the main tabs node regardless of order.
    expect(asTabs(root.children[1].node).panels).toContain('editor')
    expect(asLeaf(root.children[0].node).panel).toBe('editor')
    expect(asLeaf(root.children[0].node).id).not.toBe('editor')
  })

  it('drops a stray editor entry from a tabs node', () => {
    // terminal has no id slot in a tabs array → dropped; editor (home) stays.
    const tabs = asTabs(normalizeDesktopTree({
      kind: 'tabs', id: MAIN_TABS_ID, active: 'terminal', panels: ['editor', 'terminal', 'tasks'], chrome: 'none',
    }))
    expect(tabs.panels).toEqual(['editor', 'tasks'])
    expect(tabs.active).toBe('editor') // invalid active (dropped terminal) → first panel
  })

  it("strips an `editor` tabs entry from a NON-main node, before or after main", () => {
    // A stray editor tabs node ordered BEFORE main must not steal the 'editor' id;
    // the home editor survives in MAIN_TABS regardless of traversal order.
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'tabs', id: 'stray', active: 'editor', panels: ['editor', 'changes'], chrome: 'none' } },
        { grow: true, node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
      ],
    }))
    // editor stripped from the stray node (it folds to a `changes` leaf); the home
    // editor survives in main; there is exactly one editor instance (the home).
    expect(editorInstancesInOrder(root)).toEqual(['editor'])
    const main = root.children.map((c) => c.node).find((n) => n.kind === 'tabs' && n.id === MAIN_TABS_ID)
    expect(asTabs(main!).panels).toContain('editor')
  })

  it('prepends the home editor to a main node that lost it (always contains the home)', () => {
    const tabs = asTabs(normalizeDesktopTree({
      kind: 'tabs', id: MAIN_TABS_ID, active: 'tasks', panels: ['tasks'], chrome: 'none',
    }))
    expect(tabs.panels).toEqual(['editor', 'tasks'])
    expect(tabs.active).toBe('tasks') // valid active preserved
  })

  it('drops a second editor entry inside a single tabs node (dedup by type-as-id)', () => {
    const tabs = asTabs(normalizeDesktopTree({
      kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'editor', 'tasks'], chrome: 'none',
    }))
    expect(tabs.panels).toEqual(['editor', 'tasks'])
  })

  it('a dropped singleton id-collision does not block a later valid same-type leaf', () => {
    // Corrupt: a 'files' leaf claiming the reserved 'tasks' id collides and drops,
    // but a subsequent well-formed 'files' leaf must still survive (the type is
    // only marked seen when a leaf is kept).
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
        { node: { kind: 'leaf', id: 'tasks', panel: 'files' } }, // id collides with the tasks entry → drop
        { node: { kind: 'leaf', id: 'files', panel: 'files' } }, // valid → survives
      ],
    }))
    const filesLeaves = leaves(root).filter((l) => l.panel === 'files')
    expect(filesLeaves).toHaveLength(1)
    expect(filesLeaves[0].id).toBe('files')
  })
})

// --- Idempotency on multi-instance trees ------------------------------------

describe('multi-instance normalization is idempotent', () => {
  it('round-trips a tree with two editors and two terminals', () => {
    const messy = {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
        { node: { kind: 'leaf', id: 'editor', panel: 'editor' } }, // re-id
        { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } },
        { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } }, // re-id
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
      ],
    }
    const once = normalizeDesktopTree(messy)
    const twice = normalizeDesktopTree(once)
    expect(twice).toEqual(once)
    // All ids unique after one pass.
    const ids = leaves(once).map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// --- newInstanceId ----------------------------------------------------------

describe('newInstanceId', () => {
  it('uses the base id for the first terminal when free, then secondaries', () => {
    const noTerminal: LayoutNode = {
      kind: 'split', id: 'root', axis: 'row',
      children: [{ node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } }],
    }
    expect(newInstanceId(noTerminal, 'terminal')).toBe('terminal')

    const tree = multiLayout().desktop // already has terminal + terminal:2
    expect(newInstanceId(tree, 'terminal')).toBe('terminal:3')
  })

  it('never reuses the reserved editor id (always a secondary)', () => {
    expect(newInstanceId(defaultDesktopTree(), 'editor')).toBe('editor:2')
    expect(newInstanceId(multiLayout().desktop, 'editor')).toBe('editor:3') // editor + editor:2 present
  })
})

// --- splitBeside ------------------------------------------------------------

describe('splitBeside', () => {
  it('splits a new editor beside the MAIN_TABS node (home editor split)', () => {
    const next = splitBeside(defaultWorkspacePanelLayout(), MAIN_TABS_ID, 'editor', 'right', 'editor:2')
    const newLeaf = findLeaf(next.desktop, 'editor:2')
    expect(newLeaf).toMatchObject({ panel: 'editor' })
    // The home editor (tasks beside it) stays intact in its tabs node.
    expect(editorInstancesInOrder(next.desktop)).toEqual(['editor', 'editor:2'])
    expect(normalizeLayout(next)).toEqual(next) // already normalized
  })

  it('splits a new terminal beside a leaf, on the requested side/axis', () => {
    const next = splitBeside(multiLayout(), 'terminal', 'terminal', 'below', 'terminal:3')
    const leaf = findLeaf(next.desktop, 'terminal:3')
    expect(leaf).toMatchObject({ panel: 'terminal' })
    expect(terminalInstancesInOrder(next.desktop)).toContain('terminal:3')
  })

  it('gives the inserted pane a fixed basis and lets the target keep growing', () => {
    const next = splitBeside(defaultWorkspacePanelLayout(), MAIN_TABS_ID, 'editor', 'right', 'editor:2')
    const wrap = asSplit(findWrappingSplit(next.desktop, 'editor:2'))
    const inserted = wrap.children.find((c) => c.node.kind === 'leaf' && asLeaf(c.node).id === 'editor:2')!
    const target = wrap.children.find((c) => c.node.kind === 'tabs')!
    // Inserted pane gets a fixed basis (clamped up to the editor's registry min);
    // the wrapped home-editor node keeps growing.
    expect(inserted.basis).toBeGreaterThanOrEqual(DEFAULT_SPLIT_BASIS.row)
    expect(target.grow).toBe(true)
  })

  it('is a no-op when the target node id is absent', () => {
    const base = defaultWorkspacePanelLayout()
    expect(splitBeside(base, 'ghost-node', 'editor', 'right', 'editor:2')).toEqual(base)
  })
})

/** Find the split node that directly contains the leaf with id `id`. */
function findWrappingSplit(node: LayoutNode, id: string): SplitNode {
  if (node.kind === 'split') {
    if (node.children.some((c) => c.node.kind === 'leaf' && c.node.id === id)) return node
    for (const c of node.children) {
      try { return findWrappingSplit(c.node, id) } catch { /* keep searching */ }
    }
  }
  throw new Error(`no split wraps ${id}`)
}

// --- closeLeaf --------------------------------------------------------------

describe('closeLeaf', () => {
  it('removes a secondary editor leaf and collapses the hole', () => {
    const next = closeLeaf(multiLayout(), 'editor:2')
    expect(findLeaf(next.desktop, 'editor:2')).toBeNull()
    expect(editorInstancesInOrder(next.desktop)).toEqual(['editor']) // home survives
    expect(normalizeLayout(next)).toEqual(next)
  })

  it('removes one of two terminals, leaving the other', () => {
    const next = closeLeaf(multiLayout(), 'terminal:2')
    expect(terminalInstancesInOrder(next.desktop)).toEqual(['terminal'])
  })

  it('is value-stable (re-normalizes) for an unknown id', () => {
    const base = multiLayout()
    expect(closeLeaf(base, 'ghost')).toEqual(base)
  })

  it('never tears out a split/tabs node whose id collides with the instance id', () => {
    // A (corrupt) split node carrying an instance-shaped id must not be removed
    // by closeLeaf — only leaves are closable.
    const layout = normalizeLayout({
      desktop: {
        kind: 'split', id: 'root', axis: 'row',
        children: [
          { node: { kind: 'split', id: 'terminal:2', axis: 'col', children: [
            { grow: true, node: { kind: 'leaf', id: 'files', panel: 'files' } },
          ] } },
          { grow: true, node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
        ],
      },
    })
    expect(closeLeaf(layout, 'terminal:2')).toEqual(layout) // split id collision → no-op
    expect(closeLeaf(layout, MAIN_TABS_ID)).toEqual(layout) // tabs id → no-op (home not closable)
  })
})

// --- moveLeaf ---------------------------------------------------------------

describe('moveLeaf', () => {
  it('moves a secondary editor beside another node, preserving its id', () => {
    const next = moveLeaf(multiLayout(), 'editor:2', { targetId: 'files', side: 'below' })
    const moved = findLeaf(next.desktop, 'editor:2')
    expect(moved).toMatchObject({ id: 'editor:2', panel: 'editor' })
    // editor:2 now sits beside files (a col split), not in its old slot.
    expect(editorInstancesInOrder(next.desktop).sort()).toEqual(['editor', 'editor:2'])
    expect(normalizeLayout(next)).toEqual(next)
  })

  it('is a no-op when the moving leaf is absent', () => {
    const base = multiLayout()
    expect(moveLeaf(base, 'ghost', { targetId: 'files', side: 'below' })).toEqual(base)
  })

  it('is a no-op when the placement target is absent (never drops the pane)', () => {
    const base = multiLayout()
    const next = moveLeaf(base, 'editor:2', { targetId: 'ghost', side: 'below' })
    expect(next).toEqual(base) // editor:2 still present, unchanged
    expect(findLeaf(next.desktop, 'editor:2')).not.toBeNull()
  })
})

// --- *InstancesInOrder + resolveActive* -------------------------------------

describe('editorInstancesInOrder / terminalInstancesInOrder', () => {
  it('lists editors in document order, home editor included at its node', () => {
    expect(editorInstancesInOrder(multiLayout().desktop)).toEqual(['editor', 'editor:2'])
  })

  it('lists terminals in document order', () => {
    expect(terminalInstancesInOrder(multiLayout().desktop)).toEqual(['terminal', 'terminal:2'])
  })

  it('default tree has exactly the home editor and the structural terminal', () => {
    expect(editorInstancesInOrder(defaultDesktopTree())).toEqual(['editor'])
    expect(terminalInstancesInOrder(defaultDesktopTree())).toEqual(['terminal'])
  })
})

describe('resolveActiveEditor / resolveActiveTerminal', () => {
  const tree = multiLayout().desktop

  it('returns the most-recently-focused live instance (MRU head)', () => {
    expect(resolveActiveEditor(tree, ['editor:2', 'editor'])).toBe('editor:2')
    expect(resolveActiveTerminal(tree, ['terminal:2'])).toBe('terminal:2')
  })

  it('skips dead MRU entries and falls back to first in document order', () => {
    expect(resolveActiveEditor(tree, ['ghost', 'editor:2'])).toBe('editor:2')
    expect(resolveActiveEditor(tree, [])).toBe('editor') // first in order
    expect(resolveActiveEditor(tree, ['dead-only'])).toBe('editor')
  })

  it('always resolves an editor (home is structural) but terminal may be null', () => {
    const noTerminal = defaultDesktopTree() // has a terminal; remove it
    const closed = closeLeaf({ ...defaultWorkspacePanelLayout(), desktop: noTerminal }, 'terminal').desktop
    expect(resolveActiveEditor(closed, [])).toBe('editor')
    expect(resolveActiveTerminal(closed, [])).toBeNull()
    expect(resolveActiveTerminal(closed, ['terminal'])).toBeNull() // dead binding → null
  })
})

// --- defaultDesktopTree unchanged -------------------------------------------

describe('defaults are unchanged by the multi-instance relaxation', () => {
  it('normalization leaves the default tree byte-identical', () => {
    expect(normalizeDesktopTree(defaultDesktopTree())).toEqual(defaultDesktopTree())
    expect(normalizeLayout(defaultWorkspacePanelLayout())).toEqual(defaultWorkspacePanelLayout())
  })
})
