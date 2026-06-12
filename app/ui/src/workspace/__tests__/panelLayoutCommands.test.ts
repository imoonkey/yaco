// Unit tests for the panel layout commands (T4b) — the layout-mutation surface
// on the model: collapse, resize, dock/activity toggle, activate-tab, move,
// split, reset. Each command is a pure layout → layout transform that ends in a
// re-normalized desktop tree, so tests assert both the intended edit and that
// the tree invariants (single-occurrence, one grow child, min clamp, idempotency)
// survive the edit.
import { describe, it, expect, vi } from 'vitest'
import {
  MAIN_TABS_ID,
  DEFAULT_MIN_SIZE,
  DEFAULT_SPLIT_BASIS,
  defaultWorkspacePanelLayout,
  defaultPanelState,
  normalizeLayout,
  collapsePanel,
  resizeSplitChild,
  toggleDock,
  toggleActivity,
  setDockVisible,
  setActivityVisible,
  setActiveDock,
  activateTabsPanel,
  movePanel,
  splitPanel,
  resetLayout,
  leafPanelsInOrder,
} from '../panelLayoutModel'
import { getPanelMeta } from '../panelMeta'
import type { LayoutNode, SplitNode, TabsNode, LeafNode, SplitChild } from '../../hooks/workspaceTypes'
import type { PanelId } from '../context'

// The clamp/normalize math reads each panel's min size from the metadata lookup.
// Stub it with controlled mins so these tests assert the LOGIC with KNOWN inputs,
// independent of which panels the production registry assembles. The mins are
// small (≤ every default/split basis) so normalization leaves the default tree
// untouched; only the explicit clamp assertions observe them.
vi.mock('../panelMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panelMeta')>()
  const TEST_MIN_SIZE = { width: 40, height: 30 }
  return {
    ...actual,
    getPanelMeta: (id: unknown) => {
      const meta = actual.getPanelMeta(id)
      return meta ? { ...meta, minSize: TEST_MIN_SIZE } : undefined
    },
  }
})

// --- Narrowing + lookup helpers ---------------------------------------------

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

/** Every panel rendered in the tree (leaves + tabs), in DFS order. Used to pin
 *  the single-occurrence invariant after structural edits. */
function panelsOf(node: LayoutNode): PanelId[] {
  if (node.kind === 'leaf') return [node.panel]
  if (node.kind === 'tabs') return [...node.panels]
  return node.children.flatMap((c) => panelsOf(c.node))
}

/** Find a split by id (DFS), or throw. */
function findSplit(node: LayoutNode, id: string): SplitNode {
  if (node.kind === 'split') {
    if (node.id === id) return node
    for (const c of node.children) {
      const hit = tryFindSplit(c.node, id)
      if (hit) return hit
    }
  }
  throw new Error(`split ${id} not found`)
}
function tryFindSplit(node: LayoutNode, id: string): SplitNode | null {
  if (node.kind !== 'split') return null
  if (node.id === id) return node
  for (const c of node.children) {
    const hit = tryFindSplit(c.node, id)
    if (hit) return hit
  }
  return null
}

/** Find the split child whose node renders `panel`, plus its parent split. */
function findChild(node: LayoutNode, panel: PanelId): { parent: SplitNode; child: SplitChild } {
  if (node.kind === 'split') {
    for (const child of node.children) {
      if (child.node.kind === 'leaf' && child.node.panel === panel) return { parent: node, child }
    }
    for (const child of node.children) {
      const deeper = tryFindChild(child.node, panel)
      if (deeper) return deeper
    }
  }
  throw new Error(`child ${panel} not found`)
}
function tryFindChild(node: LayoutNode, panel: PanelId): { parent: SplitNode; child: SplitChild } | null {
  if (node.kind !== 'split') return null
  for (const child of node.children) {
    if (child.node.kind === 'leaf' && child.node.panel === panel) return { parent: node, child }
  }
  for (const child of node.children) {
    const deeper = tryFindChild(child.node, panel)
    if (deeper) return deeper
  }
  return null
}

const ALL_PANELS: PanelId[] = ['projects', 'files', 'changes', 'sessions', 'editor', 'terminal', 'tasks']

