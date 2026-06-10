// Unit tests for the panel layout model (T4a). The model is pure data/logic, so
// these run without a DOM. They pin every normalization invariant, duplicate /
// malformed repair, registry min-size clamping, and idempotency (round-trip).
import { describe, it, expect } from 'vitest'
import {
  PANEL_IDS,
  isPanelId,
  MOBILE_DOCKS,
  isMobileDock,
  DEFAULT_MIN_SIZE,
  MAIN_TABS_ID,
  DEFAULT_MOBILE_DOCK,
  defaultDesktopTree,
  defaultPanelState,
  defaultWorkspacePanelLayout,
  normalizeDesktopTree,
  normalizeLayout,
} from '../panelLayoutModel'
import type { LayoutNode, SplitNode, TabsNode, LeafNode } from '../../hooks/workspaceTypes'

// --- Narrowing helpers (keep assertions readable + type-safe) ---------------

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

function leaf(panel: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'leaf', id: panel, panel, ...extra }
}

// --- Guards + canonical sets ------------------------------------------------

describe('panel id / mobile dock guards', () => {
  it('recognizes exactly the seven canonical panel ids', () => {
    expect([...PANEL_IDS].sort()).toEqual(
      ['changes', 'editor', 'files', 'projects', 'sessions', 'tasks', 'terminal'],
    )
    for (const id of PANEL_IDS) expect(isPanelId(id)).toBe(true)
    for (const bad of ['', 'nope', 'Editor', null, 42, undefined, {}]) {
      expect(isPanelId(bad)).toBe(false)
    }
  })

  it('recognizes the four mobile docks', () => {
    expect([...MOBILE_DOCKS]).toEqual(['browse', 'editor', 'tasks', 'terminal'])
    for (const d of MOBILE_DOCKS) expect(isMobileDock(d)).toBe(true)
    for (const bad of ['files', 'Browse', null, 0]) expect(isMobileDock(bad)).toBe(false)
  })
})

// --- Defaults ---------------------------------------------------------------

describe('default trees', () => {
  it('builds the three-region desktop tree', () => {
    const root = asSplit(defaultDesktopTree())
    expect(root.axis).toBe('row')
    expect(root.children).toHaveLength(3)

    const [dock, main, activity] = root.children
    expect(dock.basis).toBe(220)
    expect(asSplit(dock.node).id).toBe('dock')
    expect(main.grow).toBe(true)
    expect(asTabs(main.node).id).toBe(MAIN_TABS_ID)
    expect(asTabs(main.node).panels).toEqual(['editor', 'tasks'])
    expect(activity.basis).toBe(420)
    expect(asSplit(activity.node).id).toBe('activity')
  })

  it('default panel layout uses the browse dock + tree file mode', () => {
    const layout = defaultWorkspacePanelLayout()
    expect(layout.version).toBe(1)
    expect(layout.mobile.activeDock).toBe(DEFAULT_MOBILE_DOCK)
    expect(layout.panelState).toEqual(defaultPanelState())
  })

  it('normalization leaves the default tree unchanged (it is already canonical)', () => {
    expect(normalizeDesktopTree(defaultDesktopTree())).toEqual(defaultDesktopTree())
    expect(normalizeLayout(defaultWorkspacePanelLayout())).toEqual(defaultWorkspacePanelLayout())
  })
})

// --- Single-occurrence (duplicate-id repair) --------------------------------

describe('single-occurrence invariant', () => {
  it('keeps the first occurrence of a duplicate panel and drops the rest', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: leaf('files') },
        { node: leaf('files') }, // duplicate → dropped
        { node: leaf('editor') },
      ],
    }))
    expect(root.children).toHaveLength(2)
    expect(asLeaf(root.children[0].node).panel).toBe('files')
    expect(asLeaf(root.children[1].node).panel).toBe('editor')
  })

  it('counts a panel inside a tabs node as an occurrence', () => {
    // editor appears in the tabs node first, so the later editor leaf is dropped.
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
        { node: leaf('editor') }, // duplicate of the tabs editor → dropped
        { node: leaf('files') },
      ],
    }))
    expect(root.children).toHaveLength(2)
    expect(asTabs(root.children[0].node).panels).toEqual(['editor', 'tasks'])
    expect(asLeaf(root.children[1].node).panel).toBe('files')
  })

  it('drops duplicated panels within a single tabs node', () => {
    const tabs = asTabs(normalizeDesktopTree({
      kind: 'tabs', id: MAIN_TABS_ID, active: 'tasks',
      panels: ['editor', 'editor', 'tasks'], chrome: 'none',
    }))
    expect(tabs.panels).toEqual(['editor', 'tasks'])
    expect(tabs.active).toBe('tasks')
  })
})

