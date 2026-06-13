// Command-surface flows for the session gestures the WorkspaceProvider owns
// (vt-commands): clickSession, openBeside, the per-session reconcile, and
// rename-all-bound. The provider's command callbacks are component-local
// closures, so these drive the SAME composition the provider does — the flat
// resolvers from `useWorkspaceSessions` + the real `instanceReducer`/`targetGroup`
// — and assert the user-observable tree/binding outcome (which group a bound
// terminal lands in, that a click never rebinds, that a dead session's tab
// closes, that rename rebinds every bound terminal). The reducer mechanics
// themselves are pinned by instanceReducer.test.ts; this pins the wiring.
import { describe, it, expect } from 'vitest'
import {
  resolveSessionClick, resolveOpenBeside, stepSessionMisses,
} from '../useWorkspaceSessions'
import {
  instanceReducer, buildInstanceState, targetGroup, type InstanceState,
} from '../../hooks/useLayoutState'
import {
  type WorkspacePanelLayout, type GroupTab, type LayoutNode, type PersistedState,
  DEFAULT_LAYOUT,
} from '../../hooks/workspaceTypes'
import {
  normalizeLayout, firstGroupId, groupOf, newInstanceId, collectIds,
  terminalInstancesInOrder, terminalTabsInGroup, editorTabsInGroup,
} from '../panelLayoutModel'
import type { JumpRequest } from '../context'

// --- Fixtures ---------------------------------------------------------------

const editorTab = (instanceId: string, tabId: string): GroupTab => ({ instanceId, kind: 'editor', tabId })
const terminalTab = (instanceId: string): GroupTab => ({ instanceId, kind: 'terminal' })

/** A dock leaf + the given working groups (first grows). */
function groupsLayout(groups: Array<{ id: string; tabs: GroupTab[] }>): WorkspacePanelLayout {
  return normalizeLayout({
    desktop: {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        ...groups.map((g, i) => ({
          ...(i === 0 ? { grow: true } : {}),
          node: { kind: 'tabs', id: g.id, tabs: g.tabs, activeTab: g.tabs[0]?.instanceId ?? '' },
        })),
      ],
    },
  })
}

function makeState(layout: WorkspacePanelLayout, opts: {
  terminalBindings?: Record<string, string>
  editorMru?: string[]
  terminalMru?: string[]
  activeGroupId?: string
} = {}): InstanceState {
  const initial: PersistedState = {
    panelLayout: layout,
    terminalBindings: opts.terminalBindings ?? {},
    editorMru: opts.editorMru ?? [],
    terminalMru: opts.terminalMru ?? [],
    activeGroupId: opts.activeGroupId ?? firstGroupId(layout.desktop) ?? 'group:1',
    mobilePane: 'files',
    layout: DEFAULT_LAYOUT,
    recentFiles: [],
  }
  return buildInstanceState(initial)
}

const freshGroupId = (tree: LayoutNode): string => {
  const ids = collectIds(tree)
  let n = 1
  while (ids.has(`group:${n}`)) n++
  return `group:${n}`
}

// --- Provider command wiring (mirrors WorkspaceProvider.tsx) -----------------
//
// `groupForInstance(id) = groupOf(tree, id) ?? targetGroup`, `resolveTarget() =
// targetGroup`. clickSession: focus → SET_ACTIVE_GROUP_TAB + PIN_TAB the shown tab
// (preview → pinned on re-click); create → OPEN_BOUND_TERMINAL_TAB (preview) into the
// target group. openBeside: focus, else SPLIT_GROUP (seed:false — empty) then
// OPEN_BOUND_TERMINAL_TAB (pinned) into the new group.

function clickSession(state: InstanceState, name: string): InstanceState {
  const tree = state.panelLayout.desktop
  const action = resolveSessionClick(name, state.terminalBindings)
  if (action.kind === 'focus') {
    const groupId = groupOf(tree, action.terminalId) ?? targetGroup(state)
    const focused = instanceReducer(state, { type: 'SET_ACTIVE_GROUP_TAB', groupId, instanceId: action.terminalId })
    return instanceReducer(focused, { type: 'PIN_TAB', groupId, instanceId: action.terminalId })
  }
  return instanceReducer(state, {
    type: 'OPEN_BOUND_TERMINAL_TAB', groupId: targetGroup(state), session: name,
    newId: newInstanceId(tree, 'terminal'), preview: true, protectedPaths: new Set(),
  })
}