/** Find a tabs node by id (DFS), or null. */
function tryFindTabs(node: LayoutNode, id: string): TabsNode | null {
  if (node.kind === 'tabs') return node.id === id ? node : null
  if (node.kind === 'split') {
    for (const c of node.children) {
      const hit = tryFindTabs(c.node, id)
      if (hit) return hit
    }
  }
  return null
}

/** Assert the tree still holds exactly one of every panel (nothing lost/dupe'd). */
function expectAllPanelsOnce(node: LayoutNode): void {
  expect(panelsOf(node).sort()).toEqual([...ALL_PANELS].sort())
}

const base = () => defaultWorkspacePanelLayout()

// --- collapsePanel ----------------------------------------------------------

describe('collapsePanel', () => {
  it('marks a dock leaf collapsed, and clears the flag again', () => {
    const collapsed = collapsePanel(base(), 'projects', true)
    expect(asLeaf(findChild(collapsed.desktop, 'projects').child.node).collapsed).toBe(true)

    const expanded = collapsePanel(collapsed, 'projects', false)
    // false clears the key entirely (no `collapsed: false` litter)
    expect(asLeaf(findChild(expanded.desktop, 'projects').child.node)).not.toHaveProperty('collapsed')
    expect(expanded).toEqual(base())
  })

  it('leaves the rest of the tree untouched and all panels present', () => {
    const next = collapsePanel(base(), 'files', true)
    expectAllPanelsOnce(next.desktop)
    expect(asLeaf(findChild(next.desktop, 'changes').child.node).collapsed).toBeUndefined()
  })

  it('is a no-op for a panel that lives in a tabs node (not a section)', () => {
    expect(collapsePanel(base(), 'editor', true)).toEqual(base())
    expect(collapsePanel(base(), 'tasks', true)).toEqual(base())
  })
})

// --- resizeSplitChild -------------------------------------------------------

describe('resizeSplitChild', () => {
  it('sets the pixel basis of a child addressed by split id + node id', () => {
    // dock column width: child "dock" of the root split.
    const next = resizeSplitChild(base(), 'root', 'dock', 320)
    expect(findSplit(next.desktop, 'root').children[0].basis).toBe(320)
    expect(asSplit(base().desktop).children[0].basis).toBe(220) // input untouched
  })

  it('resizes a leaf child inside a nested split', () => {
    const next = resizeSplitChild(base(), 'dock', 'projects', 200)
    expect(findChild(next.desktop, 'projects').child.basis).toBe(200)
  })

  it('clamps an undersized basis up to the child min along the axis', () => {
    // The dock is a col split, so the projects child's height is clamped to its
    // HEIGHT min from the (stubbed) metadata — asserting the clamp + correct axis
    // (width ≠ height in the stub) with a known input.
    const minHeight = getPanelMeta('projects')!.minSize.height
    const next = resizeSplitChild(base(), 'dock', 'projects', 5)
    expect(findChild(next.desktop, 'projects').child.basis).toBe(minHeight)
  })

  it('clamps a non-leaf child (the dock column) to the default axis min', () => {
    const next = resizeSplitChild(base(), 'root', 'dock', 5)
    expect(findSplit(next.desktop, 'root').children[0].basis).toBe(DEFAULT_MIN_SIZE.width)
  })

  it('is a no-op for an unknown split or child id', () => {
    expect(resizeSplitChild(base(), 'ghost', 'projects', 300)).toEqual(base())
    expect(resizeSplitChild(base(), 'dock', 'ghost', 300)).toEqual(base())
  })

  it('does not mutate the input layout', () => {
    const layout = base()
    resizeSplitChild(layout, 'root', 'dock', 999)
    expect(asSplit(layout.desktop).children[0].basis).toBe(220)
  })

  it('rejects a non-finite basis (NaN / Infinity) so normalization cannot drop it', () => {
    expect(resizeSplitChild(base(), 'root', 'dock', Number.NaN)).toEqual(base())
    expect(resizeSplitChild(base(), 'root', 'dock', Number.POSITIVE_INFINITY)).toEqual(base())
    expect(resizeSplitChild(base(), 'root', 'dock', Number.NEGATIVE_INFINITY)).toEqual(base())
  })
})

