// @vitest-environment jsdom
//
// Unit tests for the one-time persistence migration (T4c). They pin the load
// behavior from the design's "Persistence Shape" section:
//
//   - old flat blob → default desktop/mobile tree + the four editor-preference
//     fields lifted into panelState.editor (only those four; old arrangement
//     fields like show*/sizes are NOT migrated);
//   - a stored version:1 tree → validated + normalized;
//   - malformed/partial input → per-field salvage to default, never a wholesale
//     discard — and a corrupt layout blob never touches the other localStorage
//     keys (drafts, yaco-sessions, yaco-worktree).
//
// Tree-internal normalization invariants (duplicate/unknown panel repair,
// min-size clamping, idempotency) are owned by panelLayoutModel.test.ts; these
// tests cover the migration *routing* on top of it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'

// useWorkspaceState pulls in useFileState → useSSERefresh, which opens an
// EventSource the jsdom environment lacks. Stub the SSE surface so the hook can
// mount; the migration save path under test does not depend on it.
vi.mock('../useSSE', () => ({
  useSSERefresh: () => {},
  addSSEListener: () => () => {},
}))

import { loadPersistedState, loadPersistedDrafts } from '../usePersistence'
import { useWorkspaceState } from '../useWorkspaceState'
import {
  type LayoutNode,
  DEFAULT_LAYOUT,
  layoutKey,
  draftsKey,
} from '../workspaceTypes'
import {
  defaultWorkspacePanelLayout,
  defaultDesktopTree,
  normalizeLayout,
  mainTabsActivePanel,
  editorInstancesInOrder,
  MAIN_TABS_ID,
} from '../../workspace/panelLayoutModel'

const PROJECT = 'proj'

function seedLayout(blob: unknown, worktree?: string | null): void {
  localStorage.setItem(layoutKey(PROJECT, worktree), JSON.stringify(blob))
}

/** Flatten every panel id referenced anywhere in a desktop tree. */
function collectPanels(node: LayoutNode): string[] {
  if (node.kind === 'leaf') return [node.panel]
  if (node.kind === 'tabs') return [...node.panels]
  return node.children.flatMap((c) => collectPanels(c.node))
}