function openBeside(state: InstanceState, name: string): InstanceState {
  const tree = state.panelLayout.desktop
  const action = resolveOpenBeside(name, state.terminalBindings)
  if (action.kind === 'focus') {
    const groupId = groupOf(tree, action.terminalId) ?? targetGroup(state)
    return instanceReducer(state, { type: 'SET_ACTIVE_GROUP_TAB', groupId, instanceId: action.terminalId })
  }
  const newGroupId = freshGroupId(tree)
  const split = instanceReducer(state, { type: 'SPLIT_GROUP', fromGroupId: targetGroup(state), side: 'right', newGroupId, seed: false })
  return instanceReducer(split, {
    type: 'OPEN_BOUND_TERMINAL_TAB', groupId: newGroupId, session: name,
    newId: newInstanceId(split.panelLayout.desktop, 'terminal'), preview: false, protectedPaths: new Set(),
  })
}

/** One reconcile poll: read the dead set from the miss-count, then close every
 *  terminal tab bound to a dead session (CLOSE_GROUP_TAB per bound id). */
function reconcile(
  state: InstanceState, miss: ReadonlyMap<string, number>, live: ReadonlySet<string>,
): { state: InstanceState; next: Map<string, number> } {
  const bound = new Set(Object.values(state.terminalBindings).filter(Boolean))
  const { next, dead } = stepSessionMisses(miss, bound, live)
  const deadSet = new Set(dead)
  let s = state
  for (const [id, session] of Object.entries(state.terminalBindings)) {
    if (!deadSet.has(session)) continue
    const groupId = groupOf(s.panelLayout.desktop, id) ?? targetGroup(s)
    s = instanceReducer(s, { type: 'CLOSE_GROUP_TAB', groupId, instanceId: id })
  }
  return { state: s, next }
}

/** rename-all-bound: every terminal bound to `oldName` rebinds to `newName`. */
function renameBound(state: InstanceState, oldName: string, newName: string): InstanceState {
  let s = state
  for (const [id, session] of Object.entries(state.terminalBindings)) {
    if (session === oldName) s = instanceReducer(s, { type: 'BIND_TERMINAL', id, session: newName })
  }
  return s
}

// openFileAtLine: resolve the target group, open (or activate) the file there, and
// stamp the jump with the resulting instance (openTab's return = the reducer's
// focused instance after OPEN_TAB). The stamp targets exactly one tab so a same-path
// sibling in another group never double-consumes the jump.
function openFileAtLine(state: InstanceState, path: string, line: number): { state: InstanceState; jump: JumpRequest } {
  const tree = state.panelLayout.desktop
  const groupId = targetGroup(state)
  const existing = editorTabsInGroup(tree, groupId).find((t) => t.tabId === path)
  const newId = newInstanceId(tree, 'editor')
  const instanceId = existing?.instanceId ?? newId
  const next = instanceReducer(state, { type: 'OPEN_TAB', groupId, tab: editorTab(newId, path) })
  return { state: next, jump: { key: 1, path, line, instanceId } }
}

// --- clickSession -----------------------------------------------------------

