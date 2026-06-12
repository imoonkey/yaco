// Unit tests for the multi-instance reducer (mi-state). The reducer is pure, so
// these run without React. They pin: per-instance tab logic parity with the old
// global logic (preview drop / dirty-pin / close-neighbor), per-instance
// isolation, retarget/close-under fan-out across ALL views, atomic seed+GC on
// every structural transition, and the focus/MRU model.
import { describe, it, expect } from 'vitest'
import { instanceReducer, buildInstanceState, type InstanceState } from '../useLayoutState'
import {
  type WorkspacePanelLayout, type EditorView, type PersistedState,
  EMPTY_VIEW, DEFAULT_LAYOUT,
} from '../workspaceTypes'
import {
  MAIN_TABS_ID, defaultWorkspacePanelLayout, normalizeLayout,
  editorInstancesInOrder, terminalInstancesInOrder,
} from '../../workspace/panelLayoutModel'

// --- Fixtures ---------------------------------------------------------------

function makeState(opts: Partial<Pick<PersistedState, 'editorViews' | 'terminalBindings' | 'editorMru' | 'terminalMru'>> & { layout?: WorkspacePanelLayout }): InstanceState {
  return buildInstanceState({
    panelLayout: opts.layout ?? defaultWorkspacePanelLayout(),
    editorViews: opts.editorViews ?? {},
    terminalBindings: opts.terminalBindings ?? {},
    editorMru: opts.editorMru ?? [],
    terminalMru: opts.terminalMru ?? [],
    mobilePane: 'files',
    layout: DEFAULT_LAYOUT,
    recentFiles: [],
  })
}

/** A tree with the home editor + a secondary editor + two terminals. */
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

const NO_PROTECT: ReadonlySet<string> = new Set()

// --- Per-instance tab logic (parity with the old global logic) --------------

describe('editor view tab logic, keyed by instance', () => {
  it('opens a file tab as active + pinned', () => {
    const s = instanceReducer(makeState({}), { type: 'OPEN_FILE_TAB', id: 'editor', path: 'a.ts' })
    expect(s.editorViews.editor).toEqual({ openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: null })
  })

  it('drops a clean old preview when opening a new preview', () => {
    let s = makeState({ editorViews: { editor: { openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: 'a.ts' } } })
    s = instanceReducer(s, { type: 'OPEN_PREVIEW_TAB', id: 'editor', path: 'b.ts', protectedPaths: NO_PROTECT })
    expect(s.editorViews.editor).toEqual({ openTabs: ['b.ts'], activeTab: 'b.ts', previewTab: 'b.ts' })
  })

  it('keeps a DIRTY old preview pinned when opening a new preview', () => {
    let s = makeState({ editorViews: { editor: { openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: 'a.ts' } } })
    s = instanceReducer(s, { type: 'OPEN_PREVIEW_TAB', id: 'editor', path: 'b.ts', protectedPaths: new Set(['a.ts']) })
    expect(s.editorViews.editor.openTabs).toEqual(['a.ts', 'b.ts']) // a stays (auto-pinned)
    expect(s.editorViews.editor.previewTab).toBe('b.ts')
  })

  it('just activates an already-pinned tab opened as preview (no demote)', () => {
    let s = makeState({ editorViews: { editor: { openTabs: ['a.ts', 'b.ts'], activeTab: 'a.ts', previewTab: null } } })
    s = instanceReducer(s, { type: 'OPEN_PREVIEW_TAB', id: 'editor', path: 'b.ts', protectedPaths: NO_PROTECT })
    expect(s.editorViews.editor).toEqual({ openTabs: ['a.ts', 'b.ts'], activeTab: 'b.ts', previewTab: null })
  })

  it('selects the neighbour after closing the active tab', () => {
    let s = makeState({ editorViews: { editor: { openTabs: ['a.ts', 'b.ts', 'c.ts'], activeTab: 'b.ts', previewTab: null } } })
    s = instanceReducer(s, { type: 'CLOSE_TAB', id: 'editor', tab: 'b.ts' })
    expect(s.editorViews.editor).toEqual({ openTabs: ['a.ts', 'c.ts'], activeTab: 'c.ts', previewTab: null })
  })

  it('pins a preview tab (clears the preview pointer)', () => {
    let s = makeState({ editorViews: { editor: { openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: 'a.ts' } } })
    s = instanceReducer(s, { type: 'PIN_TAB', id: 'editor', path: 'a.ts' })
    expect(s.editorViews.editor.previewTab).toBeNull()
  })
})

