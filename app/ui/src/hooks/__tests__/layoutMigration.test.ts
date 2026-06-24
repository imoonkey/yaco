// @vitest-environment jsdom
//
// Unit tests for the persistence-loader migration into the flat tab-group model
// (vt-state). They pin the load pipeline from the design's "Persistence + migration
// loader" section: a stored NEW group blob is normalized (no migration,
// activeGroupId restored); an OLD blob (v1 panels/leaf tree or the oldest flat
// blob) is expanded into per-file group tabs via the pure `migrateTreeToGroups`,
// with `editorMru` re-pointed through the id map and terminal bindings + dirty
// buffers preserved.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'

// useWorkspaceState pulls in useFileState → useSSERefresh, which opens an
// EventSource the jsdom environment lacks. Stub the SSE surface so the hook mounts.
vi.mock('../useSSE', () => ({
  useSSERefresh: () => {},
  addSSEListener: () => () => {},
}))

import { loadPersistedState, loadDraftsByWorktree } from '../usePersistence'
import { useWorkspaceState } from '../useWorkspaceState'
import {
  type LayoutNode, type GroupTab,
  DEFAULT_LAYOUT, layoutKey, draftsKey, parseDiffTab,
} from '../workspaceTypes'
import {
  defaultWorkspacePanelLayout,
  editorTabPaths, terminalInstancesInOrder, firstGroupId, groupOf,
} from '../../workspace/panelLayoutModel'

const PROJECT = 'proj'
const PROJECT_PATH = '/repo/proj'

// Layout is project-global now (design §P3): seed the single per-project key.
function seedLayout(blob: unknown): void {
  localStorage.setItem(layoutKey(PROJECT), JSON.stringify(blob))
}

/** The primary worktree's draft for a relpath, read through the migration loader. */
function primaryDraft(path: string): string | null | undefined {
  return loadDraftsByWorktree(PROJECT, PROJECT_PATH)[PROJECT_PATH]?.[path]?.draft
}

/** Every editor tab across the whole tree, in document order. */
function allEditorTabs(node: LayoutNode): GroupTab[] {
  if (node.kind === 'tabs') return node.tabs.filter((t) => t.kind === 'editor')
  if (node.kind === 'split') return node.children.flatMap((c) => allEditorTabs(c.node))
  return []
}

/** An old-shape (pre-group) desktop tree: a MAIN_TABS editor node + optional extra
 *  editor/terminal leaves + the dock, for feeding the migration. */