// --- toggleDock / toggleActivity --------------------------------------------

describe('toggleDock / toggleActivity', () => {
  it('hides then restores the dock column, preserving its basis', () => {
    const hidden = toggleDock(base())
    const dock = asSplit(hidden.desktop).children[0]
    expect(dock.hidden).toBe(true)
    expect(dock.basis).toBe(220) // size kept for restore

    const restored = toggleDock(hidden)
    expect(asSplit(restored.desktop).children[0].hidden).toBeUndefined()
    expect(restored).toEqual(base())
  })

  it('hides the activity column (last root child), leaving the dock visible', () => {
    const hidden = toggleActivity(base())
    const children = asSplit(hidden.desktop).children
    expect(children[children.length - 1].hidden).toBe(true)
    expect(children[0].hidden).toBeUndefined()
    expect(children[children.length - 1].basis).toBe(420)
  })

  it('toggles dock and activity independently', () => {
    const both = toggleActivity(toggleDock(base()))
    const children = asSplit(both.desktop).children
    expect(children[0].hidden).toBe(true)
    expect(children[children.length - 1].hidden).toBe(true)
    expect(children[1].hidden).toBeUndefined() // main stays visible
  })

  it('restore preserves inner collapse + a resized basis (hidden subtree intact)', () => {
    let layout = collapsePanel(base(), 'projects', true)
    layout = resizeSplitChild(layout, 'root', 'dock', 300)
    const cycled = toggleDock(toggleDock(layout))
    expect(cycled).toEqual(layout)
    expect(asSplit(cycled.desktop).children[0].basis).toBe(300)
    expect(asLeaf(findChild(cycled.desktop, 'projects').child.node).collapsed).toBe(true)
  })

  it('is a no-op when the root cannot have dock/activity columns', () => {
    const single = normalizeLayout({ desktop: { kind: 'leaf', id: 'files', panel: 'files' } })
    expect(toggleDock(single)).toEqual(single)
    expect(toggleActivity(single)).toEqual(single)
  })

  it('no-ops on the missing side, anchoring on the main slot (not blindly first/last)', () => {
    // Park both activity panels into the main tabs node: the activity column
    // empties and normalizes away, leaving root = [dock, main].
    let layout = movePanel(base(), 'sessions', { kind: 'tabs', tabsId: MAIN_TABS_ID })
    layout = movePanel(layout, 'terminal', { kind: 'tabs', tabsId: MAIN_TABS_ID })
    const children = asSplit(layout.desktop).children
    expect(children).toHaveLength(2) // [dock, main]; no activity slot
    expect(children[children.length - 1].node.kind).toBe('tabs') // last child IS main

    // toggleActivity must NOT hide main (the old first/last bug); it is a no-op.
    expect(toggleActivity(layout)).toEqual(layout)
    // toggleDock still targets the real dock (the child before main).
    const dockHidden = toggleDock(layout)
    expect(asSplit(dockHidden.desktop).children[0].hidden).toBe(true)
    expect(asSplit(dockHidden.desktop).children[1].hidden).toBeUndefined() // main untouched
  })
})

// --- setDockVisible / setActivityVisible ------------------------------------