// --- Per-instance isolation -------------------------------------------------

describe('per-instance isolation', () => {
  it('an op on one editor leaves the other untouched', () => {
    let s = makeState({
      layout: multiLayout(),
      editorViews: {
        editor: { openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: null },
        'editor:2': { openTabs: ['b.ts'], activeTab: 'b.ts', previewTab: null },
      },
    })
    s = instanceReducer(s, { type: 'OPEN_FILE_TAB', id: 'editor', path: 'x.ts' })
    expect(s.editorViews['editor:2']).toEqual({ openTabs: ['b.ts'], activeTab: 'b.ts', previewTab: null })
    expect(s.editorViews.editor.openTabs).toEqual(['a.ts', 'x.ts'])
  })
})

// --- Fan-out across all views -----------------------------------------------

describe('retarget / close-under fan out across every view', () => {
  it('retargets a renamed path in all editor views', () => {
    let s = makeState({
      layout: multiLayout(),
      editorViews: {
        editor: { openTabs: ['src/a.ts'], activeTab: 'src/a.ts', previewTab: null },
        'editor:2': { openTabs: ['src/a.ts', 'diff:src/a.ts'], activeTab: 'diff:src/a.ts', previewTab: null },
      },
    })
    s = instanceReducer(s, { type: 'RETARGET_PATHS', oldPath: 'src/a.ts', newPath: 'src/b.ts' })
    expect(s.editorViews.editor.openTabs).toEqual(['src/b.ts'])
    expect(s.editorViews['editor:2'].openTabs).toEqual(['src/b.ts', 'diff:src/b.ts'])
    expect(s.editorViews['editor:2'].activeTab).toBe('diff:src/b.ts')
  })

  it('closes tabs under a deleted dir in all editor views', () => {
    let s = makeState({
      layout: multiLayout(),
      editorViews: {
        editor: { openTabs: ['src/a.ts', 'lib/x.ts'], activeTab: 'src/a.ts', previewTab: null },
        'editor:2': { openTabs: ['src/deep/y.ts'], activeTab: 'src/deep/y.ts', previewTab: 'src/deep/y.ts' },
      },
    })
    s = instanceReducer(s, { type: 'CLOSE_TABS_UNDER', path: 'src' })
    expect(s.editorViews.editor.openTabs).toEqual(['lib/x.ts'])
    expect(s.editorViews['editor:2'].openTabs).toEqual([])
    expect(s.editorViews['editor:2'].previewTab).toBeNull()
  })
})

// --- Atomic seed + GC on structural transitions -----------------------------

describe('SET_PANEL_LAYOUT GCs maps/MRU against the tree', () => {
  it('drops views/bindings/MRU for ids the new tree no longer has', () => {
    let s = makeState({
      layout: multiLayout(),
      editorViews: {
        editor: { openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: null },
        'editor:2': { openTabs: ['b.ts'], activeTab: 'b.ts', previewTab: null },
      },
      terminalBindings: { terminal: 's1', 'terminal:2': 's2' },
      editorMru: ['editor:2', 'editor'],
      terminalMru: ['terminal:2', 'terminal'],
    })
    // Reset to the default tree (only home editor + one terminal survive).
    s = instanceReducer(s, { type: 'SET_PANEL_LAYOUT', update: defaultWorkspacePanelLayout() })
    expect(Object.keys(s.editorViews)).toEqual(['editor'])
    expect(Object.keys(s.terminalBindings)).toEqual(['terminal'])
    expect(s.editorMru).toEqual(['editor'])
    expect(s.terminalMru).toEqual(['terminal'])
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'editor' })
  })
})

