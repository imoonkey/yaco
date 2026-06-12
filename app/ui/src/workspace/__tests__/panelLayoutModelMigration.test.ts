// Migration tests for the panel layout model: the pure, idempotent
// migrateTreeToGroups(oldTree, oldViews) -> {tree, idMap} that the persistence
// loader calls to expand the old (pre-group) tree + per-editor `editorViews`
// into the flat group model, plus mapEditorMru.
import { describe, it, expect } from 'vitest'
import {
  migrateTreeToGroups,
  mapEditorMru,
  normalizeDesktopTree,
  terminalTabsInGroup,
  groupOf,
  tabByInstance,
  firstGroupId,
  editorTabPaths,
} from '../panelLayoutModel'
import type { LayoutNode, EditorView, GroupTab } from '../../hooks/workspaceTypes'

const view = (openTabs: string[], activeTab: string | null = null, previewTab: string | null = null): EditorView =>
  ({ openTabs, activeTab, previewTab })

// The old reserved main-tabs node held editor + tasks in one slot.
const oldMain = (panels: string[], active: string): LayoutNode =>
  ({ kind: 'tabs', id: 'main', active, panels, chrome: 'none' } as unknown as LayoutNode)

const oldLeaf = (id: string, panel: string): LayoutNode =>
  ({ kind: 'leaf', id, panel } as LayoutNode)

const oldRoot = (children: LayoutNode[]): LayoutNode =>
  ({ kind: 'split', id: 'root', axis: 'row', children: children.map((node) => ({ node })) } as LayoutNode)

function allEditorTabs(tree: LayoutNode): GroupTab[] {
  const out: GroupTab[] = []
  const walk = (n: LayoutNode) => {
    if (n.kind === 'tabs') out.push(...n.tabs.filter((t) => t.kind === 'editor'))
    else if (n.kind === 'split') n.children.forEach((c) => walk(c.node))
  }
  walk(tree)
  return out
}
function leafPanels(tree: LayoutNode, out: string[] = []): string[] {
  if (tree.kind === 'leaf') out.push(tree.panel)
  else if (tree.kind === 'split') tree.children.forEach((c) => leafPanels(c.node, out))
  return out
}

