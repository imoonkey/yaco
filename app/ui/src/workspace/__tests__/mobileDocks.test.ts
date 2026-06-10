// Unit tests for the mobile dock helpers the projection (T6) relies on: the
// MobilePane ⇄ MobileDock conversion (the single vocabulary boundary) and the
// registry-driven dock membership (`mobileDockPanels`).
import { describe, it, expect } from 'vitest'
import { mobilePaneToDock, mobileDockToPane, type MobilePane } from '../../hooks/workspaceTypes'
import { mobileDockPanels } from '../panelMeta'
import { MOBILE_DOCKS } from '../panelLayoutModel'
import type { MobileDock } from '../panelMeta'

const PANES: MobilePane[] = ['files', 'editor', 'tasks', 'terminal']

describe('mobilePaneToDock / mobileDockToPane', () => {
  it('map the browse pane between names and pass the rest through', () => {
    expect(mobilePaneToDock('files')).toBe('browse')
    expect(mobileDockToPane('browse')).toBe('files')
    for (const shared of ['editor', 'tasks', 'terminal'] as const) {
      expect(mobilePaneToDock(shared)).toBe(shared)
      expect(mobileDockToPane(shared)).toBe(shared)
    }
  })

  it('round-trip is the identity in both directions', () => {
    for (const pane of PANES) expect(mobileDockToPane(mobilePaneToDock(pane))).toBe(pane)
    for (const dock of MOBILE_DOCKS) expect(mobilePaneToDock(mobileDockToPane(dock))).toBe(dock)
  })
})

describe('mobileDockPanels', () => {
  it('returns the browse dock panels in mobile order', () => {
    expect(mobileDockPanels('browse')).toEqual(['projects', 'files', 'changes', 'sessions'])
  })

  it('returns a single panel for each unframed dock', () => {
    expect(mobileDockPanels('editor')).toEqual(['editor'])
    expect(mobileDockPanels('tasks')).toEqual(['tasks'])
    expect(mobileDockPanels('terminal')).toEqual(['terminal'])
  })

  it('covers every panel exactly once across the four docks', () => {
    const all = (MOBILE_DOCKS as readonly MobileDock[]).flatMap((dock) => mobileDockPanels(dock))
    expect(all.sort()).toEqual(
      ['changes', 'editor', 'files', 'projects', 'sessions', 'tasks', 'terminal'],
    )
  })
})
