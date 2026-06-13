// Unit tests for the DnD tab/group movers (pure transforms). No DOM. Pins the
// structural contracts: identity-preserving tab move with neighbour-active fall and
// center-scoped / sidebar empty-source handling, deterministic group merge (append +
// one preview + moved-in active), and detach-and-insert-beside group relocation.
import { describe, it, expect } from 'vitest'
import {
  moveTabBetweenGroups,
  mergeGroups,
  moveGroupBeside,
  normalizeDesktopTree,
  defaultWorkspacePanelLayout,
  tabsInGroup,
  centerOf,
} from '../panelLayoutModel'
import type { LayoutNode, SplitNode, TabsNode, GroupTab, WorkspacePanelLayout } from '../../hooks/workspaceTypes'

// --- Fixtures ---------------------------------------------------------------

const ed = (instanceId: string, tabId: string, extra: Record<string, unknown> = {}): GroupTab =>
  ({ instanceId, kind: 'editor', tabId, ...extra } as GroupTab)
const term = (instanceId: string): GroupTab => ({ instanceId, kind: 'terminal' })
const grp = (id: string, tabs: GroupTab[]): unknown =>
  ({ kind: 'tabs', id, tabs, activeTab: tabs[0]?.instanceId ?? '' })
const leaf = (panel: string): unknown => ({ kind: 'leaf', id: panel, panel })

function layoutOf(desktop: unknown): WorkspacePanelLayout {
  return { ...defaultWorkspacePanelLayout(), desktop: normalizeDesktopTree(desktop) }
}

/** A root row with TWO groups inside the center split (left dock, right activity). */
function twoCenterGroups(g1: GroupTab[], g2: GroupTab[]): WorkspacePanelLayout {
  return layoutOf({
    kind: 'split', id: 'root', axis: 'row', children: [
      { node: leaf('files') },
      { grow: true, node: { kind: 'split', id: 'center', axis: 'row', children: [
        { grow: true, node: grp('group:1', g1) },
        { node: grp('group:2', g2) },
      ] } },
      { node: leaf('sessions') },
    ],
  })
}

/** A root row with ONE center group and ONE right-sidebar group. */
function centerAndRightGroup(g1: GroupTab[], gR: GroupTab[]): WorkspacePanelLayout {
  return layoutOf({
    kind: 'split', id: 'root', axis: 'row', children: [
      { node: leaf('files') },
      { grow: true, node: grp('group:1', g1) },
      { node: grp('group:R', gR) },
    ],
  })
}

function findGroup(tree: LayoutNode, id: string): TabsNode | null {
  if (tree.kind === 'tabs') return tree.id === id ? tree : null
  if (tree.kind === 'split') {
    for (const c of tree.children) { const hit = findGroup(c.node, id); if (hit) return hit }
  }
  return null
}

function findSplit(tree: LayoutNode, id: string): SplitNode | null {
  if (tree.kind !== 'split') return null
  if (tree.id === id) return tree
  for (const c of tree.children) { const hit = findSplit(c.node, id); if (hit) return hit }
  return null
}

const ids = (tabs: GroupTab[]): string[] => tabs.map((t) => t.instanceId)

// --- moveTabBetweenGroups ---------------------------------------------------