function oldTree(opts: { secondaryEditor?: boolean; terminal?: boolean } = {}): unknown {
  const children: unknown[] = [
    { node: { kind: 'leaf', id: 'files', panel: 'files' } },
    { grow: true, node: { kind: 'tabs', id: 'main', active: 'editor', panels: ['editor', 'tasks'], chrome: 'none' } },
  ]
  if (opts.secondaryEditor) children.push({ node: { kind: 'leaf', id: 'editor:2', panel: 'editor' } })
  if (opts.terminal) children.push({ node: { kind: 'leaf', id: 'terminal', panel: 'terminal' } })
  return { kind: 'split', id: 'root', axis: 'row', children }
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// --- The five required migration tests --------------------------------------

describe('migration: old v1 blob → group model', () => {
  it('dirty file: the path becomes an editor tab and its draft survives', () => {
    seedLayout({
      panelLayout: { version: 1, desktop: oldTree(), mobile: { activeDock: 'browse' }, panelState: defaultWorkspacePanelLayout().panelState },
      editorViews: { editor: { openTabs: ['dirty.ts'], activeTab: 'dirty.ts', previewTab: null } },
    })
    localStorage.setItem(
      draftsKey(PROJECT),
      JSON.stringify({ files: { 'dirty.ts': { draft: 'unsaved edit', baseRevision: 1, viewportLine: 1, updatedAt: 9 } } }),
    )

    const state = loadPersistedState(PROJECT)
    expect(editorTabPaths(state.panelLayout.desktop)).toContain('dirty.ts')
    // The draft survives (the path is referenced + dirty, so the buffer is kept).
    expect(primaryDraft('dirty.ts')).toBe('unsaved edit')
  })

  it('diff tab with query refs migrates as one editor tab whose tabId round-trips', () => {
    const diffId = 'diff:foo.ts?base=main&compare=HEAD'
    seedLayout({
      panelLayout: { version: 1, desktop: oldTree(), mobile: { activeDock: 'browse' }, panelState: defaultWorkspacePanelLayout().panelState },
      editorViews: { editor: { openTabs: [diffId], activeTab: diffId, previewTab: null } },
    })

    const { panelLayout } = loadPersistedState(PROJECT)
    const tabs = allEditorTabs(panelLayout.desktop)
    expect(tabs).toHaveLength(1)
    const tabId = tabs[0].kind === 'editor' ? tabs[0].tabId : ''
    expect(tabId).toBe(diffId)
    expect(parseDiffTab(tabId)).toEqual({ path: 'foo.ts', base: 'main', compare: 'HEAD' })
  })

  it('exactly one preview-flagged editor tab survives migration', () => {
    seedLayout({
      panelLayout: { version: 1, desktop: oldTree(), mobile: { activeDock: 'browse' }, panelState: defaultWorkspacePanelLayout().panelState },
      editorViews: { editor: { openTabs: ['a.ts', 'b.ts'], activeTab: 'a.ts', previewTab: 'b.ts' } },
    })

    const { panelLayout } = loadPersistedState(PROJECT)
    const tabs = allEditorTabs(panelLayout.desktop)
    const previews = tabs.filter((t) => t.kind === 'editor' && t.preview)
    expect(previews).toHaveLength(1)
    expect(previews[0].kind === 'editor' && previews[0].tabId).toBe('b.ts')
  })

  it('terminal binding + instance id preserved, no rebind', () => {
    seedLayout({
      panelLayout: { version: 1, desktop: oldTree({ terminal: true }), mobile: { activeDock: 'browse' }, panelState: defaultWorkspacePanelLayout().panelState },
      editorViews: { editor: { openTabs: [], activeTab: null, previewTab: null } },
      terminalBindings: { terminal: 's1' },
      terminalMru: ['terminal'],
    })

    const state = loadPersistedState(PROJECT)
    expect(terminalInstancesInOrder(state.panelLayout.desktop)).toContain('terminal')
    expect(state.terminalBindings).toEqual({ terminal: 's1' })
    expect(state.terminalMru).toEqual(['terminal'])
  })

  it('same file in two old editors → two tabs sharing the path; both focus map via idMap', () => {
    seedLayout({
      panelLayout: { version: 1, desktop: oldTree({ secondaryEditor: true }), mobile: { activeDock: 'browse' }, panelState: defaultWorkspacePanelLayout().panelState },
      editorViews: {
        editor: { openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: null },
        'editor:2': { openTabs: ['a.ts'], activeTab: 'a.ts', previewTab: null },
      },
      editorMru: ['editor:2', 'editor'],
    })

    const state = loadPersistedState(PROJECT)
    const tabs = allEditorTabs(state.panelLayout.desktop)
    expect(tabs).toHaveLength(2)
    expect(tabs.every((t) => t.kind === 'editor' && t.tabId === 'a.ts')).toBe(true)
    expect(editorTabPaths(state.panelLayout.desktop)).toEqual(['a.ts']) // one shared buffer
    // Both old editors map to their new active-tab instance via idMap.
    const ids = new Set(tabs.map((t) => t.instanceId))
    expect(state.editorMru).toHaveLength(2)
    expect(state.editorMru.every((id) => ids.has(id))).toBe(true)
    expect(new Set(state.editorMru).size).toBe(2)
  })
})

// --- old flat-blob reload ----------------------------------------------------

describe('migration: oldest flat blob → group model', () => {
  it('expands flat openTabs into group tabs + binds the activeSession terminal', () => {
    seedLayout({
      openTabs: ['a.ts', 'b.ts'],
      activeTab: 'b.ts',
      previewTab: 'a.ts',
      activeSession: 'sess-1',
      recentFiles: ['a.ts', 'b.ts'],
      layout: { ...DEFAULT_LAYOUT, autocompleteEnabled: true },
    })

    const state = loadPersistedState(PROJECT)
    const tabs = allEditorTabs(state.panelLayout.desktop)
    expect(tabs.map((t) => (t.kind === 'editor' ? t.tabId : ''))).toEqual(['a.ts', 'b.ts'])
    // a.ts was the previewTab → exactly that tab carries preview.
    expect(tabs.filter((t) => t.kind === 'editor' && t.preview).map((t) => (t.kind === 'editor' ? t.tabId : ''))).toEqual(['a.ts'])
    // activeSession migrates to a bound terminal tab on the preserved 'terminal' id.
    expect(terminalInstancesInOrder(state.panelLayout.desktop)).toContain('terminal')
    expect(state.terminalBindings.terminal).toBe('sess-1')
    expect(state.recentFiles).toEqual(['a.ts', 'b.ts'])
    expect(state.panelLayout.panelState.editor.autocompleteEnabled).toBe(true)
    // activeGroupId names a live group (the MRU head's group).
    expect(firstGroupId(state.panelLayout.desktop)).toBeTruthy()
    expect(groupOf(state.panelLayout.desktop, state.editorMru[0])).toBe(state.activeGroupId)
  })
})

// --- stored NEW group blob: normalize, restore activeGroupId, no migration --

describe('migration: stored new group blob', () => {
  const groupBlob = (activeGroupId: string) => ({
    panelLayout: {
      version: 1,
      desktop: {
        kind: 'split', id: 'root', axis: 'row',
        children: [
          { node: { kind: 'leaf', id: 'files', panel: 'files' } },
          { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: [{ instanceId: 'editor', kind: 'editor', tabId: 'a.ts' }], activeTab: 'editor' } },
          { node: { kind: 'tabs', id: 'group:2', tabs: [], activeTab: '' } },
        ],
      },
      mobile: { activeDock: 'browse' },
      panelState: defaultWorkspacePanelLayout().panelState,
    },
    editorMru: ['editor'],
    terminalBindings: {},
    activeGroupId,
  })

  it('preserves a focused EMPTY group across reload (activeGroupId restored)', () => {
    seedLayout(groupBlob('group:2'))
    const state = loadPersistedState(PROJECT)
    expect(allEditorTabs(state.panelLayout.desktop).map((t) => (t.kind === 'editor' ? t.tabId : ''))).toEqual(['a.ts'])
    expect(state.activeGroupId).toBe('group:2') // the empty group survives + stays focused
  })

  it('clamps a stale activeGroupId to the first group', () => {
    seedLayout(groupBlob('group:404'))
    const state = loadPersistedState(PROJECT)
    expect(state.activeGroupId).toBe(firstGroupId(state.panelLayout.desktop))
  })
})

