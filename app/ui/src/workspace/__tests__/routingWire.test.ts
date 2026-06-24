// @vitest-environment jsdom
//
// routing-wire: every IMPLICIT open path now dispatches a reducer-owned routed
// action through `useWorkspaceState`'s composed helpers. These tests drive the REAL
// hook (not a reducer mirror) so they pin the actual wiring the provider commands
// call: editor opens land in the editor-home group, session opens in the terminal-
// home group, a no-match open spawns a new center group, go-to-line keeps its
// synchronous instanceId contract, the preview fetch gate avoids a double-fetch, and
// toggle OFF reproduces today's focused-group behavior. The pure resolver + the
// OPEN_ROUTED_* reducer semantics themselves are pinned by hooks/__tests__/openRouting.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useWorkspaceState } from '../../hooks/useWorkspaceState'
import {
  groupOf, groupCount, editorTabsInGroup, terminalTabsInGroup,
} from '../panelLayoutModel'

// jsdom lacks EventSource; the useSSE singleton constructs one when useFileState
// registers its 'filetree'/'git' refresh listeners.
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly url: string
  readyState = FakeEventSource.CONNECTING
  constructor(url: string) { this.url = url }
  addEventListener(): void {}
  close(): void { this.readyState = FakeEventSource.CLOSED }
}

/** Count content GETs per path so the preview gate's no-double-fetch is observable. */
let contentFetches: string[]

function installFetch() {
  contentFetches = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    const m = url.match(/\/content\?path=([^&]+)/)
    if (m) contentFetches.push(decodeURIComponent(m[1]))
    return { ok: true, status: 200, json: async () => ({ content: '', revision: 1 }) }
  }))
}

const contentFetchCount = (path: string): number => contentFetches.filter((p) => p === path).length

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('EventSource', FakeEventSource)
  installFetch()
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** Mount the hook and return the live render-result handle. */
function mount() {
  return renderHook(() => useWorkspaceState('proj', '/repo/proj', null))
}

describe('routing-wire — separateKinds ON', () => {
  it('an editor open routes to the editor-home group, away from the focused terminal group', async () => {
    const { result } = mount()
    const g1 = result.current.resolveTarget() // the default center group

    // g1 ← editor a.ts (sep still OFF → focused group); split an empty g2 and bind a
    // terminal there so the focused group is now terminal-active.
    await act(async () => { result.current.openFileRouted('a.ts') })
    let g2 = ''
    act(() => { g2 = result.current.splitGroup(g1, 'right', false) })
    act(() => { result.current.openBoundTerminalTab(g2, 's1') })
    act(() => { result.current.toggleSeparateKinds() })
    expect(result.current.focusedPane.kind).toBe('terminal')

    // Editor open from the terminal-focused group → routes to the editor home (g1).
    await act(async () => { result.current.openFileRouted('b.ts') })

    const tree = result.current.panelLayout.desktop
    expect(editorTabsInGroup(tree, g1).map((t) => t.tabId)).toEqual(['a.ts', 'b.ts'])
    expect(editorTabsInGroup(tree, g2)).toHaveLength(0) // terminal group untouched
    expect(terminalTabsInGroup(tree, g2)).toHaveLength(1)
  })

  it('a session open routes to the terminal-home group, away from the focused editor group', async () => {
    const { result } = mount()
    const g1 = result.current.resolveTarget()

    await act(async () => { result.current.openFileRouted('a.ts') })
    let g2 = ''
    act(() => { g2 = result.current.splitGroup(g1, 'right', false) })
    act(() => { result.current.openBoundTerminalTab(g2, 's1') })
    act(() => { result.current.toggleSeparateKinds() })

    // Focus the editor group, then open a session: it must seek the terminal home (g2).
    await act(async () => { result.current.openFileRouted('b.ts') })
    expect(result.current.focusedPane.kind).toBe('editor')
    expect(groupOf(result.current.panelLayout.desktop, result.current.focusedPane.instanceId)).toBe(g1)

    act(() => { result.current.openBoundTerminalRouted('s2', true) })

    const tree = result.current.panelLayout.desktop
    const terms = terminalTabsInGroup(tree, g2)
    expect(terms).toHaveLength(2) // s1 + the routed s2 share the terminal home
    const s2Id = terms.map((t) => t.instanceId).find((id) => result.current.terminalBindings[id] === 's2')
    expect(s2Id).toBeDefined()
    expect(groupCount(tree)).toBe(2) // no new group spawned — reused the home
  })

  it('a no-match open (no group of that kind) spawns a NEW center group', async () => {
    const { result } = mount()
    const g1 = result.current.resolveTarget()

    // Only a terminal group exists; with sep ON an editor open has no editor home.
    act(() => { result.current.openBoundTerminalTab(g1, 's1') })
    act(() => { result.current.toggleSeparateKinds() })
    expect(groupCount(result.current.panelLayout.desktop)).toBe(1)

    await act(async () => { result.current.openFileRouted('a.ts') })

    const tree = result.current.panelLayout.desktop
    expect(groupCount(tree)).toBe(2) // a fresh center group was created
    const newGroup = groupOf(tree, result.current.focusedPane.instanceId)
    expect(newGroup).not.toBe(g1)
    expect(editorTabsInGroup(tree, newGroup!).map((t) => t.tabId)).toEqual(['a.ts'])
    expect(terminalTabsInGroup(tree, g1)).toHaveLength(1) // terminal group untouched
  })
})