describe('clickSession (create — bound on create)', () => {
  it('creates a terminal tab bound on create in the target group', () => {
    const state = makeState(groupsLayout([{ id: 'group:1', tabs: [editorTab('editor', 'a.ts')] }]))
    const next = clickSession(state, 's1')

    const terms = terminalTabsInGroup(next.panelLayout.desktop, 'group:1')
    expect(terms).toHaveLength(1)
    expect(next.terminalBindings[terms[0].instanceId]).toBe('s1')
    // bound on create + focused + the group's active tab
    expect(next.focusedPane).toEqual({ kind: 'terminal', instanceId: terms[0].instanceId })
  })

  it('lands the bound terminal in a FOCUSED EMPTY group (activeGroupId target)', () => {
    const state = makeState(
      groupsLayout([{ id: 'group:1', tabs: [editorTab('editor', 'a.ts')] }, { id: 'group:2', tabs: [] }]),
      { activeGroupId: 'group:2' },
    )
    expect(targetGroup(state)).toBe('group:2')
    const next = clickSession(state, 's1')

    const inG2 = terminalTabsInGroup(next.panelLayout.desktop, 'group:2')
    expect(inG2).toHaveLength(1)
    expect(next.terminalBindings[inG2[0].instanceId]).toBe('s1')
    // the original group is untouched
    expect(editorTabsInGroup(next.panelLayout.desktop, 'group:1').map((t) => t.tabId)).toEqual(['a.ts'])
    expect(terminalTabsInGroup(next.panelLayout.desktop, 'group:1')).toHaveLength(0)
  })

  it('NEVER rebinds an existing terminal — a new session spawns a second bound tab (Bug 3)', () => {
    const state = makeState(
      groupsLayout([{ id: 'group:1', tabs: [terminalTab('terminal')] }]),
      { terminalBindings: { terminal: 's1' }, terminalMru: ['terminal'] },
    )
    const next = clickSession(state, 's2')

    const terms = terminalInstancesInOrder(next.panelLayout.desktop)
    expect(terms).toHaveLength(2) // s1's terminal survives; s2 gets its own
    expect(next.terminalBindings['terminal']).toBe('s1') // original binding untouched
    const s2Id = terms.find((id) => next.terminalBindings[id] === 's2')
    expect(s2Id).toBeDefined()
  })
})

describe('clickSession (focus — no dup PTY, no rebind)', () => {
  it('focuses the tab already showing the session without creating or rebinding', () => {
    const state = makeState(
      groupsLayout([
        { id: 'group:1', tabs: [terminalTab('terminal')] },
        { id: 'group:2', tabs: [terminalTab('terminal:2')] },
      ]),
      { terminalBindings: { terminal: 's1', 'terminal:2': 's2' }, activeGroupId: 'group:2' },
    )
    const next = clickSession(state, 's1')

    expect(terminalInstancesInOrder(next.panelLayout.desktop)).toEqual(['terminal', 'terminal:2']) // no dup
    expect(next.terminalBindings).toEqual({ terminal: 's1', 'terminal:2': 's2' }) // no rebind
    expect(next.activeGroupId).toBe('group:1')
    expect(next.focusedPane).toEqual({ kind: 'terminal', instanceId: 'terminal' })
  })
})

// --- openBeside -------------------------------------------------------------

describe('openBeside', () => {
  it('splits an EMPTY group then binds the terminal in the NEW group', () => {
    const state = makeState(groupsLayout([{ id: 'group:1', tabs: [editorTab('editor', 'a.ts')] }]))
    const next = openBeside(state, 's1')

    const newGroupId = next.activeGroupId
    expect(newGroupId).not.toBe('group:1')
    const inNew = terminalTabsInGroup(next.panelLayout.desktop, newGroupId)
    expect(inNew).toHaveLength(1)
    expect(next.terminalBindings[inNew[0].instanceId]).toBe('s1')
    // the source group keeps its file tab — split never moves or clones it
    expect(editorTabsInGroup(next.panelLayout.desktop, 'group:1').map((t) => t.tabId)).toEqual(['a.ts'])
  })

  it('focuses the existing terminal (1-per-session) instead of splitting', () => {
    const state = makeState(
      groupsLayout([{ id: 'group:1', tabs: [terminalTab('terminal')] }]),
      { terminalBindings: { terminal: 's1' } },
    )
    const next = openBeside(state, 's1')

    expect(terminalInstancesInOrder(next.panelLayout.desktop)).toEqual(['terminal']) // no split, no new terminal
    expect(next.focusedPane).toEqual({ kind: 'terminal', instanceId: 'terminal' })
  })
})

// --- reconcile (per-session miss-count) -------------------------------------