describe('setDockVisible / setActivityVisible', () => {
  it('drive the dock/activity column to an explicit target (not a blind flip)', () => {
    const hiddenDock = setDockVisible(base(), false)
    expect(asSplit(hiddenDock.desktop).children[0].hidden).toBe(true)
    // Setting the SAME target again is a no-op (same reference), so a repeated
    // reveal/hide never thrashes the tree out of step with the flat store.
    expect(setDockVisible(hiddenDock, false)).toBe(hiddenDock)

    const shownDock = setDockVisible(hiddenDock, true)
    expect(asSplit(shownDock.desktop).children[0].hidden).toBeUndefined()
    expect(shownDock).toEqual(base())

    const children = asSplit(setActivityVisible(base(), false).desktop).children
    expect(children[children.length - 1].hidden).toBe(true)
    expect(children[0].hidden).toBeUndefined() // dock untouched
  })

  it('return the same layout (state-update bail) when already in the desired state', () => {
    const layout = base()
    expect(setDockVisible(layout, true)).toBe(layout) // already visible
    expect(setActivityVisible(layout, true)).toBe(layout)
  })

  it('preserve the hidden subtree (basis + inner collapse) across hide → show', () => {
    let layout = collapsePanel(base(), 'projects', true)
    layout = resizeSplitChild(layout, 'root', 'dock', 300)
    const cycled = setDockVisible(setDockVisible(layout, false), true)
    expect(cycled).toEqual(layout)
    expect(asSplit(cycled.desktop).children[0].basis).toBe(300)
    expect(asLeaf(findChild(cycled.desktop, 'projects').child.node).collapsed).toBe(true)
  })

  it('anchor on the main slot, no-op when the targeted column is absent', () => {
    // Park both activity panels into main → root = [dock, main]; no activity slot.
    let layout = movePanel(base(), 'sessions', { kind: 'tabs', tabsId: MAIN_TABS_ID })
    layout = movePanel(layout, 'terminal', { kind: 'tabs', tabsId: MAIN_TABS_ID })
    expect(setActivityVisible(layout, false)).toBe(layout) // no activity column
    expect(asSplit(setDockVisible(layout, false).desktop).children[0].hidden).toBe(true)
  })
})

// --- setActiveDock (mobile projection's active pane) ------------------------

describe('setActiveDock', () => {
  it('sets the active mobile dock without touching the desktop tree', () => {
    const layout = base()
    const next = setActiveDock(layout, 'terminal')
    expect(next.mobile.activeDock).toBe('terminal')
    // Desktop arrangement + panel state pass through by reference (structure-free edit).
    expect(next.desktop).toBe(layout.desktop)
    expect(next.panelState).toBe(layout.panelState)
  })

  it('returns the same layout (state-update bail) when already on that dock', () => {
    const layout = base() // default dock is 'browse'
    expect(setActiveDock(layout, 'browse')).toBe(layout)
    const onEditor = setActiveDock(layout, 'editor')
    expect(setActiveDock(onEditor, 'editor')).toBe(onEditor)
  })
})

// --- activateTabsPanel ------------------------------------------------------

describe('activateTabsPanel', () => {
  it('switches the active tab of the main tabs node', () => {
    const toTasks = activateTabsPanel(base(), MAIN_TABS_ID, 'tasks')
    const tabs = asTabs(asSplit(toTasks.desktop).children[1].node)
    expect(tabs.active).toBe('tasks')

    const backToEditor = activateTabsPanel(toTasks, MAIN_TABS_ID, 'editor')
    expect(asTabs(asSplit(backToEditor.desktop).children[1].node).active).toBe('editor')
  })

  it('ignores a panel that is not one of the tabs node panels', () => {
    expect(activateTabsPanel(base(), MAIN_TABS_ID, 'files')).toEqual(base())
  })

  it('ignores an unknown tabs id', () => {
    expect(activateTabsPanel(base(), 'nope', 'tasks')).toEqual(base())
  })
})

// --- splitPanel -------------------------------------------------------------