describe('migrateTreeToGroups', () => {
  it('expands one old editor`s openTabs into N per-file editor tabs (tabId verbatim, order kept)', () => {
    const old = oldRoot([oldMain(['editor', 'tasks'], 'editor')])
    const views = { editor: view(['a.ts', 'b.ts', 'c.ts'], 'b.ts', 'a.ts') }
    const { tree, idMap } = migrateTreeToGroups(old, views)
    const tabs = allEditorTabs(tree)
    expect(tabs.map((t) => t.kind === 'editor' && t.tabId)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(tabs.filter((t) => t.kind === 'editor' && t.preview)).toHaveLength(1)
    expect(tabs.find((t) => t.kind === 'editor' && t.preview)!).toMatchObject({ tabId: 'a.ts' })
    const active = tabByInstance(tree, idMap.editor)
    expect(active && active.kind === 'editor' && active.tabId).toBe('b.ts')
  })

  it('lifts the old `tasks` tab into a dock leaf', () => {
    const old = oldRoot([
      oldLeaf('files', 'files'),
      oldMain(['editor', 'tasks'], 'editor'),
    ])
    const { tree } = migrateTreeToGroups(old, { editor: view([]) })
    expect(leafPanels(tree)).toContain('tasks')
    expect(leafPanels(tree)).toContain('files')
  })

  it('a diff tab with query refs migrates as one editor tab, tabId verbatim', () => {
    const diffId = 'diff:foo.ts?base=main&compare=HEAD'
    const old = oldRoot([oldMain(['editor'], 'editor')])
    const { tree } = migrateTreeToGroups(old, { editor: view([diffId], diffId) })
    const tabs = allEditorTabs(tree)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].kind === 'editor' && tabs[0].tabId).toBe(diffId)
    expect(editorTabPaths(tree)).toEqual(['foo.ts'])
  })

  it('zero open tabs -> an empty group; idMap entry is empty', () => {
    const old = oldRoot([oldMain(['editor'], 'editor')])
    const { tree, idMap } = migrateTreeToGroups(old, { editor: view([]) })
    expect(allEditorTabs(tree)).toHaveLength(0)
    expect(firstGroupId(tree)).toBeTruthy()
    expect(idMap.editor).toBe('')
  })

  it('a terminal leaf becomes a group with one terminal tab, instanceId PRESERVED, no idMap entry', () => {
    const old = oldRoot([
      oldMain(['editor'], 'editor'),
      oldLeaf('terminal', 'terminal'),
      oldLeaf('terminal:2', 'terminal'),
    ])
    const { tree, idMap } = migrateTreeToGroups(old, { editor: view(['a.ts'], 'a.ts') })
    expect(groupOf(tree, 'terminal')).toBeTruthy()
    expect(groupOf(tree, 'terminal:2')).toBeTruthy()
    expect(terminalTabsInGroup(tree, groupOf(tree, 'terminal')!)).toHaveLength(1)
    expect(idMap.terminal).toBeUndefined()
    expect(idMap['terminal:2']).toBeUndefined()
  })

  it('a secondary editor leaf expands; idMap records its active tab', () => {
    const old = oldRoot([
      oldMain(['editor'], 'editor'),
      oldLeaf('editor:2', 'editor'),
    ])
    const views = {
      editor: view(['a.ts'], 'a.ts'),
      'editor:2': view(['x.ts', 'y.ts'], 'y.ts'),
    }
    const { tree, idMap } = migrateTreeToGroups(old, views)
    const secondaryActive = tabByInstance(tree, idMap['editor:2'])
    expect(secondaryActive && secondaryActive.kind === 'editor' && secondaryActive.tabId).toBe('y.ts')
    expect(groupOf(tree, idMap.editor)).not.toBe(groupOf(tree, idMap['editor:2']))
  })

  it('the same file open in two old editors -> two tabs, two instance ids, same path', () => {
    const old = oldRoot([
      oldMain(['editor'], 'editor'),
      oldLeaf('editor:2', 'editor'),
    ])
    const views = {
      editor: view(['a.ts'], 'a.ts'),
      'editor:2': view(['a.ts'], 'a.ts'),
    }
    const { tree, idMap } = migrateTreeToGroups(old, views)
    expect(idMap.editor).not.toBe(idMap['editor:2'])
    const t1 = tabByInstance(tree, idMap.editor)
    const t2 = tabByInstance(tree, idMap['editor:2'])
    expect(t1 && t1.kind === 'editor' && t1.tabId).toBe('a.ts')
    expect(t2 && t2.kind === 'editor' && t2.tabId).toBe('a.ts')
    expect(editorTabPaths(tree)).toEqual(['a.ts'])
  })

  it('is idempotent: a tree already in the group shape is returned unchanged', () => {
    const old = oldRoot([oldMain(['editor', 'tasks'], 'editor')])
    const views = { editor: view(['a.ts', 'b.ts'], 'b.ts', 'a.ts') }
    const first = migrateTreeToGroups(old, views)
    const normalizedFirst = normalizeDesktopTree(first.tree)
    const second = migrateTreeToGroups(normalizedFirst, views)
    expect(allEditorTabs(second.tree).map((t) => t.kind === 'editor' && t.tabId))
      .toEqual(allEditorTabs(normalizedFirst).map((t) => t.kind === 'editor' && t.tabId))
    expect(second.idMap).toEqual({})
  })
})

describe('mapEditorMru', () => {
  it('maps old editor ids through idMap, dropping ids with no surviving tab', () => {
    const idMap = { editor: 'editor:5', 'editor:2': 'editor:9' }
    expect(mapEditorMru(['editor:2', 'editor', 'editor:missing'], idMap)).toEqual(['editor:9', 'editor:5'])
  })

  it('de-dupes and handles an empty/undefined mru', () => {
    expect(mapEditorMru(undefined, {})).toEqual([])
    expect(mapEditorMru(['editor', 'editor'], { editor: 'editor:1' })).toEqual(['editor:1'])
  })
})
