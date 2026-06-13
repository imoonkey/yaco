// @vitest-environment jsdom
//
// Unit tests for kind-routed opens (design: separateKinds — "The rule, derived, no
// stored kind" + "Reducer-owned routed open"). They pin the pure resolvers
// (activeTabKind / resolveOpenTarget / splitCenterGroup), the in-reducer id minting
// that coalesces rapid routed opens into ONE new group, and the separateKinds flag's
// default-off + normalize-coerce behavior (off ≡ key omitted, like preview/pinned).
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  instanceReducer, buildInstanceState, useLayoutState,
  activeTabKind, resolveOpenTarget, splitCenterGroup,
  type InstanceState,
} from '../useLayoutState'
import {
  type WorkspacePanelLayout, type PersistedState, type TabsNode, type GroupTab,
  DEFAULT_LAYOUT,
} from '../workspaceTypes'
import {
  normalizeLayout, defaultWorkspacePanelLayout, groupCount, groupOf,
  editorInstancesInOrder, editorTabPaths, tabsInGroup,
} from '../../workspace/panelLayoutModel'

// --- Fixtures ---------------------------------------------------------------

const editor = (instanceId: string, tabId: string, extra: Partial<GroupTab> = {}): GroupTab =>
  ({ instanceId, kind: 'editor', tabId, ...extra } as GroupTab)
const term = (instanceId: string, extra: Partial<GroupTab> = {}): GroupTab =>
  ({ instanceId, kind: 'terminal', ...extra } as GroupTab)

const NO_PROTECT: ReadonlySet<string> = new Set()

const group = (id: string, tabs: GroupTab[], activeTab = tabs[0]?.instanceId ?? ''): TabsNode =>
  ({ kind: 'tabs', id, tabs, activeTab })

type Child = { node: unknown; grow?: boolean }

/** A normalized layout from explicit root-row children; `sep` turns separateKinds on
 *  (set AFTER normalize, since a false/missing value normalizes to off — omitted). */
function layoutFrom(children: Child[], sep = false): WorkspacePanelLayout {
  const l = normalizeLayout({ desktop: { kind: 'split', id: 'root', axis: 'row', children } })
  return sep ? { ...l, panelState: { ...l.panelState, separateKinds: true } } : l
}

const files: Child = { node: { kind: 'leaf', id: 'files', panel: 'files' } }
const center = (g: TabsNode): Child => ({ grow: true, node: g })
const side = (g: TabsNode): Child => ({ node: g })

function stateFrom(layout: WorkspacePanelLayout, opts: {
  editorMru?: string[]; terminalMru?: string[]; activeGroupId?: string
  terminalBindings?: Record<string, string>
} = {}): InstanceState {
  const initial: PersistedState = {
    panelLayout: layout,
    terminalBindings: opts.terminalBindings ?? {},
    editorMru: opts.editorMru ?? [],
    terminalMru: opts.terminalMru ?? [],
    activeGroupId: opts.activeGroupId ?? '',
    mobilePane: 'files',
    layout: DEFAULT_LAYOUT,
    recentFiles: [],
  }
  return buildInstanceState(initial)
}

// --- activeTabKind ----------------------------------------------------------

describe('activeTabKind', () => {
  it('reports the kind of the active tab (editor / terminal)', () => {
    expect(activeTabKind(group('g', [editor('e1', 'a.ts')]))).toBe('editor')
    expect(activeTabKind(group('g', [term('t1')]))).toBe('terminal')
  })

  it('a diff tab counts as editor-kind', () => {
    expect(activeTabKind(group('g', [editor('e1', 'diff:a.ts')]))).toBe('editor')
  })

  it("is '' for an empty group, a null group, or a dangling active id", () => {
    expect(activeTabKind(group('g', [], ''))).toBe('')
    expect(activeTabKind(null)).toBe('')
    expect(activeTabKind(group('g', [editor('e1', 'a.ts')], 'gone'))).toBe('')
  })

  it('derives the ACTIVE tab in a mixed group, not the first tab', () => {
    const g = group('g', [editor('e1', 'a.ts'), term('t1')], 't1')
    expect(activeTabKind(g)).toBe('terminal')
  })
})

// --- resolveOpenTarget ------------------------------------------------------