// --- Malformed-tree repair --------------------------------------------------

describe('malformed-tree repair', () => {
  it('falls back to the default tree for non-object / unknown-kind roots', () => {
    for (const bad of [null, undefined, 42, 'leaf', {}, { kind: 'bogus' }, []]) {
      expect(normalizeDesktopTree(bad)).toEqual(defaultDesktopTree())
    }
  })

  it('drops leaves with an unknown panel id', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: leaf('ghost') }, // unknown → dropped
        { node: leaf('files') },
        { node: leaf('editor') },
      ],
    }))
    expect(root.children.map((c) => asLeaf(c.node).panel)).toEqual(['files', 'editor'])
  })

  it('drops malformed split children (non-objects, bad kinds)', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        null,
        { node: { kind: 'mystery' } },
        'garbage',
        { node: leaf('files') },
        { node: leaf('editor') },
      ],
    }))
    expect(root.children.map((c) => asLeaf(c.node).panel)).toEqual(['files', 'editor'])
  })

  it('removes an empty tabs node and collapses a one-panel tabs node to a leaf', () => {
    // empty tabs → null → its sole-parent split collapses to the surviving child
    const emptyParent = normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'tabs', id: 'extra', active: 'editor', panels: [], chrome: 'none' } },
        { node: leaf('files') },
      ],
    })
    expect(asLeaf(emptyParent).panel).toBe('files')

    // one-panel, non-reserved tabs → leaf
    const collapsed = normalizeDesktopTree({
      kind: 'tabs', id: 'extra', active: 'editor', panels: ['editor'], chrome: 'none',
    })
    expect(asLeaf(collapsed)).toMatchObject({ kind: 'leaf', panel: 'editor' })
  })

  it('keeps the reserved main tabs node a tabs node even with one panel', () => {
    const node = normalizeDesktopTree({
      kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor'], chrome: 'none',
    })
    expect(asTabs(node)).toMatchObject({ kind: 'tabs', id: MAIN_TABS_ID, panels: ['editor'] })
  })

  it('repairs an invalid tabs active to the first panel and invalid chrome to none', () => {
    const tabs = asTabs(normalizeDesktopTree({
      kind: 'tabs', id: MAIN_TABS_ID, active: 'ghost', panels: ['editor', 'tasks'], chrome: 'weird',
    }))
    expect(tabs.active).toBe('editor')
    expect(tabs.chrome).toBe('none')
  })

  it('synthesizes ids for nodes that lack them', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', axis: 'row',
      children: [{ node: { kind: 'leaf', panel: 'files' } }, { node: { kind: 'leaf', panel: 'editor' } }],
    }))
    expect(root.id).toMatch(/^split-\d+$/)
    expect(asLeaf(root.children[0].node).id).toMatch(/^leaf-\d+$/)
  })

  it('collapses a single-child split into its child, keeping the parent slot basis', () => {
    const node = normalizeDesktopTree({
      kind: 'split', id: 'outer', axis: 'row',
      children: [{ basis: 300, node: { kind: 'split', id: 'inner', axis: 'col', children: [{ grow: true, node: leaf('files') }] } }],
    })
    // outer has one child (inner), inner has one child (files) → fully collapses
    expect(asLeaf(node)).toMatchObject({ kind: 'leaf', panel: 'files' })
  })
})

// --- One grow child + last-child-absorbs-slack ------------------------------

describe('grow-child invariant', () => {
  it('keeps only the first visible grow child', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { grow: true, node: leaf('files') },
        { grow: true, node: leaf('editor') }, // extra grow → cleared
        { grow: true, node: leaf('terminal') }, // extra grow → cleared
      ],
    }))
    expect(root.children.map((c) => c.grow ?? false)).toEqual([true, false, false])
  })

  it('allows zero grow children (last-child-absorbs is a renderer rule)', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { basis: 200, node: leaf('files') },
        { basis: 200, node: leaf('editor') },
      ],
    }))
    expect(root.children.some((c) => c.grow)).toBe(false)
  })

  it('ignores hidden children when picking the visible grow child', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { grow: true, hidden: true, node: leaf('files') }, // hidden grow preserved
        { grow: true, node: leaf('editor') }, // first *visible* grow → kept
        { grow: true, node: leaf('terminal') }, // extra visible grow → cleared
      ],
    }))
    expect(root.children[0]).toMatchObject({ hidden: true, grow: true })
    expect(root.children[1].grow).toBe(true)
    expect(root.children[2].grow ?? false).toBe(false)
  })
})

// --- Hidden preservation ----------------------------------------------------

