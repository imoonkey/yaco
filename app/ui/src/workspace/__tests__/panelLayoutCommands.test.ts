// Unit tests for the panel layout commands (T4b) — the layout-mutation surface
// on the model: collapse, resize, dock/activity toggle, activate-tab, move,
// split, reset. Each command is a pure layout → layout transform that ends in a
// re-normalized desktop tree, so tests assert both the intended edit and that
// the tree invariants (single-occurrence, one grow child, min clamp, idempotency)
// survive the edit.
import { describe, it, expect, vi } from 'vitest'
import {
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
  movePanel,
  splitPanel,
  resetLayout,
  leafPanelsInOrder,
} from '../panelLayoutModel'
import { getPanelMeta } from '../panelMeta'
import type { LayoutNode, SplitNode, LeafNode, SplitChild } from '../../hooks/workspaceTypes'
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
function asLeaf(node: LayoutNode): LeafNode {
  if (node.kind !== 'leaf') throw new Error(`expected leaf, got ${node.kind}`)
  return node
}

/** Every dock panel rendered in the tree, in DFS order. Group (tabs) nodes hold
 *  editor/terminal tabs, not dock panels, so they contribute none. */
function panelsOf(node: LayoutNode): PanelId[] {
  if (node.kind === 'leaf') return [node.panel]
  if (node.kind === 'tabs') return []
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

// The four dock panels (editor/terminal live as group tabs, tasks is the desktop
// overlay — none are dock leaves).
const ALL_PANELS: PanelId[] = ['projects', 'files', 'changes', 'sessions']

/** Assert the tree still holds exactly one of every dock panel (nothing lost/dupe'd). */
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

  it('is a no-op for a panel that lives in a group (not a dock section)', () => {
    expect(collapsePanel(base(), 'editor', true)).toEqual(base())
    expect(collapsePanel(base(), 'terminal', true)).toEqual(base())
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

  it('scales same-axis descendants when a grow sibling changes size', () => {
    const layout = normalizeLayout({
      desktop: {
        kind: 'split', id: 'root', axis: 'row', children: [
          { basis: 200, node: { kind: 'leaf', id: 'files', panel: 'files' } },
          {
            grow: true,
            node: {
              kind: 'split', id: 'center', axis: 'row', children: [
                { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: [], activeTab: '' } },
                { basis: 400, node: { kind: 'tabs', id: 'group:2', tabs: [], activeTab: '' } },
              ],
            },
          },
        ],
      },
    })

    const next = resizeSplitChild(layout, 'root', 'files', 300, { containerBasis: 1003 })
    // Root content: 1003px total - one 3px handle = 1000px. The center shrinks
    // from 800px to 700px, so its fixed 400px child scales to ~350px instead of
    // keeping the center divider pinned in absolute pixels.
    expect(findSplit(next.desktop, 'center').children[1].basis).toBeCloseTo(350, 0)
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
    expect(children[children.length - 1].basis).toBe(280)
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

  it('is a no-op when there is no left/right sidebar to toggle', () => {
    // A center-only region row (no sidebars) — nothing for the dock/activity edge.
    const centerOnly = normalizeLayout({ desktop: { kind: 'tabs', id: 'group:1', tabs: [], activeTab: '' } })
    expect(toggleDock(centerOnly)).toBe(centerOnly)
    expect(toggleActivity(centerOnly)).toBe(centerOnly)
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
    const next = splitPanel(base(), 'sessions', 'projects', 'left')
    expectAllPanelsOnce(next.desktop)
    const dock = findSplit(next.desktop, 'dock')
    expect(dock.children.map((c) => panelsOf(c.node)[0])).toEqual(['files', 'changes'])
  })

  it('collapses a two-child split to a leaf when one child is detached away', () => {
    // Build a two-child split (projects beside sessions in the right column), then
    // detach sessions away → the single-child split collapses and projects carries
    // the slot as a bare leaf.
    const twoChild = splitPanel(base(), 'sessions', 'projects', 'left')
    expect(findSplit(twoChild.desktop, 'split:projects').children).toHaveLength(2)
    const next = splitPanel(twoChild, 'files', 'sessions', 'above')
    expect(() => findSplit(next.desktop, 'split:projects')).toThrow()
    const activitySlot = asSplit(next.desktop).children[asSplit(next.desktop).children.length - 1]
    expect(panelsOf(activitySlot.node)).toEqual(['projects'])
    expect(activitySlot.basis).toBe(280) // outer slot size preserved
    expectAllPanelsOnce(next.desktop)
  })

  it('is a no-op when target is not a standalone leaf (it lives in a tabs node)', () => {
    expect(splitPanel(base(), 'editor', 'sessions', 'left')).toEqual(base())
  })

  it('is a no-op when panel === target', () => {
    expect(splitPanel(base(), 'files', 'files', 'left')).toEqual(base())
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
          { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: [], activeTab: '' } },
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

  it('is a no-op for a tabs placement (dock panels never live in a working group)', () => {
    expect(movePanel(base(), 'changes', { kind: 'tabs', tabsId: 'group:1' })).toEqual(base())
    expect(movePanel(base(), 'changes', { kind: 'tabs', tabsId: 'ghost' })).toEqual(base())
  })

  it('returns sessions to its default home, regrafting the right activity column', () => {
    // Move sessions into the dock (beside projects), then reset to default → it
    // regrafts as the standalone last root child (the renderer landmarks that
    // position "Activity panel"), restoring the canonical default tree.
    const moved = movePanel(base(), 'sessions', { kind: 'split', target: 'projects', side: 'above' })
    const movedRoot = asSplit(moved.desktop)
    expect(panelsOf(movedRoot.children[movedRoot.children.length - 1].node)).not.toContain('sessions')

    const restored = movePanel(moved, 'sessions', { kind: 'default' })
    expect(restored.desktop).toEqual(defaultWorkspacePanelLayout().desktop)
    expectAllPanelsOnce(restored.desktop)
    expect(normalizeLayout(restored)).toEqual(restored)
  })

  it('uses a generic split id (not the canonical column id) when that column still exists', () => {
    // dock still holds files+changes, so returning projects to default must NOT
    // mint a second 'dock' node (id collision) — it falls back to a generic split.
    const moved = movePanel(base(), 'projects', { kind: 'split', target: 'sessions', side: 'below' })
    expect(tryFindSplit(moved.desktop, 'dock')).not.toBeNull() // dock survives (files+changes)
    const restored = movePanel(moved, 'projects', { kind: 'default' })
    expect(tryFindChild(restored.desktop, 'projects')?.parent.id).not.toBe('activity')
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
  it('lists visible standalone leaf panels left-to-right, excluding group tabs', () => {
    // Default tree: dock [projects, files, changes], one empty group, activity
    // [sessions]. The group holds no dock leaves; tasks is the desktop overlay.
    expect(leafPanelsInOrder(base().desktop)).toEqual(
      ['projects', 'files', 'changes', 'sessions'],
    )
  })

  it('skips leaves inside a hidden subtree (not a valid move target)', () => {
    const hidden = toggleDock(base()) // hides the dock column
    expect(leafPanelsInOrder(hidden.desktop)).toEqual(['sessions'])
  })

  it('reflects a relocation: a moved panel lists in its new position', () => {
    // Move sessions above projects (into the dock) → it leads the order.
    const moved = splitPanel(base(), 'projects', 'sessions', 'above')
    expect(leafPanelsInOrder(moved.desktop)).toEqual(
      ['sessions', 'projects', 'files', 'changes'],
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
    layout = resizeSplitChild(layout, 'root', 'sessions', 500)
    layout = toggleDock(layout)
    layout = splitPanel(layout, 'sessions', 'changes', 'below')
    layout = movePanel(layout, 'projects', { kind: 'split', target: 'sessions', side: 'above' })

    expectAllPanelsOnce(layout.desktop)
    expect(normalizeLayout(layout)).toEqual(layout)
  })

  it('defaultPanelState is untouched by structural commands', () => {
    const next = splitPanel(base(), 'sessions', 'projects', 'left')
    expect(next.panelState).toEqual(defaultPanelState())
  })
})