describe('routing-wire — openFileAtLine (command-resolved, {new} group)', () => {
  it('opens into a freshly-minted center group and RETURNS that instanceId for the jump stamp', async () => {
    const { result } = mount()
    const g1 = result.current.resolveTarget()

    // Focused terminal group, no editor home, sep ON → go-to-line must mint a group.
    act(() => { result.current.openBoundTerminalTab(g1, 's1') })
    act(() => { result.current.toggleSeparateKinds() })

    let id: string | null = null
    await act(async () => { id = result.current.openFileAtLineRouted('src/a.ts') })

    const tree = result.current.panelLayout.desktop
    expect(groupCount(tree)).toBe(2)
    expect(id).not.toBeNull()
    // The returned id is the opened editor instance — the jump stamps exactly it.
    const newGroup = groupOf(tree, id!)
    expect(newGroup).not.toBe(g1)
    expect(editorTabsInGroup(tree, newGroup!).map((t) => t.instanceId)).toEqual([id])
    expect(result.current.focusedPane).toEqual({ kind: 'editor', instanceId: id })
  })
})

describe('routing-wire — preview fetch gate', () => {
  it('fetches on first preview, skips the redundant fetch once the buffer is loaded', async () => {
    const { result } = mount()

    await act(async () => { result.current.previewFileRouted('c.ts') })
    expect(contentFetchCount('c.ts')).toBe(1)
    expect(result.current.files['c.ts']?.serverContent).not.toBeNull()

    // Second preview of the same (now loaded) path: the pure content-presence gate
    // skips the fetch — no double-fetch.
    await act(async () => { result.current.previewFileRouted('c.ts') })
    expect(contentFetchCount('c.ts')).toBe(1)
  })
})

describe('routing-wire — separateKinds OFF reproduces focused-group behavior', () => {
  it('an editor open lands in the focused group even when it is terminal-active', async () => {
    const { result } = mount()
    const g1 = result.current.resolveTarget()

    await act(async () => { result.current.openFileRouted('a.ts') })
    let g2 = ''
    act(() => { g2 = result.current.splitGroup(g1, 'right', false) })
    act(() => { result.current.openBoundTerminalTab(g2, 's1') })
    expect(result.current.focusedPane.kind).toBe('terminal') // focused = g2 (terminal)

    // Sep OFF (default, no toggle): the open follows focus, not kind → lands in g2.
    await act(async () => { result.current.openFileRouted('b.ts') })

    const tree = result.current.panelLayout.desktop
    expect(editorTabsInGroup(tree, g2).map((t) => t.tabId)).toEqual(['b.ts'])
    expect(editorTabsInGroup(tree, g1).map((t) => t.tabId)).toEqual(['a.ts'])
    expect(groupCount(tree)).toBe(2) // no new group — focused-group open
  })
})