// --- corrupt / empty input → defaults, never throws -------------------------

describe('migration: corrupt or empty input', () => {
  it('returns a fresh default layout when no blob exists', () => {
    const state = loadPersistedState(PROJECT)
    expect(state.panelLayout).toEqual(defaultWorkspacePanelLayout())
    expect(state.activeGroupId).toBe(firstGroupId(defaultWorkspacePanelLayout().desktop))
    expect(state.terminalBindings).toEqual({})
  })

  it('falls back to defaults for non-JSON garbage without throwing', () => {
    localStorage.setItem(layoutKey(PROJECT), 'not json{{{')
    const state = loadPersistedState(PROJECT)
    expect(state.panelLayout).toEqual(defaultWorkspacePanelLayout())
    expect(state.layout).toEqual(DEFAULT_LAYOUT)
  })
})

// --- per-key isolation: never disturb sibling keys --------------------------

describe('migration: per-key isolation', () => {
  it('a corrupt layout blob leaves drafts intact and never rewrites siblings', () => {
    localStorage.setItem(
      draftsKey(PROJECT),
      JSON.stringify({ files: { 'a.ts': { draft: 'hello', baseRevision: 1, viewportLine: 3, updatedAt: 5 } } }),
    )
    localStorage.setItem(`yaco-sessions:${PROJECT}`, 'lineage-state')
    localStorage.setItem(layoutKey(PROJECT), '{ broken')

    loadPersistedState(PROJECT)

    expect(primaryDraft('a.ts')).toBe('hello')
    expect(localStorage.getItem(`yaco-sessions:${PROJECT}`)).toBe('lineage-state')
    expect(localStorage.getItem(layoutKey(PROJECT))).toBe('{ broken')
  })
})

// --- round-trip through the REAL save path ----------------------------------

describe('migration: new-shape round-trip via useWorkspaceState', () => {
  it('persists the live group layout + maps + activeGroupId through saveLayout', () => {
    const stored = {
      version: 1,
      desktop: {
        kind: 'split', id: 'root', axis: 'row',
        children: [
          { node: { kind: 'leaf', id: 'files', panel: 'files' } },
          { grow: true, node: { kind: 'tabs', id: 'group:1', tabs: [{ instanceId: 'editor', kind: 'editor', tabId: 'src/keep.ts' }], activeTab: 'editor' } },
          { node: { kind: 'tabs', id: 'group:2', tabs: [], activeTab: '' } },
        ],
      },
      mobile: { activeDock: 'browse' as const },
      panelState: {
        files: { mode: 'search' as const },
        editor: { previewMode: 'preview' as const, splitDirection: 'vertical' as const, splitSize: 42, autocompleteEnabled: true },
      },
    }
    seedLayout({ panelLayout: stored, editorMru: ['editor'], terminalBindings: {}, activeGroupId: 'group:2' })

    const { unmount } = renderHook(() => useWorkspaceState(PROJECT, PROJECT_PATH))
    unmount()

    const reloaded = loadPersistedState(PROJECT)
    expect(reloaded.panelLayout.desktop).toEqual(stored.desktop)
    expect(reloaded.panelLayout.panelState).toEqual(stored.panelState)
    expect(reloaded.editorMru).toEqual(['editor'])
    expect(reloaded.activeGroupId).toBe('group:2') // the focused empty group round-trips
  })
})

// --- layout is project-global (design §P3) -----------------------------------

describe('layout: project-global, old per-worktree keys ignored', () => {
  it('reads the single per-project layout key; a stale per-worktree key is never read', () => {
    // A leftover pre-decouple per-worktree layout blob must NOT shadow the project layout.
    localStorage.setItem(
      `${layoutKey(PROJECT)}:wt:wt-1`,
      JSON.stringify({ layout: { ...DEFAULT_LAYOUT, autocompleteEnabled: true } }),
    )
    seedLayout({ layout: { ...DEFAULT_LAYOUT, autocompleteEnabled: false } })

    // loadPersistedState takes the project only; the project layout wins.
    expect(loadPersistedState(PROJECT).panelLayout.panelState.editor.autocompleteEnabled).toBe(false)
  })
})