describe('resolveOpenTarget', () => {
  it('separateKinds OFF: always the resolved focus group', () => {
    const layout = layoutFrom([files, center(group('group:1', [term('t1')]))])
    const state = stateFrom(layout, { terminalMru: ['t1'], activeGroupId: 'group:1' })
    expect(resolveOpenTarget('editor', state)).toEqual({ groupId: 'group:1' })
  })

  it('kind matches the focused group → that group', () => {
    const ed = layoutFrom([files, center(group('group:1', [editor('e1', 'a.ts')]))], true)
    expect(resolveOpenTarget('editor', stateFrom(ed, { editorMru: ['e1'], activeGroupId: 'group:1' })))
      .toEqual({ groupId: 'group:1' })
    const tm = layoutFrom([files, center(group('group:1', [term('t1')]))], true)
    expect(resolveOpenTarget('terminal', stateFrom(tm, { terminalMru: ['t1'], activeGroupId: 'group:1' })))
      .toEqual({ groupId: 'group:1' })
  })

  it('empty focused group accepts either kind', () => {
    const layout = layoutFrom([files, center(group('group:1', [], ''))], true)
    expect(resolveOpenTarget('editor', stateFrom(layout, { activeGroupId: 'group:1' })))
      .toEqual({ groupId: 'group:1' })
  })

  it('mismatched kind: skips the focused group, takes the most-recent OTHER K-group via MRU', () => {
    // group:1 is terminal-active but also holds an editor (e1); the editor open must
    // NOT reuse it — it routes to group:2 (the other editor group, next in editorMru).
    const layout = layoutFrom([
      files,
      center(group('group:1', [editor('e1', 'a.ts'), term('t1')], 't1')),
      side(group('group:2', [editor('e2', 'b.ts')])),
    ], true)
    const state = stateFrom(layout, { editorMru: ['e1', 'e2'], terminalMru: ['t1'], activeGroupId: 'group:1' })
    expect(resolveOpenTarget('editor', state)).toEqual({ groupId: 'group:2' })
  })

  it('routes a terminal open to the right-sidebar terminal home', () => {
    const layout = layoutFrom([
      files,
      center(group('group:1', [editor('e1', 'a.ts')])),
      side(group('group:2', [term('t1')])),
    ], true)
    const state = stateFrom(layout, { editorMru: ['e1'], terminalMru: ['t1'], activeGroupId: 'group:1' })
    expect(resolveOpenTarget('terminal', state)).toEqual({ groupId: 'group:2' })
  })

  it('ignores stale MRU ids (no longer in the tree)', () => {
    const layout = layoutFrom([files, center(group('group:1', [term('t1')]))], true)
    // 'ghost' is not a live instance → skipped → no other editor group → new.
    const state = stateFrom(layout, { editorMru: ['ghost'], terminalMru: ['t1'], activeGroupId: 'group:1' })
    expect(resolveOpenTarget('editor', state)).toEqual({ new: true })
  })

  it('no group of kind K → asks for a NEW group', () => {
    const layout = layoutFrom([files, center(group('group:1', [term('t1')]))], true)
    const state = stateFrom(layout, { terminalMru: ['t1'], activeGroupId: 'group:1' })
    expect(resolveOpenTarget('editor', state)).toEqual({ new: true })
  })
})

// --- splitCenterGroup -------------------------------------------------------

describe('splitCenterGroup', () => {
  it('splits a fresh EMPTY group beside the center, id minted from the live tree', () => {
    const layout = layoutFrom([files, center(group('group:1', [editor('e1', 'a.ts')]))])
    const [next, newId] = splitCenterGroup(stateFrom(layout, { activeGroupId: 'group:1' }))
    expect(newId).toBe('group:2')
    expect(groupCount(next.desktop)).toBe(2)
    expect(tabsInGroup(next.desktop, 'group:2')).toEqual([]) // empty (seed:false)
    expect(editorTabPaths(next.desktop)).toEqual(['a.ts']) // source untouched
  })

  it('mints around existing group ids (skips taken slots)', () => {
    const layout = layoutFrom([
      files,
      center(group('group:1', [editor('e1', 'a.ts')])),
      side(group('group:2', [editor('e2', 'b.ts')])),
    ])
    const [, newId] = splitCenterGroup(stateFrom(layout, { activeGroupId: 'group:1' }))
    expect(newId).toBe('group:3')
  })
})

// --- Reducer-owned routed opens (coalescing) --------------------------------

