// Pure-geometry tests for dndGeometry: insertion indices, body third-bands, the
// far-edge strip, and the full legalZones constraint matrix (payload kind × target).
import { describe, it, expect } from 'vitest'
import {
  tabInsertIndex,
  sidebarInsertIndex,
  bodyDropZone,
  edgeZone,
  legalZones,
  EDGE_BAND_PX,
  type Rect,
  type DragKind,
  type Region,
  type TargetKind,
  type Zone,
} from '../dndGeometry'

// A row of three 100px-wide tabs at x = 0, 100, 200 (midpoints 50, 150, 250).
const tabs: Rect[] = [
  { x: 0, y: 0, width: 100, height: 30 },
  { x: 100, y: 0, width: 100, height: 30 },
  { x: 200, y: 0, width: 100, height: 30 },
]

// A column of three 40px-tall items at y = 0, 40, 80 (midpoints 20, 60, 100).
const items: Rect[] = [
  { x: 0, y: 0, width: 200, height: 40 },
  { x: 0, y: 40, width: 200, height: 40 },
  { x: 0, y: 80, width: 200, height: 40 },
]

describe('tabInsertIndex', () => {
  const cases: Array<[number, number]> = [
    [-10, 0], // far left of everything
    [10, 0], // left of first midpoint (50)
    [49, 0],
    [50, 1], // exactly on a midpoint counts as past it
    [51, 1],
    [149, 1],
    [150, 2],
    [250, 3], // past the last midpoint
    [999, 3], // far right
  ]
  it.each(cases)('x=%i -> index %i', (x, expected) => {
    expect(tabInsertIndex(tabs, x)).toBe(expected)
  })
  it('empty strip -> 0', () => {
    expect(tabInsertIndex([], 123)).toBe(0)
  })
})

describe('sidebarInsertIndex', () => {
  const cases: Array<[number, number]> = [
    [-5, 0],
    [10, 0], // above first midpoint (20)
    [20, 1],
    [60, 2],
    [100, 3],
    [500, 3],
  ]
  it.each(cases)('y=%i -> index %i', (y, expected) => {
    expect(sidebarInsertIndex(items, y)).toBe(expected)
  })
  it('empty column -> 0', () => {
    expect(sidebarInsertIndex([], 50)).toBe(0)
  })
})

describe('bodyDropZone', () => {
  const rect: Rect = { x: 0, y: 0, width: 300, height: 300 } // thirds at 100 / 200
  const at = (x: number, y: number) => bodyDropZone(rect, { x, y })

  it('center square (inner third) merges', () => {
    expect(at(150, 150)).toBe('center')
    expect(at(120, 120)).toBe('center')
    expect(at(200, 200)).toBe('center')
  })
  it('edge bands resolve to the nearest edge', () => {
    expect(at(20, 150)).toBe('left')
    expect(at(280, 150)).toBe('right')
    expect(at(150, 20)).toBe('up')
    expect(at(150, 280)).toBe('down')
  })
  it('off-axis bands pick the nearer edge', () => {
    expect(at(20, 90)).toBe('left') // left band, above center → left nearer than up
    expect(at(90, 20)).toBe('up') // top band, left of center → up nearer than left
  })
  it('points outside the rect clamp into the nearest edge, never throw', () => {
    expect(at(-50, 150)).toBe('left')
    expect(at(150, 999)).toBe('down')
  })
  it('a degenerate rect defaults to center', () => {
    expect(bodyDropZone({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0 })).toBe('center')
  })
})

describe('edgeZone', () => {
  const root: Rect = { x: 0, y: 0, width: 1000, height: 600 }
  it('within the left strip -> left', () => {
    expect(edgeZone(root, { x: 0, y: 300 })).toBe('left')
    expect(edgeZone(root, { x: EDGE_BAND_PX, y: 300 })).toBe('left')
  })
  it('within the right strip -> right', () => {
    expect(edgeZone(root, { x: 1000, y: 300 })).toBe('right')
    expect(edgeZone(root, { x: 1000 - EDGE_BAND_PX, y: 300 })).toBe('right')
  })
  it('the interior -> null', () => {
    expect(edgeZone(root, { x: 500, y: 300 })).toBeNull()
    expect(edgeZone(root, { x: EDGE_BAND_PX + 1, y: 300 })).toBeNull()
  })
  it('vertically outside the root -> null', () => {
    expect(edgeZone(root, { x: 0, y: -1 })).toBeNull()
    expect(edgeZone(root, { x: 0, y: 601 })).toBeNull()
  })
})

// --- The legality matrix ----------------------------------------------------

const target = (region: Region, kind: TargetKind) => ({ region, kind })
const zones = (...z: Zone[]) => new Set<Zone>(z)
const SPLITS: Zone[] = ['left', 'right', 'up', 'down']

describe('legalZones — the full payload × target matrix', () => {
  // [payload kind, region, target kind, expected zone set]
  const matrix: Array<[DragKind, Region, TargetKind, Set<Zone>]> = [
    // center group (tab bar / whole group)
    ['tab', 'center', 'group', zones('tab')],
    ['group', 'center', 'group', zones('center')],
    ['dock', 'center', 'group', zones()],
    // center body (edge splits + merge)
    ['tab', 'center', 'body', zones(...SPLITS, 'center')],
    ['group', 'center', 'body', zones(...SPLITS)],
    ['dock', 'center', 'body', zones()],
    // left sidebar — docks only
    ['dock', 'left', 'sidebar', zones('sidebar')],
    ['tab', 'left', 'sidebar', zones()],
    ['group', 'left', 'sidebar', zones()],
    // right sidebar — docks insert, tab/group merge into the one group
    ['dock', 'right', 'sidebar', zones('sidebar')],
    ['tab', 'right', 'sidebar', zones('center')],
    ['group', 'right', 'sidebar', zones('center')],
    // left edge — only a dock can reveal/extend it
    ['dock', 'left', 'edge', zones('edge')],
    ['tab', 'left', 'edge', zones()],
    ['group', 'left', 'edge', zones()],
    // right edge — dock extends, tab/group create the right sidebar + group
    ['dock', 'right', 'edge', zones('edge')],
    ['tab', 'right', 'edge', zones('edge')],
    ['group', 'right', 'edge', zones('edge')],
  ]
  it.each(matrix)('%s on %s %s', (pk, region, kind, expected) => {
    expect(legalZones({ kind: pk }, target(region, kind))).toEqual(expected)
  })
})

describe('legalZones — groups/bodies live only in the center', () => {
  // A group or body target outside the center is never a real cell → blank.
  const offCenter: Array<[DragKind, Region, TargetKind]> = [
    ['tab', 'left', 'group'],
    ['tab', 'right', 'group'],
    ['group', 'left', 'body'],
    ['group', 'right', 'body'],
    ['tab', 'right', 'body'],
    ['dock', 'left', 'body'],
  ]
  it.each(offCenter)('%s on %s %s -> blank', (pk, region, kind) => {
    expect(legalZones({ kind: pk }, target(region, kind))).toEqual(new Set())
  })
})
