// @vitest-environment jsdom
// Regression: a persisted blob whose flat showSidebar/showRightPanel flags
// disagree with the panel tree's actual sidebar visibility must NOT drive the
// WorkspaceProvider visibility mirrors into an infinite update loop. The flags
// are reconciled FROM the tree at load (usePersistence), so mount is consistent.
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayoutEffect, useRef, createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { loadPersistedState } from '../usePersistence'
import { useLayoutState } from '../useLayoutState'
import { layoutKey, DEFAULT_LAYOUT } from '../workspaceTypes'
import { sidebarVisibility, setDockVisible, setActivityVisible } from '../../workspace/panelLayoutModel'
import type { PersistedState } from '../workspaceTypes'

// Canonical-but-asymmetric tree: a LEFT dock column (visible), a center working
// area, and a HIDDEN right region — the exact shape the loop fuzz surfaced.
const desktop = {
  kind: 'split', id: 'root', axis: 'row', children: [
    { node: { kind: 'split', id: 'col:1', axis: 'col', children: [
      { node: { kind: 'leaf', id: 'l3', panel: 'changes' } },
      { node: { kind: 'leaf', id: 'l5', panel: 'files' } },
      { node: { kind: 'leaf', id: 'l8', panel: 'sessions' } },
    ] } },
    { grow: true, node: { kind: 'tabs', id: 'g10', tabs: [{ instanceId: 'g11:e', kind: 'editor', tabId: 'a.ts' }], activeTab: 'g11:e' } },
    { hidden: true, node: { kind: 'leaf', id: 'l25', panel: 'projects' } },
  ],
}

function writeBlob(project: string, flags: Partial<typeof DEFAULT_LAYOUT>) {
  const blob = {
    layout: { ...DEFAULT_LAYOUT, ...flags },
    panelLayout: { version: 1, desktop, mobile: { activeDock: 'browse' }, panelState: {} },
    terminalBindings: {}, editorMru: [], terminalMru: [], activeGroupId: '', mobilePane: 'files', recentFiles: [],
  }
  localStorage.setItem(layoutKey(project), JSON.stringify(blob))
}

function Harness({ initial, onRender }: { initial: PersistedState; onRender: () => void }) {
  const dirty = useRef<ReadonlySet<string>>(new Set())
  const { layout, panelLayout, setPanelLayout, updateLayout } = useLayoutState(initial, dirty)
  onRender()
  useLayoutEffect(() => { setPanelLayout((p) => setDockVisible(p, layout.showSidebar)) }, [layout.showSidebar, setPanelLayout])
  useLayoutEffect(() => { setPanelLayout((p) => setActivityVisible(p, layout.showRightPanel)) }, [layout.showRightPanel, setPanelLayout])
  const lastFlags = useRef({ left: layout.showSidebar, right: layout.showRightPanel })
  useLayoutEffect(() => {
    const vis = sidebarVisibility(panelLayout.desktop)
    const l = lastFlags.current
    let nextLeft = layout.showSidebar
    let nextRight = layout.showRightPanel
    if (l.left === layout.showSidebar && vis.left !== layout.showSidebar) { updateLayout({ showSidebar: vis.left }); nextLeft = vis.left }
    if (l.right === layout.showRightPanel && vis.right !== layout.showRightPanel) { updateLayout({ showRightPanel: vis.right }); nextRight = vis.right }
    lastFlags.current = { left: nextLeft, right: nextRight }
  }, [panelLayout.desktop, layout.showSidebar, layout.showRightPanel, updateLayout])
  return null
}

describe('persisted visibility consistency (loop regression)', () => {
  beforeEach(() => localStorage.clear())

  // Every mismatch the migration / stale blob can produce.
  for (const flags of [
    { showSidebar: false, showRightPanel: false },
    { showSidebar: false, showRightPanel: true },
    { showSidebar: true, showRightPanel: true },
  ]) {
    it(`reconciles flags from the tree at load (${JSON.stringify(flags)})`, () => {
      writeBlob('proj', flags)
      const loaded = loadPersistedState('proj')
      const vis = sidebarVisibility(loaded.panelLayout.desktop)
      expect(loaded.layout.showSidebar).toBe(vis.left)
      expect(loaded.layout.showRightPanel).toBe(vis.right)
    })

    it(`mounts without an update-depth storm (${JSON.stringify(flags)})`, () => {
      writeBlob('proj', flags)
      const initial = loadPersistedState('proj')
      let renders = 0
      let threw: string | null = null
      try { render(createElement(Harness, { initial, onRender: () => { renders++ } })) }
      catch (e) { threw = e instanceof Error ? e.message : String(e) }
      cleanup()
      expect(threw).toBeNull()
      expect(renders).toBeLessThan(15)
    })
  }

  // The migration path (migrateOldBlob) builds the tree and parses the flat flags
  // independently, so it is the other place a mismatch is born. An oldest-style
  // blob (no panelLayout) migrates to a synthetic dock+sessions tree (both sidebars
  // visible); stale flat flags claiming both hidden must be reconciled FROM it.
  it('reconciles flags from a migrated (old-blob) tree', () => {
    localStorage.setItem(layoutKey('proj'), JSON.stringify({
      layout: { ...DEFAULT_LAYOUT, showSidebar: false, showRightPanel: false },
      openTabs: ['src/a.ts'], activeTab: 'src/a.ts',
    }))
    const loaded = loadPersistedState('proj')
    const vis = sidebarVisibility(loaded.panelLayout.desktop)
    expect(loaded.layout.showSidebar).toBe(vis.left)
    expect(loaded.layout.showRightPanel).toBe(vis.right)
    expect(vis.left).toBe(true) // synthetic tree has a left dock
  })
})