describe('OPEN_ROUTED_* reducer actions', () => {
  it('two rapid previews with NO editor group create exactly ONE new group', () => {
    const layout = layoutFrom([files, center(group('group:1', [term('t1')]))], true)
    const s0 = stateFrom(layout, { terminalMru: ['t1'], activeGroupId: 'group:1' })

    const s1 = instanceReducer(s0, { type: 'OPEN_ROUTED_PREVIEW_TAB', tabId: 'a.ts', protectedPaths: NO_PROTECT })
    expect(groupCount(s1.panelLayout.desktop)).toBe(2) // first open spawned a group
    expect(s1.activeGroupId).toBe('group:2')

    const s2 = instanceReducer(s1, { type: 'OPEN_ROUTED_PREVIEW_TAB', tabId: 'b.ts', protectedPaths: NO_PROTECT })
    expect(groupCount(s2.panelLayout.desktop)).toBe(2) // second open spawned NONE — coalesced
    expect(s2.activeGroupId).toBe('group:2')
    // every editor instance lives in the single new group; the terminal group is untouched.
    const editors = editorInstancesInOrder(s2.panelLayout.desktop)
    expect(editors.length).toBeGreaterThan(0)
    expect(editors.every((id) => groupOf(s2.panelLayout.desktop, id) === 'group:2')).toBe(true)
  })

  it('OPEN_ROUTED_TAB with no editor group lands both pinned tabs in one new group', () => {
    const layout = layoutFrom([files, center(group('group:1', [term('t1')]))], true)
    let s = stateFrom(layout, { terminalMru: ['t1'], activeGroupId: 'group:1' })
    s = instanceReducer(s, { type: 'OPEN_ROUTED_TAB', tabId: 'a.ts' })
    s = instanceReducer(s, { type: 'OPEN_ROUTED_TAB', tabId: 'b.ts' })
    expect(groupCount(s.panelLayout.desktop)).toBe(2)
    expect(tabsInGroup(s.panelLayout.desktop, 'group:2').map((t) => (t.kind === 'editor' ? t.tabId : t.kind)))
      .toEqual(['a.ts', 'b.ts']) // distinct in-reducer-minted instance ids, one group
  })

  it('a routed editor open reuses the kind-matching focused group (no split)', () => {
    const layout = layoutFrom([files, center(group('group:1', [editor('e1', 'a.ts')]))], true)
    const s0 = stateFrom(layout, { editorMru: ['e1'], activeGroupId: 'group:1' })
    const s1 = instanceReducer(s0, { type: 'OPEN_ROUTED_PREVIEW_TAB', tabId: 'b.ts', protectedPaths: NO_PROTECT })
    expect(groupCount(s1.panelLayout.desktop)).toBe(1)
    expect(s1.activeGroupId).toBe('group:1')
  })

  it('routes a bound terminal open to a NEW group when only an editor group exists', () => {
    const layout = layoutFrom([files, center(group('group:1', [editor('e1', 'a.ts')]))], true)
    const s0 = stateFrom(layout, { editorMru: ['e1'], activeGroupId: 'group:1' })
    const s1 = instanceReducer(s0, { type: 'OPEN_ROUTED_BOUND_TERMINAL_TAB', session: 'sess', preview: false, protectedPaths: NO_PROTECT })
    expect(groupCount(s1.panelLayout.desktop)).toBe(2)
    const tid = s1.focusedPane.instanceId
    expect(s1.focusedPane.kind).toBe('terminal')
    expect(s1.terminalBindings[tid]).toBe('sess')
    expect(groupOf(s1.panelLayout.desktop, tid)).toBe('group:2')
  })
})

// --- separateKinds flag: default + normalize + toggle -----------------------

describe('separateKinds flag', () => {
  it('defaults OFF (omitted, ≡ false)', () => {
    expect(defaultWorkspacePanelLayout().panelState.separateKinds).toBeUndefined()
  })

  it('normalize: a stored true survives; missing/invalid/false coerce to off', () => {
    const sep = (panelState: unknown): boolean | undefined =>
      normalizeLayout({ ...defaultWorkspacePanelLayout(), panelState }).panelState.separateKinds
    expect(sep({ separateKinds: true })).toBe(true)
    expect(sep({ separateKinds: false })).toBeUndefined()
    expect(sep({ separateKinds: 'yes' })).toBeUndefined()
    expect(sep({})).toBeUndefined()
  })

  it('toggleSeparateKinds flips the panelState flag (off ≡ omitted)', () => {
    const initial: PersistedState = {
      panelLayout: defaultWorkspacePanelLayout(),
      terminalBindings: {}, editorMru: [], terminalMru: [], activeGroupId: '',
      mobilePane: 'files', layout: DEFAULT_LAYOUT, recentFiles: [],
    }
    const dirtyRef = { current: new Set<string>() as ReadonlySet<string> }
    const { result } = renderHook(() => useLayoutState(initial, dirtyRef))

    expect(result.current.panelLayout.panelState.separateKinds).toBeUndefined()
    act(() => result.current.toggleSeparateKinds())
    expect(result.current.panelLayout.panelState.separateKinds).toBe(true)
    act(() => result.current.toggleSeparateKinds())
    expect(result.current.panelLayout.panelState.separateKinds).toBeUndefined()
  })
})
