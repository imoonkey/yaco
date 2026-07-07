// @vitest-environment jsdom
// Runtime storm repro: a single commit that BOTH mutates the desktop tree and
// flips a visibility flag (as clickSession does: open a terminal tab + reveal
// the right column) must not drive the visibility mirrors into an update loop,
// even though the load-time reconcile only covers mount.
import { describe, it, expect } from 'vitest'
import { act } from 'react'
import { useLayoutEffect, useEffect, useRef, createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { useLayoutState } from '../useLayoutState'
import { DEFAULT_LAYOUT } from '../workspaceTypes'
import {
  sidebarVisibility, setDockVisible, setActivityVisible,
  firstCenterGroupId, centerOf,
} from '../../workspace/panelLayoutModel'
import type { PersistedState } from '../workspaceTypes'

// LEFT col visible, center group, RIGHT region present but HIDDEN.
const desktop = {
  kind: 'split', id: 'root', axis: 'row', children: [
    { node: { kind: 'leaf', id: 'l5', panel: 'files' } },
    { grow: true, node: { kind: 'tabs', id: 'g10', tabs: [{ instanceId: 'g11:e', kind: 'editor', tabId: 'a.ts' }], activeTab: 'g11:e' } },
    { hidden: true, node: { kind: 'leaf', id: 'sess', panel: 'sessions' } },
  ],
}

// LEFT dock + center, no right region — used to drive a left sidebar across edges.
const leftOnly = {
  kind: 'split', id: 'root', axis: 'row', children: [
    { node: { kind: 'leaf', id: 'l5', panel: 'files' } },
    { grow: true, node: { kind: 'tabs', id: 'g10', tabs: [{ instanceId: 'g11:e', kind: 'editor', tabId: 'a.ts' }], activeTab: 'g11:e' } },
  ],
}

const mkInitial = (d: unknown, showSidebar: boolean, showRightPanel: boolean): PersistedState => ({
  terminalBindings: {}, editorMru: [], terminalMru: [], activeGroupId: '',
  mobilePane: 'files', recentFiles: [],
  panelLayout: { version: 1, desktop: d as never, mobile: { activeDock: 'browse' }, panelState: { files: { mode: 'tree' } } },
  layout: { ...DEFAULT_LAYOUT, showSidebar, showRightPanel },
})

const apiHolder: { current: ReturnType<typeof useLayoutState> | null } = { current: null }
function Harness({ initial, onRender }: { initial: PersistedState; onRender: () => void }) {
  const dirty = useRef<ReadonlySet<string>>(new Set())
  const ls = useLayoutState(initial, dirty)
  const { layout, panelLayout, setPanelLayout, updateLayout } = ls
  onRender()
  useEffect(() => { apiHolder.current = ls })
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

describe('runtime batched tree-mutation + flag-flip', () => {
  it('does not storm and converges when revealing a hidden right column alongside a tree change', () => {
    const initial = mkInitial(desktop, true, false) // consistent: right hidden -> showRightPanel false
    let renders = 0
    let threw: string | null = null
    render(createElement(Harness, { initial, onRender: () => { renders++ } }))
    const baseline = renders
    const centerGroup = firstCenterGroupId(centerOf(apiHolder.current!.panelLayout.desktop))!
    try {
      act(() => {
        // Same commit: open a terminal tab in the center (desktop mutates) AND reveal the right column.
        apiHolder.current!.openBoundTerminalTab(centerGroup, 'sessions')
        apiHolder.current!.updateLayout({ showRightPanel: true })
      })
    } catch (e) { threw = e instanceof Error ? e.message : String(e) }
    const churn = renders - baseline
    const api = apiHolder.current!
    const vis = sidebarVisibility(api.panelLayout.desktop)
    cleanup()
    expect(threw).toBeNull()
    expect(churn).toBeLessThan(15)
    // Converged to the reveal, flag and tree in agreement.
    expect(api.layout.showRightPanel).toBe(true)
    expect(vis.right).toBe(true)
  })

  it('keeps the flag in sync across consecutive DnD moves of the same sidebar', () => {
    // Catches the stale-ref gap: after the reverse mirror writes the flag (move 1),
    // the next tree-only move (move 2) on the same side must still reconcile.
    const initial = mkInitial(leftOnly, true, false)
    let renders = 0
    let threw: string | null = null
    render(createElement(Harness, { initial, onRender: () => { renders++ } }))
    const baseline = renders
    const sync = () => {
      const api = apiHolder.current!
      const vis = sidebarVisibility(api.panelLayout.desktop)
      return { showSidebar: api.layout.showSidebar, left: vis.left }
    }
    try {
      act(() => { apiHolder.current!.moveLeafToEdge('l5', 'right') }) // empties the left → left hidden
      act(() => { apiHolder.current!.moveLeafToEdge('l5', 'left') })  // brings the left back → left visible
    } catch (e) { threw = e instanceof Error ? e.message : String(e) }
    const churn = renders - baseline
    const final = sync()
    cleanup()
    expect(threw).toBeNull()
    expect(churn).toBeLessThan(20)
    // After the round trip the left is visible again and the flag tracks it.
    expect(final.left).toBe(true)
    expect(final.showSidebar).toBe(true)
  })
})
