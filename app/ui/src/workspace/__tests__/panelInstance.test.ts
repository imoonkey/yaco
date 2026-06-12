// Unit tests for the per-instance render helpers (mi-render). Pure logic: the
// split-axis geometry, its orthogonal flip, and the focus/active marker decision
// (bright focus, dim active, dim suppressed when one-of-type).
import { describe, it, expect } from 'vitest'
import { splitSideFromGeometry, orthogonalSide, paneMarker } from '../panelInstance'
import type { FocusedPane } from '../../hooks/workspaceTypes'

const focus = (kind: FocusedPane['kind'], instanceId: string): FocusedPane => ({ kind, instanceId })

describe('splitSideFromGeometry', () => {
  it('splits a wide pane to the right, a tall pane below', () => {
    expect(splitSideFromGeometry(800, 400)).toBe('right')
    expect(splitSideFromGeometry(300, 600)).toBe('below')
  })
  it('treats a square pane as wide (splits right)', () => {
    expect(splitSideFromGeometry(500, 500)).toBe('right')
  })
})

describe('orthogonalSide', () => {
  it('flips the split axis', () => {
    expect(orthogonalSide('right')).toBe('below')
    expect(orthogonalSide('below')).toBe('right')
    expect(orthogonalSide('left')).toBe('above')
    expect(orthogonalSide('above')).toBe('left')
  })
})

describe('paneMarker', () => {
  it('marks the focused editor bright', () => {
    expect(paneMarker('editor', 'editor:2', focus('editor', 'editor:2'), 'editor:2', null, 2, 0))
      .toEqual({ focused: true, active: false })
  })

  it('marks the active-but-unfocused editor dim when there are multiple editors', () => {
    // focus is on a terminal; the active editor is editor (unfocused) → dim.
    expect(paneMarker('editor', 'editor', focus('terminal', 'terminal'), 'editor', 'terminal', 2, 1))
      .toEqual({ focused: false, active: true })
  })

  it('suppresses the dim marker when the type has a single instance', () => {
    expect(paneMarker('editor', 'editor', focus('terminal', 'terminal'), 'editor', 'terminal', 1, 1))
      .toEqual({ focused: false, active: false })
  })

  it('marks the focused terminal bright and the other terminal dim', () => {
    const focused = focus('terminal', 'terminal:2')
    expect(paneMarker('terminal', 'terminal:2', focused, 'editor', 'terminal:2', 1, 2))
      .toEqual({ focused: true, active: false })
    expect(paneMarker('terminal', 'terminal', focused, 'editor', 'terminal:2', 1, 2))
      .toEqual({ focused: false, active: false }) // not active (terminal:2 is), not focused
  })

  it('never marks a non-whitelisted panel', () => {
    expect(paneMarker('files', 'files', focus('explorer', 'explorer'), 'editor', 'terminal', 2, 2))
      .toEqual({ focused: false, active: false })
    expect(paneMarker('tasks', 'tasks', focus('tasks', 'tasks'), 'editor', 'terminal', 2, 2))
      .toEqual({ focused: false, active: false })
  })
})