describe('SPLIT_PANE seeds the new view + focuses + GCs atomically', () => {
  it('splits a new editor beside the home, seeding its view and focusing it', () => {
    const seed: EditorView = { openTabs: ['mirror.ts'], activeTab: 'mirror.ts', previewTab: null }
    let s = makeState({ editorViews: { editor: { openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: null } }, editorMru: ['editor'] })
    s = instanceReducer(s, { type: 'SPLIT_PANE', panel: 'editor', targetNodeId: MAIN_TABS_ID, side: 'right', newId: 'editor:2', seedView: seed })
    expect(editorInstancesInOrder(s.panelLayout.desktop)).toEqual(['editor', 'editor:2'])
    expect(s.editorViews['editor:2']).toEqual(seed)
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'editor:2' })
    expect(s.editorMru[0]).toBe('editor:2') // new pane is active
  })
})

describe('CLOSE_PANE drops the view + refocuses next in MRU', () => {
  it('closes a secondary editor and refocuses the next live editor', () => {
    let s = makeState({
      layout: multiLayout(),
      editorViews: {
        editor: { openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: null },
        'editor:2': { openTabs: ['b.ts'], activeTab: 'b.ts', previewTab: null },
      },
      editorMru: ['editor:2', 'editor'],
    })
    s = instanceReducer(s, { type: 'CLOSE_PANE', id: 'editor:2' })
    expect(editorInstancesInOrder(s.panelLayout.desktop)).toEqual(['editor'])
    expect(s.editorViews['editor:2']).toBeUndefined() // view GC'd
    expect(s.editorMru).toEqual(['editor'])
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'editor' }) // refocus next in MRU
  })

  it('closing a terminal pane keeps its session binding off the GC and refocuses editor when none left', () => {
    let s = makeState({
      layout: multiLayout(),
      terminalBindings: { terminal: 's1', 'terminal:2': 's2' },
      terminalMru: ['terminal:2', 'terminal'],
    })
    // focus the terminal:2 first
    s = instanceReducer(s, { type: 'FOCUS_PANE', kind: 'terminal', instanceId: 'terminal:2' })
    s = instanceReducer(s, { type: 'CLOSE_PANE', id: 'terminal:2' })
    expect(terminalInstancesInOrder(s.panelLayout.desktop)).toEqual(['terminal'])
    expect(s.terminalBindings['terminal:2']).toBeUndefined()
    expect(s.focusedPane).toEqual({ kind: 'terminal', instanceId: 'terminal' }) // next live terminal
  })
})

// --- Terminal binding + focus/MRU -------------------------------------------

describe('BIND_TERMINAL / FOCUS_PANE', () => {
  it('binds and unbinds a terminal', () => {
    let s = makeState({ layout: multiLayout() })
    s = instanceReducer(s, { type: 'BIND_TERMINAL', id: 'terminal', session: 's1' })
    expect(s.terminalBindings.terminal).toBe('s1')
    s = instanceReducer(s, { type: 'BIND_TERMINAL', id: 'terminal', session: '' })
    expect(s.terminalBindings.terminal).toBeUndefined()
  })

  it('FOCUS_PANE pushes the id to its MRU head and sets focusedPane', () => {
    let s = makeState({ layout: multiLayout(), editorMru: ['editor'] })
    s = instanceReducer(s, { type: 'FOCUS_PANE', kind: 'editor', instanceId: 'editor:2' })
    expect(s.editorMru).toEqual(['editor:2', 'editor'])
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'editor:2' })
  })

  it('returns the same state for a no-op focus (already focused, MRU head)', () => {
    const s0 = makeState({ layout: multiLayout(), editorMru: ['editor:2', 'editor'] })
    const focused = instanceReducer(s0, { type: 'FOCUS_PANE', kind: 'editor', instanceId: 'editor:2' })
    const again = instanceReducer(focused, { type: 'FOCUS_PANE', kind: 'editor', instanceId: 'editor:2' })
    expect(again).toBe(focused)
  })
})

// --- buildInstanceState -----------------------------------------------------

describe('buildInstanceState', () => {
  it('GCs the seeded maps and points focus at the active editor', () => {
    const s = makeState({
      layout: defaultWorkspacePanelLayout(),
      editorViews: { editor: { ...EMPTY_VIEW }, 'ghost': { ...EMPTY_VIEW } }, // ghost not in tree
      editorMru: ['ghost', 'editor'],
    })
    expect(Object.keys(s.editorViews)).toEqual(['editor']) // ghost dropped
    expect(s.editorMru).toEqual(['editor'])
    expect(s.focusedPane).toEqual({ kind: 'editor', instanceId: 'editor' })
  })
})