describe('hidden-child preservation', () => {
  it('keeps hidden children in state (sizes + collapse preserved)', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { hidden: true, basis: 220, node: leaf('files', { collapsed: true }) },
        { grow: true, node: leaf('editor') },
      ],
    }))
    expect(root.children).toHaveLength(2)
    expect(root.children[0]).toMatchObject({ hidden: true, basis: 220 })
    expect(asLeaf(root.children[0].node).collapsed).toBe(true)
  })

  it('reveals the last child when every child is hidden', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { hidden: true, basis: 200, node: leaf('files') },
        { hidden: true, basis: 200, node: leaf('editor') },
      ],
    }))
    expect(root.children[0].hidden).toBe(true)
    expect(root.children[1].hidden ?? false).toBe(false)
  })
})

// --- Min-size clamping ------------------------------------------------------

describe('registry min-size clamping', () => {
  it('clamps an undersized basis up to the axis min (width on a row split)', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { basis: 10, node: leaf('projects') }, // below min width
        { grow: true, node: leaf('files') },
      ],
    }))
    expect(root.children[0].basis).toBe(DEFAULT_MIN_SIZE.width)
  })

  it('clamps against the height min on a column split', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'col',
      children: [
        { basis: 5, node: leaf('sessions') }, // below min height
        { grow: true, node: leaf('terminal') },
      ],
    }))
    expect(root.children[0].basis).toBe(DEFAULT_MIN_SIZE.height)
  })

  it('preserves a basis already above the min', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { basis: 400, node: leaf('projects') },
        { grow: true, node: leaf('files') },
      ],
    }))
    expect(root.children[0].basis).toBe(400)
  })

  it('drops a non-numeric / non-finite basis to undefined', () => {
    const root = asSplit(normalizeDesktopTree({
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { basis: 'wide', node: leaf('projects') },
        { basis: Number.NaN, node: leaf('files') },
        { grow: true, node: leaf('editor') },
      ],
    }))
    expect(root.children[0].basis).toBeUndefined()
    expect(root.children[1].basis).toBeUndefined()
  })
})

// --- Layout-level salvage ---------------------------------------------------

describe('normalizeLayout field salvage', () => {
  it('repairs an invalid mobile dock and editor prefs to defaults, per field', () => {
    const layout = normalizeLayout({
      version: 1,
      desktop: defaultDesktopTree(),
      mobile: { activeDock: 'nonsense' },
      panelState: {
        files: { mode: 'search' },
        editor: { previewMode: 'preview', splitDirection: 'bogus', splitSize: -1, autocompleteEnabled: true },
      },
    })
    expect(layout.mobile.activeDock).toBe(DEFAULT_MOBILE_DOCK)
    expect(layout.panelState.files.mode).toBe('search') // valid → kept
    expect(layout.panelState.editor.previewMode).toBe('preview') // valid → kept
    expect(layout.panelState.editor.splitDirection).toBe('horizontal') // invalid → default
    expect(layout.panelState.editor.splitSize).toBe(defaultPanelState().editor.splitSize) // invalid → default
    expect(layout.panelState.editor.autocompleteEnabled).toBe(true)
  })

  it('fills defaults for a totally empty layout object', () => {
    expect(normalizeLayout({})).toEqual(defaultWorkspacePanelLayout())
  })
})

// --- Idempotency (round-trip) -----------------------------------------------

describe('normalization is idempotent', () => {
  const messyTree = {
    kind: 'split', id: 'root', axis: 'row',
    children: [
      { hidden: true, basis: 5, node: leaf('projects') }, // clamp + hidden
      { node: { kind: 'tabs', active: 'ghost', panels: ['editor', 'editor', 'tasks'], chrome: 'x', id: MAIN_TABS_ID } },
      { grow: true, node: leaf('files') },
      { grow: true, node: leaf('files') }, // duplicate dropped
      { basis: 9999, node: leaf('terminal') },
      { node: { kind: 'bogus' } }, // dropped
    ],
  }

  it('normalizeDesktopTree(normalizeDesktopTree(x)) === normalizeDesktopTree(x)', () => {
    const once = normalizeDesktopTree(messyTree)
    const twice = normalizeDesktopTree(once)
    expect(twice).toEqual(once)
  })

  it('normalizeLayout round-trips a messy layout', () => {
    const once = normalizeLayout({ desktop: messyTree, mobile: { activeDock: 'bad' }, panelState: {} })
    const twice = normalizeLayout(once)
    expect(twice).toEqual(once)
  })

  it('round-trips repeatedly on the default layout', () => {
    const a = normalizeLayout(defaultWorkspacePanelLayout())
    const b = normalizeLayout(a)
    const c = normalizeLayout(b)
    expect(c).toEqual(a)
  })
})
