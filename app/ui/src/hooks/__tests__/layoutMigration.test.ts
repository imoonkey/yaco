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

    expect(state.openTabs).toEqual(['a.ts', 'b.ts'])
    expect(state.activeTab).toBe('b.ts')
    expect(state.previewTab).toBe('a.ts')
    expect(state.activeSession).toBe('sess-1')
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
          { grow: true, node: { kind: 'leaf', id: 'd', panel: 'editor' } },
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
    expect(panelLayout).toEqual(normalizeLayout(malformed))
    // Concrete repairs:
    expect(collectPanels(panelLayout!.desktop).sort()).toEqual(['editor', 'files'])
    expect(panelLayout?.mobile.activeDock).toBe('browse')
    expect(panelLayout?.panelState.files.mode).toBe('tree')
    expect(panelLayout?.panelState.editor).toEqual(defaultWorkspacePanelLayout().panelState.editor)
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
    expect(state.openTabs).toEqual([])
    expect(state.layout).toEqual(DEFAULT_LAYOUT)
  })

  it('falls back to defaults for a null blob without throwing', () => {
    localStorage.setItem(layoutKey(PROJECT), 'null')

    const state = loadPersistedState(PROJECT)

    expect(state.panelLayout).toEqual(defaultWorkspacePanelLayout())
    expect(state.openTabs).toEqual([])
  })
})

// --- final-shape round-trip through the REAL save path ---------------------

describe('migration: new-shape round-trip via useWorkspaceState', () => {
  it('persists the live panel layout through bindSnapshots → saveLayout', () => {
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
    seedLayout({ panelLayout: stored })

    // Mount the real hook: it loads the stored tree, seeds live state, and binds
    // the persistence snapshot. Unmounting flushes that snapshot synchronously
    // through saveLayout — the same path the running app uses on teardown.
    const { unmount } = renderHook(() => useWorkspaceState(PROJECT))
    unmount()

    expect(loadPersistedState(PROJECT).panelLayout).toEqual(stored)
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
    expect(state.openTabs).toEqual(['src/a.ts'])
    expect(state.activeTab).toBe('src/a.ts')
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
