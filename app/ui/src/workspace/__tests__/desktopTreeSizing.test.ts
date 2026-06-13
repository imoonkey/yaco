// Unit tests for the desktop tree sizing math (the pure layer behind
// DesktopPanelTreeLayout). These pin the absorber selection, flex sizing, and
// framed-leaf collection that the renderer's geometry depends on — without
// mounting React.
import { describe, it, expect } from 'vitest'
import {
  minBasisPx, isCollapsedLeaf, canonicalizeSplit, planSplitChildren,
  collectFramedLeaves,
} from '../desktopTreeSizing'
import { defaultDesktopTree } from '../panelLayoutModel'
import type { PanelId } from '../context'
import type { SplitNode, SplitChild } from '../../hooks/workspaceTypes'

// --- builders ---------------------------------------------------------------

function leaf(panel: PanelId, collapsed?: boolean): SplitChild['node'] {
  return collapsed ? { kind: 'leaf', id: panel, panel, collapsed } : { kind: 'leaf', id: panel, panel }
}
function fixed(panel: PanelId, basis: number, collapsed?: boolean): SplitChild {
  return { basis, node: leaf(panel, collapsed) }
}
function grow(panel: PanelId, collapsed?: boolean): SplitChild {
  return { grow: true, node: leaf(panel, collapsed) }
}
function split(axis: 'row' | 'col', children: SplitChild[], id = 'split'): SplitNode {
  return { kind: 'split', id, axis, children }
}

const childAt = (s: SplitNode, id: string) => s.children.find((c) => c.node.id === id)
const idOfAbsorber = (s: SplitNode): string | undefined =>
  s.children.find((c) => c.hidden !== true && c.grow === true)?.node.id

describe('minBasisPx', () => {
  it('reads the registry min along the axis for a leaf', () => {
    expect(minBasisPx(leaf('files'), 'row')).toBe(180) // PANEL_META.files.minSize.width
    expect(minBasisPx(leaf('files'), 'col')).toBe(80)
  })
  it('falls back to DEFAULT_MIN_SIZE for non-leaf nodes', () => {
    expect(minBasisPx(split('col', [grow('terminal')]), 'row')).toBe(120)
    expect(minBasisPx(split('col', [grow('terminal')]), 'col')).toBe(80)
  })
})

describe('isCollapsedLeaf', () => {
  it('is true only for a collapsed FRAMED leaf', () => {
    expect(isCollapsedLeaf(leaf('changes', true))).toBe(true)
    expect(isCollapsedLeaf(leaf('changes', false))).toBe(false)
    // terminal is unframed — a stray collapsed flag does not hide its body
    expect(isCollapsedLeaf(leaf('terminal', true))).toBe(false)
  })
})

describe('canonicalizeSplit — exactly one visible grow (the absorber)', () => {
  it('keeps the declared grow child as the absorber in the default dock', () => {
    const dock = split('col', [fixed('projects', 120), grow('files'), fixed('changes', 150)], 'dock')
    expect(idOfAbsorber(canonicalizeSplit(dock))).toBe('files')
  })

  it('promotes the last expanded child when the grow child is collapsed', () => {
    // Explorer collapsed ⇒ Changes grows (legacy flexFallback parity).
    const dock = split('col', [fixed('projects', 120), grow('files', true), fixed('changes', 150)], 'dock')
    const canon = canonicalizeSplit(dock)
    expect(idOfAbsorber(canon)).toBe('changes')
    // the collapsed grow child is no longer grow, and lost its fixed sizing role
    expect(childAt(canon, 'files')?.grow).toBeUndefined()
  })

  it('promotes the last visible fixed child when there is no grow child', () => {
    // Mirrors the empty-editor root: [dock fixed, activity fixed] ⇒ activity absorbs.
    const row = split('row', [fixed('files', 220), fixed('sessions', 420)], 'root')
    expect(idOfAbsorber(canonicalizeSplit(row))).toBe('sessions')
  })

  it('skips hidden children when choosing the absorber', () => {
    const row = split('row', [
      fixed('projects', 220),
      { ...grow('editor'), hidden: true },
      fixed('sessions', 420),
    ], 'root')
    // grow child hidden ⇒ last visible (sessions) absorbs
    expect(idOfAbsorber(canonicalizeSplit(row))).toBe('sessions')
  })

  it('keeps a ROW-split collapsed framed leaf as a fixed child (collapse is vertical)', () => {
    // The right activity column is a row child of the root; collapsing its section
    // is a header (vertical) shrink, so the leaf stays a fixed-width child — not a
    // header-only sizing that would squeeze the column to the header width.
    const row = split('row', [fixed('files', 220), grow('editor'), fixed('sessions', 280, true)], 'root')
    const canon = canonicalizeSplit(row)
    expect(idOfAbsorber(canon)).toBe('editor')
    expect(childAt(canon, 'sessions')?.basis).toBe(280) // basis retained, not dropped
  })
})

describe('planSplitChildren — flex sizing per visible child', () => {
  it('sizes fixed children by basis and the absorber as flex:1', () => {
    const dock = split('col', [fixed('projects', 120), grow('files'), fixed('changes', 150)], 'dock')
    const items = planSplitChildren(canonicalizeSplit(dock))
    const byId = Object.fromEntries(items.map((it) => [it.child.node.id, it.sizing]))
    expect(byId.projects).toMatchObject({ flexGrow: 0, flexShrink: 0, flexBasis: 120 })
    expect(byId.changes).toMatchObject({ flexGrow: 0, flexShrink: 0, flexBasis: 150 })
    expect(byId.files).toMatchObject({ flexGrow: 1, flexBasis: 0 })
  })

  it('renders a collapsed framed leaf header-only (flexBasis auto, not its basis)', () => {
    const dock = split('col', [fixed('projects', 120, true), grow('files'), fixed('changes', 150)], 'dock')
    const items = planSplitChildren(canonicalizeSplit(dock))
    const projects = items.find((it) => it.child.node.id === 'projects')!
    expect(projects.collapsed).toBe(true)
    expect(projects.sizing).toMatchObject({ flexGrow: 0, flexShrink: 0, flexBasis: 'auto' })
  })

  it('keeps a ROW-split collapsed framed leaf at its fixed basis (collapse is vertical)', () => {
    const row = split('row', [fixed('files', 220), grow('editor'), fixed('sessions', 280, true)], 'root')
    const items = planSplitChildren(canonicalizeSplit(row))
    const sessions = items.find((it) => it.child.node.id === 'sessions')!
    expect(sessions.collapsed).toBe(false) // sized as a normal fixed child
    expect(sessions.sizing).toMatchObject({ flexGrow: 0, flexShrink: 0, flexBasis: 280 })
  })

  it('skips hidden children entirely', () => {
    const dock = split('col', [
      { ...fixed('projects', 120), hidden: true },
      grow('files'),
    ], 'dock')
    const items = planSplitChildren(canonicalizeSplit(dock))
    expect(items.map((it) => it.child.node.id)).toEqual(['files'])
  })
})

describe('collectFramedLeaves', () => {
  it('finds the four framed panels in the default tree with their collapse flags', () => {
    const leaves = collectFramedLeaves(defaultDesktopTree())
    expect(leaves.map((l) => l.panel).sort()).toEqual(['changes', 'files', 'projects', 'sessions'])
    expect(leaves.every((l) => l.collapsed === false)).toBe(true)
  })
})