beforeEach(() => {
  localStorage.clear()
  // No tabs are open in these tests, so nothing should fetch — stub defensively
  // so an unexpected request never escapes to the network.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// --- old flat blob → default tree + four editor prefs ----------------------

describe('migration: old flat blob → panel layout', () => {
  it('uses the default tree and lifts the four editor prefs into panelState.editor', () => {
    seedLayout({
      openTabs: ['src/a.ts'],
      activeTab: 'src/a.ts',
      layout: {
        ...DEFAULT_LAYOUT,
        previewMode: 'preview',
        splitDirection: 'vertical',
        splitSize: 70,
        autocompleteEnabled: true,
      },
    })

    const { panelLayout } = loadPersistedState(PROJECT)

    expect(panelLayout?.version).toBe(1)
    expect(panelLayout?.desktop).toEqual(defaultDesktopTree())
    expect(panelLayout?.mobile).toEqual({ activeDock: 'browse' })
    expect(panelLayout?.panelState.files).toEqual({ mode: 'tree' })
    expect(panelLayout?.panelState.editor).toEqual({
      previewMode: 'preview',
      splitDirection: 'vertical',
      splitSize: 70,
      autocompleteEnabled: true,
    })
  })

  it('reads editor prefs stored at the top level (no nested layout object)', () => {
    seedLayout({ previewMode: 'split', autocompleteEnabled: true })

    const { panelLayout } = loadPersistedState(PROJECT)

    expect(panelLayout?.panelState.editor).toEqual({
      previewMode: 'split',
      splitDirection: 'horizontal', // default
      splitSize: 50, // default
      autocompleteEnabled: true,
    })
  })

  it('per-field salvages invalid editor prefs while keeping valid ones', () => {
    seedLayout({
      layout: {
        previewMode: 'preview', // valid → kept
        splitSize: 999, // out of 20..80 → default 50
        splitDirection: 'sideways', // invalid → default horizontal
        autocompleteEnabled: 'yes', // not a boolean → default false
      },
    })

    const { panelLayout } = loadPersistedState(PROJECT)

    expect(panelLayout?.panelState.editor).toEqual({
      previewMode: 'preview',
      splitDirection: 'horizontal',
      splitSize: 50,
      autocompleteEnabled: false,
    })
  })

  it('does not migrate old arrangement fields — tree stays default, flat layout still parses', () => {
    seedLayout({
      layout: {
        ...DEFAULT_LAYOUT,
        showSidebar: false,
        showProjects: false,
        leftSize: 50,
        projectSize: 9999,
      },
    })

    const state = loadPersistedState(PROJECT)

    // The new tree ignores old show*/size arrangement entirely.
    expect(state.panelLayout?.desktop).toEqual(defaultDesktopTree())
    // The legacy flat layout is still parsed for the (still-live) old renderer.
    expect(state.layout.showSidebar).toBe(false)
    expect(state.layout.leftSize).toBe(50)
  })

  it('preserves non-layout workspace state alongside the migrated tree', () => {
    seedLayout({
      openTabs: ['a.ts', 'b.ts'],
      activeTab: 'b.ts',
      previewTab: 'a.ts',
      activeSession: 'sess-1',
      recentFiles: ['a.ts', 'b.ts', 'c.ts'],
      layout: { autocompleteEnabled: true },
    })

    const state = loadPersistedState(PROJECT)

    // The single old editor view migrates to the home editor; activeSession to
    // the structural terminal; both seed their MRU head.
    expect(state.editorViews.editor).toEqual({ openTabs: ['a.ts', 'b.ts'], activeTab: 'b.ts', previewTab: 'a.ts' })
    expect(state.editorMru).toEqual(['editor'])
    expect(state.terminalBindings.terminal).toBe('sess-1')
    expect(state.terminalMru).toEqual(['terminal'])
    expect(state.recentFiles).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(state.panelLayout?.panelState.editor.autocompleteEnabled).toBe(true)
  })
})

// --- stored version:1 tree → validate + normalize --------------------------

describe('migration: stored version:1 tree', () => {
  it('preserves a valid stored tree through normalization', () => {
    const stored = {
      ...defaultWorkspacePanelLayout(),
      mobile: { activeDock: 'editor' as const },
      panelState: {
        files: { mode: 'search' as const },
        editor: { previewMode: 'split' as const, splitDirection: 'vertical' as const, splitSize: 33, autocompleteEnabled: true },
      },
    }
    seedLayout({ panelLayout: stored })

    const { panelLayout } = loadPersistedState(PROJECT)

    expect(panelLayout).toEqual(stored)
    expect(panelLayout).toEqual(normalizeLayout(stored))
  })

  it('repairs a malformed tree per-field instead of discarding it', () => {
    const malformed = {
      version: 1,
      desktop: {
        kind: 'split',
        id: 'root',
        axis: 'row',
        children: [
          { node: { kind: 'leaf', id: 'a', panel: 'files' } },
          { node: { kind: 'leaf', id: 'b', panel: 'files' } }, // duplicate → dropped
          { node: { kind: 'leaf', id: 'c', panel: 'bogus' } }, // unknown → dropped
          { grow: true, node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
        ],
      },
      mobile: { activeDock: 'nope' }, // invalid → browse
      panelState: {
        files: { mode: 'weird' }, // invalid → tree
        editor: { previewMode: 'zzz', splitSize: -1, splitDirection: 'q', autocompleteEnabled: 'y' },
      },
    }
    seedLayout({ panelLayout: malformed })

    const { panelLayout } = loadPersistedState(PROJECT)

    // Routed through normalization (per-field salvage), never wholesale discard.
    // The home editor is present, so no reconstitution fires.
    expect(panelLayout).toEqual(normalizeLayout(malformed))
    // Concrete repairs:
    expect(collectPanels(panelLayout!.desktop).sort()).toEqual(['editor', 'files', 'tasks'])
    expect(panelLayout?.mobile.activeDock).toBe('browse')
    expect(panelLayout?.panelState.files.mode).toBe('tree')
    expect(panelLayout?.panelState.editor).toEqual(defaultWorkspacePanelLayout().panelState.editor)
  })

  it('reconstitutes the home editor when a stored tree dismantled the main tabs node', () => {
    // A legacy tree that moved editor out as a leaf (claiming the home id) and
    // dropped tasks entirely — no main tabs node survives. Load must restore the
    // structural home editor so 'editor' is always a live instance, and migrate
    // the old global tabs into it (the moved-out leaf becomes a secondary).
    seedLayout({
      openTabs: ['src/keep.ts'],
      activeTab: 'src/keep.ts',
      panelLayout: {
        version: 1,
        desktop: {
          kind: 'split', id: 'root', axis: 'row',
          children: [
            { node: { kind: 'leaf', id: 'files', panel: 'files' } },
            { grow: true, node: { kind: 'leaf', id: 'editor', panel: 'editor' } }, // claims home id
          ],
        },
        mobile: { activeDock: 'browse' },
        panelState: defaultWorkspacePanelLayout().panelState,
      },
    })

    const state = loadPersistedState(PROJECT)

    // Home editor reconstituted in the main tabs node; the moved-out leaf is a secondary.
    expect(mainTabsActivePanel(state.panelLayout.desktop)).toBe('editor')
    const editors = editorInstancesInOrder(state.panelLayout.desktop)
    expect(editors).toContain('editor')
    expect(editors.length).toBe(2) // home + the re-id'd secondary
    // The old global tabs land in the home editor (kept live by the reconstitution).
    expect(state.editorViews.editor).toEqual({ openTabs: ['src/keep.ts'], activeTab: 'src/keep.ts', previewTab: null })
  })

  it('treats a non-1 version as an old blob (default tree + editor-pref read)', () => {
    seedLayout({
      panelLayout: { version: 2, desktop: { kind: 'leaf', id: 'x', panel: 'files' } },
      layout: { autocompleteEnabled: true },
    })

    const { panelLayout } = loadPersistedState(PROJECT)

    expect(panelLayout?.desktop).toEqual(defaultDesktopTree())
    expect(panelLayout?.panelState.editor.autocompleteEnabled).toBe(true)
  })
})

// --- corrupt / empty input → defaults, never throws ------------------------

describe('migration: corrupt or empty input', () => {
  it('returns a fresh default panel layout when no blob exists', () => {
    const { panelLayout } = loadPersistedState(PROJECT)
    expect(panelLayout).toEqual(defaultWorkspacePanelLayout())
  })

  it('falls back to defaults for non-JSON garbage without throwing', () => {
    localStorage.setItem(layoutKey(PROJECT), 'not json{{{')

    const state = loadPersistedState(PROJECT)

    expect(state.panelLayout).toEqual(defaultWorkspacePanelLayout())
    expect(state.editorViews).toEqual({})
    expect(state.layout).toEqual(DEFAULT_LAYOUT)
  })

  it('falls back to defaults for a null blob without throwing', () => {
    localStorage.setItem(layoutKey(PROJECT), 'null')

    const state = loadPersistedState(PROJECT)

    expect(state.panelLayout).toEqual(defaultWorkspacePanelLayout())
    expect(state.editorViews).toEqual({})
  })
})

// --- new-shape load: parse + GC the per-instance maps ----------------------

describe('migration: new-shape per-instance state', () => {
  const multiTree = {
    version: 1,
    desktop: {
      kind: 'split', id: 'root', axis: 'row',
      children: [
        { node: { kind: 'leaf', id: 'files', panel: 'files' } },
        { grow: true, node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
        { node: { kind: 'leaf', id: 'editor:2', panel: 'editor' } },
        { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } },
      ],
    },
    mobile: { activeDock: 'browse' as const },
    panelState: defaultWorkspacePanelLayout().panelState,
  }

  it('parses editor views / bindings / MRU and GCs every id the tree lacks', () => {
    seedLayout({
      panelLayout: multiTree,
      editorViews: {
        editor: { openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: null },
        'editor:2': { openTabs: ['b.ts'], activeTab: 'b.ts', previewTab: null },
        ghost: { openTabs: ['z.ts'], activeTab: 'z.ts', previewTab: null }, // no such pane → dropped
      },
      terminalBindings: { terminal: 'sess-1', 'terminal:2': 'sess-2' }, // terminal:2 absent → dropped
      editorMru: ['ghost', 'editor:2', 'editor'], // ghost GC'd
      terminalMru: ['terminal:2', 'terminal'], // terminal:2 GC'd
    })

    const s = loadPersistedState(PROJECT)

    expect(Object.keys(s.editorViews).sort()).toEqual(['editor', 'editor:2'])
    expect(s.editorViews['editor:2'].openTabs).toEqual(['b.ts'])
    expect(s.terminalBindings).toEqual({ terminal: 'sess-1' })
    expect(s.editorMru).toEqual(['editor:2', 'editor'])
    expect(s.terminalMru).toEqual(['terminal'])
  })

  it('dedups terminal bindings to one-per-session (keep first in document order)', () => {
    seedLayout({
      panelLayout: {
        version: 1,
        desktop: {
          kind: 'split', id: 'root', axis: 'row',
          children: [
            { grow: true, node: { kind: 'tabs', id: MAIN_TABS_ID, active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
            { node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } },
            { node: { kind: 'leaf', id: 'terminal:2', panel: 'terminal' } },
          ],
        },
        mobile: { activeDock: 'browse' as const },
        panelState: defaultWorkspacePanelLayout().panelState,
      },
      editorViews: {}, // present → new-shape blob (so terminalBindings is read)
      terminalBindings: { 'terminal:2': 'dup', terminal: 'dup' },
    })

    const s = loadPersistedState(PROJECT)
    // 'terminal' precedes 'terminal:2' in document order → it keeps the session.
    expect(s.terminalBindings).toEqual({ terminal: 'dup' })
  })
})

// --- final-shape round-trip through the REAL save path ---------------------

describe('migration: new-shape round-trip via useWorkspaceState', () => {
  it('persists the live panel layout + per-instance maps through bindSnapshots → saveLayout', () => {
    // A non-default, fully-valid stored tree: every field differs from the
    // defaults, so a dropped panelLayout (re-derived defaults on reload) fails
    // this assertion instead of passing vacuously.
    const stored = {
      ...defaultWorkspacePanelLayout(),
      mobile: { activeDock: 'terminal' as const },
      panelState: {
        files: { mode: 'search' as const },
        editor: { previewMode: 'preview' as const, splitDirection: 'vertical' as const, splitSize: 42, autocompleteEnabled: true },
      },
    }
    seedLayout({
      panelLayout: stored,
      editorViews: { editor: { openTabs: ['src/keep.ts'], activeTab: 'src/keep.ts', previewTab: null } },
      terminalBindings: { terminal: 'sess-keep' },
      editorMru: ['editor'],
      terminalMru: ['terminal'],
    })

    // Mount the real hook: it loads the stored state, seeds live state, and binds
    // the persistence snapshot. Unmounting flushes that snapshot synchronously
    // through saveLayout — the same path the running app uses on teardown.
    const { unmount } = renderHook(() => useWorkspaceState(PROJECT))
    unmount()

    const reloaded = loadPersistedState(PROJECT)
    expect(reloaded.panelLayout).toEqual(stored)
    expect(reloaded.editorViews).toEqual({ editor: { openTabs: ['src/keep.ts'], activeTab: 'src/keep.ts', previewTab: null } })
    expect(reloaded.terminalBindings).toEqual({ terminal: 'sess-keep' })
    expect(reloaded.editorMru).toEqual(['editor'])
    expect(reloaded.terminalMru).toEqual(['terminal'])
  })
})

// --- per-key isolation: never wholesale discard ----------------------------

describe('migration: per-key isolation', () => {
  it('a corrupt layout blob leaves drafts (a separate key) intact', () => {
    localStorage.setItem(
      draftsKey(PROJECT),
      JSON.stringify({ files: { 'a.ts': { draft: 'hello', baseRevision: 1, viewportLine: 3, updatedAt: 5 } } }),
    )
    localStorage.setItem(layoutKey(PROJECT), 'broken{')

    // Loading the corrupt layout falls back to defaults...
    expect(loadPersistedState(PROJECT).panelLayout).toEqual(defaultWorkspacePanelLayout())
    // ...and the drafts key is untouched.
    expect(loadPersistedDrafts(PROJECT).files['a.ts']?.draft).toBe('hello')
  })

  it('loading a corrupt layout never writes or clears sibling keys', () => {
    // yaco-sessions / yaco-worktree are owned by other hooks; pinned sessions
    // live server-side (/api/ui-state), not in localStorage. The migration must
    // only ever read layoutKey, so a corrupt blob cannot disturb them.
    localStorage.setItem(`yaco-sessions:${PROJECT}`, 'lineage-state')
    localStorage.setItem(`yaco-worktree:${PROJECT}`, 'wt-slug')
    localStorage.setItem(layoutKey(PROJECT), '{ broken')

    loadPersistedState(PROJECT)

    expect(localStorage.getItem(`yaco-sessions:${PROJECT}`)).toBe('lineage-state')
    expect(localStorage.getItem(`yaco-worktree:${PROJECT}`)).toBe('wt-slug')
    // The corrupt layout blob is read-only — not rewritten by a load.
    expect(localStorage.getItem(layoutKey(PROJECT))).toBe('{ broken')
  })
})

// --- T7: migrate pre-T7 "Tasks active" (fake tab) → real tasks panel ---------

describe('migration: pre-T7 fake tasks tab → tasks panel active', () => {
  // Pre-T7 modeled an open Tasks workspace as a fake editor tab whose id was the
  // NUL sentinel ('\0tasks'); the only "tasks is showing" signal lived in
  // activeTab. T7 makes tasks a real main-tabs panel, so that intent must migrate
  // to the panel layout — otherwise reopening after T7 silently loses Tasks.
  const TASKS_SENTINEL = String.fromCharCode(0) + 'tasks' // legacy fake tasks-tab id (NUL sentinel)

  it('migrates an old flat blob with the active tasks sentinel to tasks-active', () => {
    seedLayout({
      openTabs: ['src/a.ts', TASKS_SENTINEL],
      activeTab: TASKS_SENTINEL,
      layout: { ...DEFAULT_LAYOUT },
    })

    const state = loadPersistedState(PROJECT)

    // The sentinel is stripped from the tab set, and the intent moves to the tree.
    expect(state.editorViews.editor.openTabs).toEqual(['src/a.ts'])
    expect(state.editorViews.editor.activeTab).toBe('src/a.ts')
    expect(mainTabsActivePanel(state.panelLayout.desktop)).toBe('tasks')
  })

  it('overrides a stored v1 tree (active editor) when the old activeTab was tasks', () => {
    // The realistic pre-T7 shape: panelLayout existed (T4) but nothing ever set
    // its main-tabs active to tasks, so it persisted as 'editor' while the fake
    // tab carried the real "tasks open" state.
    seedLayout({
      activeTab: TASKS_SENTINEL,
      panelLayout: defaultWorkspacePanelLayout(),
    })

    const { panelLayout } = loadPersistedState(PROJECT)
    expect(mainTabsActivePanel(panelLayout.desktop)).toBe('tasks')
  })

  it('leaves the editor active when no tasks sentinel was persisted', () => {
    seedLayout({ openTabs: ['src/a.ts'], activeTab: 'src/a.ts' })

    const { panelLayout } = loadPersistedState(PROJECT)
    expect(mainTabsActivePanel(panelLayout.desktop)).toBe('editor')
  })
})



describe('migration: per (project, worktree) scoping', () => {
  it('migrates each worktree slot independently', () => {
    seedLayout({ layout: { autocompleteEnabled: true } }, 'wt-1')
    seedLayout({ layout: { autocompleteEnabled: false } }, null)

    expect(loadPersistedState(PROJECT, 'wt-1').panelLayout?.panelState.editor.autocompleteEnabled).toBe(true)
    expect(loadPersistedState(PROJECT).panelLayout?.panelState.editor.autocompleteEnabled).toBe(false)
  })
})