describe('reconcile', () => {
  it('closes the dead terminal tab on the first absent poll for a restored (pre-seeded) binding', () => {
    const state = makeState(
      groupsLayout([{ id: 'group:1', tabs: [editorTab('editor', 'a.ts'), terminalTab('terminal')] }]),
      { terminalBindings: { terminal: 's1' }, terminalMru: ['terminal'] },
    )
    // Restored binding pre-seeded at miss-count 1 → one absent poll reaches 2 (dead).
    const seeded = new Map([['s1', 1]])
    const { state: after, next } = reconcile(state, seeded, new Set())

    expect(terminalInstancesInOrder(after.panelLayout.desktop)).toHaveLength(0) // tab closed
    expect(after.terminalBindings).toEqual({}) // binding GC'd with the tab
    expect(editorTabsInGroup(after.panelLayout.desktop, 'group:1').map((t) => t.tabId)).toEqual(['a.ts']) // file tab survives
    expect(next.has('s1')).toBe(false) // dead, not carried forward
  })

  it('does NOT close on a single absent poll for a freshly-bound (un-seeded) session', () => {
    const state = makeState(
      groupsLayout([{ id: 'group:1', tabs: [terminalTab('terminal')] }]),
      { terminalBindings: { terminal: 's1' }, terminalMru: ['terminal'] },
    )
    const { state: after, next } = reconcile(state, new Map(), new Set())

    expect(terminalInstancesInOrder(after.panelLayout.desktop)).toEqual(['terminal']) // survives the first miss
    expect(next.get('s1')).toBe(1) // one miss recorded; a second absent poll would kill it
  })
})

// --- rename-all-bound -------------------------------------------------------

describe('rename', () => {
  it('rebinds every terminal bound to the renamed session, leaving others alone', () => {
    const state = makeState(
      groupsLayout([
        { id: 'group:1', tabs: [terminalTab('terminal'), terminalTab('terminal:3')] },
        { id: 'group:2', tabs: [terminalTab('terminal:2')] },
      ]),
      { terminalBindings: { terminal: 's1', 'terminal:3': 's1', 'terminal:2': 's2' } },
    )
    const next = renameBound(state, 's1', 's9')

    expect(next.terminalBindings).toEqual({ terminal: 's9', 'terminal:3': 's9', 'terminal:2': 's2' })
  })
})

// --- openFileAtLine (go-to-line stamps the opened instance) -----------------

describe('openFileAtLine', () => {
  it('stamps the target group\'s tab — a same-path sibling in another group never jumps', () => {
    // The same file open as two tabs in two groups; group:2 is the active target.
    const state = makeState(
      groupsLayout([
        { id: 'group:1', tabs: [editorTab('editor', 'src/a.ts')] },
        { id: 'group:2', tabs: [editorTab('editor:2', 'src/a.ts')] },
      ]),
      { activeGroupId: 'group:2', editorMru: ['editor:2', 'editor'] },
    )
    const { state: after, jump } = openFileAtLine(state, 'src/a.ts', 10)

    // The stamp targets group:2's tab (the resolved target) — its sibling 'editor'
    // in group:1 shares the path but is NOT the stamp, so it does not jump.
    expect(jump.instanceId).toBe('editor:2')
    // The stamp IS the instance the reducer activated/focused (openTab's contract).
    expect(after.focusedPane).toEqual({ kind: 'editor', instanceId: 'editor:2' })
  })

  it('stamps the freshly-created instance when the target group has no tab for the path', () => {
    const state = makeState(
      groupsLayout([
        { id: 'group:1', tabs: [editorTab('editor', 'src/a.ts')] },
        { id: 'group:2', tabs: [] },
      ]),
      { activeGroupId: 'group:2' },
    )
    const { state: after, jump } = openFileAtLine(state, 'src/a.ts', 5)

    // A brand-new tab in group:2 carries the stamp; group:1's sibling is untouched.
    const g2 = editorTabsInGroup(after.panelLayout.desktop, 'group:2')
    expect(g2).toHaveLength(1)
    expect(jump.instanceId).toBe(g2[0].instanceId)
    expect(jump.instanceId).not.toBe('editor')
    expect(after.focusedPane).toEqual({ kind: 'editor', instanceId: jump.instanceId })
  })
})