describe('moveTabBetweenGroups', () => {
  it('reorders within a group (from===to) and makes the moved tab active', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts'), ed('e2', 'b.ts'), ed('e3', 'c.ts')], [ed('e9', 'z.ts')])
    const next = moveTabBetweenGroups(l, 'group:1', 'e1', 'group:1', 2)
    const g = findGroup(next.desktop, 'group:1')!
    expect(ids(g.tabs)).toEqual(['e2', 'e3', 'e1'])
    expect(g.activeTab).toBe('e1')
  })

  it('moves a tab across groups preserving its identity + payload, target active = moved', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts'), ed('e2', 'b.ts')], [ed('e9', 'z.ts')])
    const next = moveTabBetweenGroups(l, 'group:1', 'e2', 'group:2', 0)
    expect(ids(findGroup(next.desktop, 'group:1')!.tabs)).toEqual(['e1'])
    const dst = findGroup(next.desktop, 'group:2')!
    expect(dst.tabs).toEqual([ed('e2', 'b.ts'), ed('e9', 'z.ts')])
    expect(dst.activeTab).toBe('e2')
  })

  it('moving the source active tab drops source active to the neighbour', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts'), ed('e2', 'b.ts')], [ed('e9', 'z.ts')])
    // group:1 active is e1 (first). Move it out → active falls to e2.
    const next = moveTabBetweenGroups(l, 'group:1', 'e1', 'group:2', 99)
    expect(findGroup(next.desktop, 'group:1')!.activeTab).toBe('e2')
  })

  it('a center source that empties CLOSES when another center group exists', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')])
    const next = moveTabBetweenGroups(l, 'group:1', 'e1', 'group:2', 99)
    expect(findGroup(next.desktop, 'group:1')).toBeNull()
    expect(ids(findGroup(next.desktop, 'group:2')!.tabs)).toEqual(['e2', 'e1'])
  })

  it('the LAST center source that empties stays empty (a sidebar group exists)', () => {
    const l = centerAndRightGroup([ed('e1', 'a.ts')], [ed('r1', 'r.ts')])
    const next = moveTabBetweenGroups(l, 'group:1', 'e1', 'group:R', 99)
    const center = centerOf(next.desktop)!
    expect(findGroup(center, 'group:1')).not.toBeNull()
    expect(tabsInGroup(next.desktop, 'group:1')).toEqual([])
    expect(ids(findGroup(next.desktop, 'group:R')!.tabs)).toEqual(['r1', 'e1'])
  })

  it('a right-sidebar source that empties is REMOVED', () => {
    const l = centerAndRightGroup([ed('e1', 'a.ts')], [ed('r1', 'r.ts')])
    const next = moveTabBetweenGroups(l, 'group:R', 'r1', 'group:1', 99)
    expect(findGroup(next.desktop, 'group:R')).toBeNull()
    expect(ids(findGroup(next.desktop, 'group:1')!.tabs)).toEqual(['e1', 'r1'])
  })

  it('is a no-op when the tab or a group is absent', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')])
    expect(moveTabBetweenGroups(l, 'group:1', 'nope', 'group:2', 0)).toBe(l)
    expect(moveTabBetweenGroups(l, 'group:1', 'e1', 'group:x', 0)).toBe(l)
  })

  it('preview travels: a clean preview in the target is dropped, a protected one is pinned', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts', { preview: true })], [ed('e2', 'b.ts', { preview: true })])
    // Clean target preview e2 → dropped, only the moved preview survives.
    const clean = moveTabBetweenGroups(l, 'group:1', 'e1', 'group:2', 0)
    expect(ids(findGroup(clean.desktop, 'group:2')!.tabs)).toEqual(['e1'])
    // Protected (dirty) target preview e2 → pinned, the tab stays without preview.
    const pinned = moveTabBetweenGroups(l, 'group:1', 'e1', 'group:2', 0, new Set(['b.ts']))
    const dst = findGroup(pinned.desktop, 'group:2')!
    expect(ids(dst.tabs)).toEqual(['e1', 'e2'])
    expect(dst.tabs.find((t) => t.instanceId === 'e2')!.preview).toBeUndefined()
  })
})

// --- mergeGroups ------------------------------------------------------------

describe('mergeGroups', () => {
  it('appends src tabs to dst, removes src, active = src moved-in active', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')])
    const next = mergeGroups(l, 'group:1', 'group:2')
    expect(findGroup(next.desktop, 'group:1')).toBeNull()
    const dst = findGroup(next.desktop, 'group:2')!
    expect(ids(dst.tabs)).toEqual(['e2', 'e1'])
    expect(dst.activeTab).toBe('e1')
  })

  it('keeps exactly one preview across the merged strip (first wins)', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts', { preview: true })], [ed('e2', 'b.ts', { preview: true })])
    const dst = findGroup(mergeGroups(l, 'group:1', 'group:2').desktop, 'group:2')!
    expect(dst.tabs.filter((t) => t.preview).map((t) => t.instanceId)).toEqual(['e2'])
  })

  it('is a no-op on a self-merge or an absent group', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')])
    expect(mergeGroups(l, 'group:1', 'group:1')).toBe(l)
    expect(mergeGroups(l, 'group:1', 'group:x')).toBe(l)
  })
})

// --- moveGroupBeside --------------------------------------------------------

describe('moveGroupBeside', () => {
  it('detaches the group and inserts it beside the target on the given axis', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')])
    const next = moveGroupBeside(l, 'group:2', 'group:1', 'below')
    expect(findGroup(next.desktop, 'group:1')).not.toBeNull()
    expect(findGroup(next.desktop, 'group:2')).not.toBeNull()
    expect(findSplit(next.desktop, 'split:group:2')!.axis).toBe('col')
  })

  it('is a no-op on a self-drop or an absent group/target', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts')], [ed('e2', 'b.ts')])
    expect(moveGroupBeside(l, 'group:1', 'group:1', 'right')).toBe(l)
    expect(moveGroupBeside(l, 'group:x', 'group:1', 'right')).toBe(l)
    expect(moveGroupBeside(l, 'group:1', 'group:x', 'right')).toBe(l)
  })

  it('relocates a terminal group intact (same instance ids travel)', () => {
    const l = twoCenterGroups([ed('e1', 'a.ts')], [term('t1')])
    const next = moveGroupBeside(l, 'group:2', 'group:1', 'right')
    expect(findGroup(next.desktop, 'group:2')!.tabs).toEqual([term('t1')])
  })
})