describe('splitPanel', () => {
  it('places a panel beside a leaf target on the given side, target keeps growing', () => {
    // Split projects beside sessions, on its left → new row split [projects, sessions].
    const next = splitPanel(base(), 'sessions', 'projects', 'left')
    const split = findSplit(next.desktop, 'split:projects')
    expect(split.axis).toBe('row')
    expect(split.children.map((c) => panelsOf(c.node)[0])).toEqual(['projects', 'sessions'])
    expect(split.children[0].basis).toBe(DEFAULT_SPLIT_BASIS.row) // inserted panel fixed
    expect(split.children[0].grow).toBeUndefined()
    expect(split.children[1].grow).toBe(true) // target absorbs slack
    expectAllPanelsOnce(next.desktop)
  })

  it('orders the inserted panel after the target for right/below sides', () => {
    const right = splitPanel(base(), 'sessions', 'projects', 'right')
    expect(findSplit(right.desktop, 'split:projects').children.map((c) => panelsOf(c.node)[0]))
      .toEqual(['sessions', 'projects'])

    const below = splitPanel(base(), 'sessions', 'projects', 'below')
    const split = findSplit(below.desktop, 'split:projects')
    expect(split.axis).toBe('col')
    expect(split.children.map((c) => panelsOf(c.node)[0])).toEqual(['sessions', 'projects'])
  })

  it('detaches the panel from its old home (no duplicate; empty parent collapses)', () => {
    // projects leaves the dock; the dock split keeps files + changes.
    const next = splitPanel(base(), 'terminal', 'projects', 'left')
    expectAllPanelsOnce(next.desktop)
    const dock = findSplit(next.desktop, 'dock')
    expect(dock.children.map((c) => panelsOf(c.node)[0])).toEqual(['files', 'changes'])
  })

  it('collapses a two-child split to a leaf when one child is detached away', () => {
    // Move sessions out of the activity column → activity has only terminal left,
    // so the single-child split collapses; terminal carries the activity slot.
    const next = splitPanel(base(), 'projects', 'sessions', 'above')
    expect(() => findSplit(next.desktop, 'activity')).toThrow()
    const activitySlot = asSplit(next.desktop).children[2]
    expect(panelsOf(activitySlot.node)).toEqual(['terminal'])
    expect(activitySlot.basis).toBe(420) // outer slot size preserved
  })

  it('is a no-op when target is not a standalone leaf (it lives in a tabs node)', () => {
    expect(splitPanel(base(), 'editor', 'sessions', 'left')).toEqual(base())
  })

  it('is a no-op when panel === target', () => {
    expect(splitPanel(base(), 'files', 'files', 'left')).toEqual(base())
  })

  it('is a no-op when the target panel is absent (already moved into a tabs node)', () => {
    // Park sessions in the main tabs node, then try to split beside it: sessions
    // is no longer a standalone leaf, so there is nothing to split against.
    const parked = movePanel(base(), 'sessions', { kind: 'tabs', tabsId: MAIN_TABS_ID })
    expect(splitPanel(parked, 'sessions', 'projects', 'left')).toEqual(parked)
  })

  it('produces an already-normalized (idempotent) result', () => {
    const next = splitPanel(base(), 'sessions', 'projects', 'left')
    expect(normalizeLayout(next)).toEqual(next)
  })

  it('carries the moved leaf collapsed flag to its new slot', () => {
    const collapsed = collapsePanel(base(), 'sessions', true)
    const moved = splitPanel(collapsed, 'projects', 'sessions', 'left')
    const leafNode = asLeaf(findChild(moved.desktop, 'sessions').child.node)
    expect(leafNode.collapsed).toBe(true) // state travels, not reset
    expect(leafNode.id).toBe('sessions')
    expectAllPanelsOnce(moved.desktop)
  })

  it('preserves a custom stable leaf id across the move', () => {
    const custom = normalizeLayout({
      desktop: {
        kind: 'split', id: 'root', axis: 'row',
        children: [
          { node: { kind: 'leaf', id: 'files', panel: 'files' } },
          { grow: true, node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
          { basis: 420, node: { kind: 'leaf', id: 'sess-custom', panel: 'sessions', collapsed: true } },
        ],
      },
    })
    const moved = splitPanel(custom, 'files', 'sessions', 'left')
    const leafNode = asLeaf(findChild(moved.desktop, 'sessions').child.node)
    expect(leafNode.id).toBe('sess-custom') // stable id, not regenerated to "sessions"
    expect(leafNode.collapsed).toBe(true)
  })
})

// --- movePanel --------------------------------------------------------------

describe('movePanel', () => {
  it('delegates a split placement to splitPanel', () => {
    expect(movePanel(base(), 'projects', { kind: 'split', target: 'sessions', side: 'left' }))
      .toEqual(splitPanel(base(), 'sessions', 'projects', 'left'))
  })

  it('moves a panel into a tabs node at an index and activates it', () => {
    // Drop changes into the main tabs node at the front.
    const next = movePanel(base(), 'changes', { kind: 'tabs', tabsId: MAIN_TABS_ID, index: 0 })
    const tabs = asTabs(asSplit(next.desktop).children[1].node)
    expect(tabs.panels).toEqual(['changes', 'editor', 'tasks'])
    expect(tabs.active).toBe('changes')
    expectAllPanelsOnce(next.desktop)
    // changes no longer a dock leaf
    expect(() => findChild(next.desktop, 'changes')).toThrow()
  })

  it('appends to a tabs node when index is omitted', () => {
    const next = movePanel(base(), 'changes', { kind: 'tabs', tabsId: MAIN_TABS_ID })
    expect(asTabs(asSplit(next.desktop).children[1].node).panels).toEqual(['editor', 'tasks', 'changes'])
  })

  it('is a no-op moving into an unknown tabs node', () => {
    expect(movePanel(base(), 'changes', { kind: 'tabs', tabsId: 'ghost' })).toEqual(base())
  })

  it('returns a moved panel to its default home, rebuilding the canonical activity column', () => {
    // Move sessions out (the activity split collapses to a bare terminal leaf),
    // then back to default (beside terminal, below).
    const moved = movePanel(base(), 'sessions', { kind: 'split', target: 'projects', side: 'above' })
    expect(tryFindChild(moved.desktop, 'sessions')?.parent.id).not.toBe('activity')
    expect(tryFindSplit(moved.desktop, 'activity')).toBeNull() // activity dismantled

    const restored = movePanel(moved, 'sessions', { kind: 'default' })
    const { parent } = findChild(restored.desktop, 'sessions')
    // sessions sits in the canonical 'activity' col split next to terminal again —
    // NOT a generic split:sessions — so the renderer's "Activity panel" landmark
    // (keyed on the 'activity' node id) is restored.
    expect(parent.id).toBe('activity')
    expect(parent.axis).toBe('col')
    expect(panelsOf(parent).sort()).toEqual(['sessions', 'terminal'])
    expectAllPanelsOnce(restored.desktop)
    // The reset reproduces the exact default tree shape (H1 regression guard).
    expect(restored.desktop).toEqual(defaultWorkspacePanelLayout().desktop)
    expect(normalizeLayout(restored)).toEqual(restored)
  })

  it('uses a generic split id (not the canonical column id) when that column still exists', () => {
    // dock still holds files+changes, so returning projects to default must NOT
    // mint a second 'dock' node (id collision) — it falls back to a generic split.
    const moved = movePanel(base(), 'projects', { kind: 'split', target: 'terminal', side: 'below' })
    expect(tryFindSplit(moved.desktop, 'dock')).not.toBeNull() // dock survives (files+changes)
    const restored = movePanel(moved, 'projects', { kind: 'default' })
    expect(tryFindChild(restored.desktop, 'projects')?.parent.id).not.toBe('activity')
    expectAllPanelsOnce(restored.desktop)
    expect(normalizeLayout(restored)).toEqual(restored)
  })

  it('keeps the home editor structural in the main node; tasks can leave and return to default', () => {
    // The home editor is structural — it always stays in the main tabs node, so
    // the main node is never dismantled (multi-instance model). Moving tasks out
    // leaves the main node holding just the home editor.
    const layout = movePanel(base(), 'tasks', { kind: 'split', target: 'changes', side: 'below' })
    expect(tryFindTabs(layout.desktop, MAIN_TABS_ID)?.panels).toEqual(['editor'])
    expect(tryFindTabs(layout.desktop, MAIN_TABS_ID)?.active).toBe('editor')

    // Restoring tasks to default rejoins it in the main node beside the editor.
    const restored = movePanel(layout, 'tasks', { kind: 'default' })
    expect(tryFindTabs(restored.desktop, MAIN_TABS_ID)?.panels.sort()).toEqual(['editor', 'tasks'])
    expectAllPanelsOnce(restored.desktop)
    expect(normalizeLayout(restored)).toEqual(restored)
  })
})

// --- resetLayout ------------------------------------------------------------

describe('resetLayout', () => {
  it('returns the default layout when called with no current layout', () => {
    expect(resetLayout()).toEqual(defaultWorkspacePanelLayout())
  })

  it('resets the arrangement but preserves panel-local state (editor prefs)', () => {
    const dirty = normalizeLayout({
      ...defaultWorkspacePanelLayout(),
      mobile: { activeDock: 'terminal' },
      panelState: {
        files: { mode: 'search' },
        editor: { previewMode: 'split', splitDirection: 'vertical', splitSize: 70, autocompleteEnabled: true },
      },
    })
    // also mutate the tree so reset is observable
    const messy = splitPanel(dirty, 'sessions', 'projects', 'left')

    const reset = resetLayout(messy)
    expect(reset.desktop).toEqual(defaultWorkspacePanelLayout().desktop)
    expect(reset.mobile.activeDock).toBe('browse') // arrangement reset
    expect(reset.panelState).toEqual(messy.panelState) // prefs survive
    expect(reset.panelState.editor.autocompleteEnabled).toBe(true)
    expect(reset.panelState.files.mode).toBe('search')
  })
})

// --- leafPanelsInOrder (the panel menu's relocation-target source) ----------

describe('leafPanelsInOrder', () => {
  it('lists visible standalone leaf panels left-to-right, excluding tabs panels', () => {
    // Default tree: dock [projects, files, changes], main tabs [editor, tasks],
    // activity [terminal, sessions]. editor/tasks live in the tabs node, so they
    // are NOT standalone leaves and must be absent.
    expect(leafPanelsInOrder(base().desktop)).toEqual(
      ['projects', 'files', 'changes', 'terminal', 'sessions'],
    )
  })

  it('skips leaves inside a hidden subtree (not a valid move target)', () => {
    const hidden = toggleDock(base()) // hides the dock column
    expect(leafPanelsInOrder(hidden.desktop)).toEqual(['terminal', 'sessions'])
  })

  it('reflects a relocation: a moved panel lists in its new position', () => {
    // Move sessions above projects (into the dock) → it leads the order.
    const moved = splitPanel(base(), 'projects', 'sessions', 'above')
    expect(leafPanelsInOrder(moved.desktop)).toEqual(
      ['sessions', 'projects', 'files', 'changes', 'terminal'],
    )
  })
})



describe('normalizeLayout salvages a stored v1 editor splitSize to range', () => {
  const withSplitSize = (splitSize: unknown) =>
    normalizeLayout({
      ...defaultWorkspacePanelLayout(),
      panelState: {
        files: { mode: 'tree' },
        editor: { previewMode: 'edit', splitDirection: 'horizontal', splitSize, autocompleteEnabled: false },
      },
    }).panelState.editor.splitSize

  const fallback = defaultPanelState().editor.splitSize

  it('keeps an in-range value', () => {
    expect(withSplitSize(70)).toBe(70)
    expect(withSplitSize(20)).toBe(20) // inclusive bounds
    expect(withSplitSize(80)).toBe(80)
  })

  it('salvages an out-of-range value to the default (would otherwise break the split)', () => {
    expect(withSplitSize(999)).toBe(fallback) // upper-bound overflow
    expect(withSplitSize(10)).toBe(fallback) // below range
    expect(withSplitSize(0)).toBe(fallback)
    expect(withSplitSize(-1)).toBe(fallback)
  })

  it('salvages a non-numeric / non-finite value to the default', () => {
    expect(withSplitSize('70')).toBe(fallback)
    expect(withSplitSize(Number.NaN)).toBe(fallback)
    expect(withSplitSize(Number.POSITIVE_INFINITY)).toBe(fallback)
  })
})

// --- Cross-command invariants -----------------------------------------------

describe('command outputs stay normalized + single-occurrence', () => {
  it('a chain of edits keeps every panel exactly once and re-normalizes to itself', () => {
    let layout = base()
    layout = collapsePanel(layout, 'files', true)
    layout = resizeSplitChild(layout, 'root', 'activity', 500)
    layout = toggleDock(layout)
    layout = activateTabsPanel(layout, MAIN_TABS_ID, 'tasks')
    layout = splitPanel(layout, 'terminal', 'changes', 'below')
    layout = movePanel(layout, 'projects', { kind: 'tabs', tabsId: MAIN_TABS_ID })

    expectAllPanelsOnce(layout.desktop)
    expect(normalizeLayout(layout)).toEqual(layout)
  })

  it('defaultPanelState is untouched by structural commands', () => {
    const next = splitPanel(base(), 'sessions', 'projects', 'left')
    expect(next.panelState).toEqual(defaultPanelState())
  })
})
