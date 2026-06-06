import { describe, it, expect } from 'vitest'
import {
  buildTaskGraphModel,
  computeDisplayLayout,
  computeGanttLayout,
  normalizeTasks,
  GRAPH_PADDING,
  INDENT,
  NODE_WIDTH,
  DEPENDS_GUTTER,
  type RawTaskMap,
  type RawTaskEntry,
  type TaskGraphTask,
  type TaskState,
  type GraphLayout,
  type GanttLayout,
} from './taskGraphModel'
import { PX_PER_UNIT, MIN_BAR } from './taskGraphConstants'
import { buildRail } from './metadataRail'

type Workset = 'active' | 'backlog' | 'archive'

const ALL_STATES = new Set<TaskState>(['ready', 'running', 'done', 'blocked', 'cancelled'])

function entry(partial: Partial<RawTaskEntry> & { title: string }): RawTaskEntry {
  return { parent: null, depends: [], state: 'ready', ...partial }
}

/**
 * Mirror exactly what TaskGraphScreen does: filter the canonical task map by the
 * active workset set, then feed the (still-full) forest maps into the layout.
 * This is the real V1 workset filter, exercised end-to-end through the layout.
 */
function layoutFor(raw: RawTaskMap, worksets: Set<Workset>, containerWidth = 1200): GraphLayout {
  const { model } = buildTaskGraphModel(raw)
  const visibleTasks = new Map([...model.tasks].filter(([, t]) => worksets.has(t.workset)))
  return computeDisplayLayout(
    {
      tasks: visibleTasks,
      childIdsByTask: model.childIdsByTask,
      rootIds: model.rootIds,
      subtreeIdsByTask: model.subtreeIdsByTask,
      dependenciesByTask: model.dependenciesByTask,
    },
    { collapsedTaskIds: new Set(), filters: ALL_STATES },
    model.aggregateStateByTask,
    model.leafProgressByTask,
    model.cycleEdgeIds,
    containerWidth,
  )
}

function makeTask(partial: Partial<RawTaskEntry> & { title: string }, id = 'sample-task-id'): TaskGraphTask {
  const { tasks } = normalizeTasks({ [id]: entry(partial) })
  return tasks.get(id)!
}

/** Mirror of layoutFor for the Pseudo-Gantt layout (no containerWidth — leftWidth is depth-derived). */
function ganttLayoutFor(raw: RawTaskMap, worksets: Set<Workset>, filters: Set<TaskState> = ALL_STATES): GanttLayout {
  const { model } = buildTaskGraphModel(raw)
  const visibleTasks = new Map([...model.tasks].filter(([, t]) => worksets.has(t.workset)))
  return computeGanttLayout(
    {
      tasks: visibleTasks,
      childIdsByTask: model.childIdsByTask,
      rootIds: model.rootIds,
      subtreeIdsByTask: model.subtreeIdsByTask,
      dependenciesByTask: model.dependenciesByTask,
    },
    { collapsedTaskIds: new Set(), filters },
    model.aggregateStateByTask,
    model.leafProgressByTask,
    model.cycleEdgeIds,
  )
}

// --- Criterion 1: workset filter (default active+backlog; archive opt-in) -----

describe('workset filtering', () => {
  const raw: RawTaskMap = {
    a: entry({ title: 'Active task', workset: 'active' }),
    b: entry({ title: 'Backlog task', workset: 'backlog' }),
    c: entry({ title: 'Archived task', workset: 'archive' }),
  }

  it('default active+backlog shows active and backlog, hides archive', () => {
    const layout = layoutFor(raw, new Set(['active', 'backlog']))
    expect(layout.nodes.has('a')).toBe(true)
    expect(layout.nodes.has('b')).toBe(true)
    expect(layout.nodes.has('c')).toBe(false)
  })

  it('archive becomes visible only when the archive workset is enabled', () => {
    const withArchive = layoutFor(raw, new Set(['active', 'backlog', 'archive']))
    expect(withArchive.nodes.has('c')).toBe(true)

    // And it can be viewed in isolation
    const archiveOnly = layoutFor(raw, new Set(['archive']))
    expect(archiveOnly.nodes.has('c')).toBe(true)
    expect(archiveOnly.nodes.has('a')).toBe(false)
    expect(archiveOnly.nodes.has('b')).toBe(false)
  })
})

// --- Criterion 2: vertical stacked root sections -----------------------------

describe('stacked layout — vertical roots, indented children, width-driven rows', () => {
  const raw: RawTaskMap = {
    r1: entry({ title: 'Root one' }),
    r2: entry({ title: 'Root two' }),
    r3: entry({ title: 'Root three' }),
    c1: entry({ title: 'Child of root one', parent: 'r1' }),
  }

  it('stacks roots top-to-bottom sharing one left edge (not side by side)', () => {
    const layout = layoutFor(raw, new Set(['active']), 1200)
    const roots = ['r1', 'r2', 'r3'].map(id => layout.nodes.get(id)!)
    expect(roots.every(Boolean)).toBe(true)

    // All roots share the same left edge — no horizontal spread between sections.
    const distinctX = new Set(roots.map(n => n.x))
    expect(distinctX).toEqual(new Set([GRAPH_PADDING]))

    // Every root sits at a distinct y — they stack vertically (sibling order may
    // differ from id order, so assert distinct/increasing on the sorted y set).
    const ys = roots.map(n => n.y).sort((a, b) => a - b)
    expect(new Set(ys).size).toBe(3)
    expect(ys[0]).toBeLessThan(ys[1])
    expect(ys[1]).toBeLessThan(ys[2])
  })

  it('indents children by parent and places them below the parent', () => {
    const layout = layoutFor(raw, new Set(['active']), 1200)
    const r1 = layout.nodes.get('r1')!
    const c1 = layout.nodes.get('c1')!
    expect(c1.x).toBe(r1.x + INDENT)
    expect(c1.y).toBeGreaterThan(r1.y)
  })

  it('lets row width fill the container (width-driven), with a NODE_WIDTH floor when narrow', () => {
    const wide = layoutFor(raw, new Set(['active']), 1200)
    const rightEdge = 1200 - GRAPH_PADDING - DEPENDS_GUTTER
    expect(wide.nodes.get('r1')!.width).toBe(rightEdge - GRAPH_PADDING)
    expect(wide.nodes.get('r1')!.width).toBeGreaterThan(NODE_WIDTH)

    // Narrow container clamps to the minimum card width.
    const narrow = layoutFor(raw, new Set(['active']), 200)
    expect(narrow.nodes.get('r1')!.width).toBe(NODE_WIDTH)
  })
})

// --- Criterion 3: only real `depends` edges render ---------------------------

describe('edges — only real dependency relationships, never structural ones', () => {
  it('renders exactly one edge for a single depends, none for parent/sibling links', () => {
    const raw: RawTaskMap = {
      P: entry({ title: 'Parent' }),
      C1: entry({ title: 'Child one', parent: 'P' }),
      C2: entry({ title: 'Child two', parent: 'P', depends: ['C1'] }),
    }
    const layout = layoutFor(raw, new Set(['active']))
    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0].sourceId).toBe('C1')
    expect(layout.edges[0].targetId).toBe('C2')
  })

  it('produces no edges from parent, priority, workset, state, or tag differences', () => {
    const raw: RawTaskMap = {
      P: entry({ title: 'Parent', priority: 'critical' }),
      C1: entry({ title: 'Child one', parent: 'P', priority: 'high', state: 'done', tags: ['x'] }),
      C2: entry({ title: 'Child two', parent: 'P', priority: 'low', state: 'running', tags: ['y'] }),
      Q: entry({ title: 'Lonely root', priority: 'high', tags: ['z'] }),
    }
    const layout = layoutFor(raw, new Set(['active']))
    expect(layout.edges).toHaveLength(0)
  })
})

// --- Criterion 4a: title kept in full (single-line render clips, data is whole) ---

describe('title', () => {
  it('preserves the full untruncated title for hover/select/detail access', () => {
    const long = 'Iterate providers in install and doctor without changing the doctor schema at all'
    const { tasks } = normalizeTasks({ t: entry({ title: long }) })
    expect(tasks.get('t')!.title).toBe(long)
  })
})

// --- Criterion 4b: metadata rail collapses width-driven ----------------------

describe('metadata rail — width-driven collapse (buildRail)', () => {
  const task = makeTask({ title: 'X', priority: 'high', workset: 'backlog', agent: 'claude' }, 'long-task-id')

  it('shows id, agent, priority, workset (in that order) when there is room', () => {
    const rail = buildRail(task, 0, 1000)
    expect(rail.map(i => i.key)).toEqual(['id', 'agent', 'priority', 'workset'])
    // Right-aligned: the last badge ends exactly at the right bound.
    const last = rail[rail.length - 1]
    expect(last.x + last.width).toBe(1000)
  })

  it('drops fields from the low-priority end as the row narrows, through every intermediate prefix', () => {
    // Field badge widths for this task (railItemWidth = ceil(len*6.3) + 10):
    //   id 'long-task-id'(12)=86, agent 'claude'(6)=48, priority 'high'(4)=36, workset 'backlog'(7)=55
    // Greedy cumulative thresholds (first item has no leading gap; RAIL_GAP=5):
    //   id 86 | +agent 139 | +priority 180 | +workset 240
    // Each width below lands squarely inside one band so the exact prefix is asserted.
    expect(buildRail(task, 0, 250).map(i => i.key)).toEqual(['id', 'agent', 'priority', 'workset'])
    expect(buildRail(task, 0, 200).map(i => i.key)).toEqual(['id', 'agent', 'priority'])
    expect(buildRail(task, 0, 160).map(i => i.key)).toEqual(['id', 'agent'])
    expect(buildRail(task, 0, 110).map(i => i.key)).toEqual(['id'])
    expect(buildRail(task, 0, 30).map(i => i.key)).toEqual([])
  })

  it('hides default-valued fields (normal priority, active workset, no agent)', () => {
    const plain = makeTask({ title: 'X', priority: 'normal', workset: 'active' }, 'plain-id')
    expect(buildRail(plain, 0, 1000).map(i => i.key)).toEqual(['id'])
  })

  it('shows the full id when the row is wide instead of a fixed-width truncation', () => {
    // Regression: a long id used to be hard-capped at 16 chars, so it showed an
    // ellipsis even on very wide rows. It must now render in full when it fits.
    const longId = 'workspace-state-toolbar' // 23 chars, well over the old 16 cap
    const wide = makeTask({ title: 'X', priority: 'normal', workset: 'active' }, longId)
    const rail = buildRail(wide, 0, 1000)
    expect(rail.map(i => i.key)).toEqual(['id'])
    expect(rail[0].text).toBe(longId)        // full id, no ellipsis
    expect(rail[0].text).not.toContain('…')
    expect(rail[0].x + rail[0].width).toBe(1000) // still right-aligned to the bound
  })

  it('drops a badge entirely rather than truncating it when it cannot fully fit', () => {
    // Tags are all-or-nothing: a field shows its full text or is dropped. No ellipsis.
    const longId = 'workspace-state-toolbar' // full badge width ~155
    const task = makeTask({ title: 'X', priority: 'normal', workset: 'active' }, longId)
    expect(buildRail(task, 0, 90)).toEqual([])   // id cannot fit in full → no rail
    expect(buildRail(task, 0, 20)).toEqual([])   // far too narrow → no rail
    const ok = buildRail(task, 0, 1000)
    expect(ok.map(i => i.key)).toEqual(['id'])   // fits in full when there is room
    expect(ok[0].text).toBe(longId)
  })
})

// --- Pseudo-Gantt layout — computeGanttLayout --------------------------------

describe('gantt layout — bars + ruler from the schedule', () => {
  it('positions bars at start·PX with duration·PX width, ruler over 0..ceil(makespan)', () => {
    const raw: RawTaskMap = {
      A: entry({ title: 'A', estimate: 's' }),                 // dur 2 → [0,2)
      B: entry({ title: 'B', depends: ['A'], estimate: 'l' }), // dur 5 → [2,7)
    }
    const layout = ganttLayoutFor(raw, new Set(['active']))

    const a = layout.bars.get('A')!
    const b = layout.bars.get('B')!
    expect(a.x).toBe(0)
    expect(a.width).toBe(2 * PX_PER_UNIT)
    expect(b.x).toBe(2 * PX_PER_UNIT)          // starts when A finishes
    expect(b.width).toBe(5 * PX_PER_UNIT)
    // bar y tracks the row's left-pane y
    expect(a.y).toBe(layout.nodes.get('A')!.y)

    // makespan 7 → ticks 0..7 at unit·PX
    expect(layout.ruler.ticks.map(t => t.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7'])
    expect(layout.ruler.ticks[3].x).toBe(3 * PX_PER_UNIT)
    expect(layout.timeWidth).toBeGreaterThan(7 * PX_PER_UNIT)
  })

  it('never renders a bar narrower than the MIN_BAR floor', () => {
    const raw: RawTaskMap = { A: entry({ title: 'A', estimate: 'xs' }) } // smallest duration
    const layout = ganttLayoutFor(raw, new Set(['active']))
    for (const bar of layout.bars.values()) {
      expect(bar.width).toBeGreaterThanOrEqual(MIN_BAR)
    }
    // The 1-unit bar still renders at its true duration·PX (floor does not inflate it).
    expect(layout.bars.get('A')!.width).toBe(Math.max(MIN_BAR, 1 * PX_PER_UNIT))
  })
})

describe('gantt layout — leftWidth grows with depth (no clip)', () => {
  it('widens the frozen column for the deepest visible row so cards never clip', () => {
    const shallow = ganttLayoutFor({ r: entry({ title: 'r' }) }, new Set(['active']))
    const deep = ganttLayoutFor(
      {
        a: entry({ title: 'a' }),
        b: entry({ title: 'b', parent: 'a' }),
        c: entry({ title: 'c', parent: 'b' }),
        d: entry({ title: 'd', parent: 'c' }),
      },
      new Set(['active']),
    )

    expect(deep.leftWidth).toBeGreaterThan(shallow.leftWidth)

    // Deepest card's natural right edge fits inside leftWidth — no clipping.
    const d = deep.nodes.get('d')!
    expect(d.x + NODE_WIDTH).toBeLessThanOrEqual(deep.leftWidth)

    // Every card shares the one column right edge (rightEdge === leftWidth).
    for (const node of deep.nodes.values()) {
      expect(node.x + node.width).toBe(deep.leftWidth)
    }
    expect(deep.bounds.width).toBe(deep.leftWidth)
  })
})

describe('gantt layout — finish-to-start dependency edges', () => {
  it('routes left→right as cubic paths and always populates originalEdgeIds', () => {
    const raw: RawTaskMap = {
      A: entry({ title: 'A', estimate: 's' }),
      B: entry({ title: 'B', depends: ['A'], estimate: 'm' }),
    }
    const layout = ganttLayoutFor(raw, new Set(['active']))

    expect(layout.edges).toHaveLength(1)
    const e = layout.edges[0]
    expect(e.sourceId).toBe('A')
    expect(e.targetId).toBe('B')
    expect(e.count).toBe(1)
    expect(e.originalEdgeIds).toEqual(['A->B']) // populated even at count===1
    expect(e.path.startsWith('M ')).toBe(true)
    expect(e.path).toContain(' C ')             // cubic

    // Finish-to-start: source bar's right edge is left of (or at) the target bar's start.
    const a = layout.bars.get('A')!
    const b = layout.bars.get('B')!
    expect(a.x + a.width).toBeLessThanOrEqual(b.x)
  })

  it('emits only real depends edges, never the CPM effective-predecessor edges', () => {
    // T depends on a GROUP. The schedule expands G→{G1,G2} internally, but the only
    // rendered edge is the real G→T (resolved to the visible group anchor).
    const raw: RawTaskMap = {
      G: entry({ title: 'G' }),
      G1: entry({ title: 'G1', parent: 'G', estimate: 's' }),
      G2: entry({ title: 'G2', parent: 'G', estimate: 'm' }),
      T: entry({ title: 'T', depends: ['G'], estimate: 's' }),
    }
    const layout = ganttLayoutFor(raw, new Set(['active']))

    expect(layout.edges).toHaveLength(1)
    expect(layout.edges[0].sourceId).toBe('G')
    expect(layout.edges[0].targetId).toBe('T')
    expect(layout.edges[0].originalEdgeIds).toEqual(['G->T'])

    // Group summary bar spans its scheduled leaves; T starts when the group finishes.
    const g = layout.bars.get('G')!
    expect(g.isSummary).toBe(true)
    expect(layout.bars.get('T')!.x).toBe(g.x + g.width)
  })

  it('does not resurface a STATE-filtered-out predecessor as an edge (view-local)', () => {
    // T depends on A. A and C are leaves under group P. Filtering out A's state leaves P
    // visible (via C) with a summary bar — but A is no longer in the schedule set S, so the
    // A→T dependency was dropped from the schedule and must NOT render through P.
    const raw: RawTaskMap = {
      P: entry({ title: 'P' }),
      A: entry({ title: 'A', parent: 'P', state: 'done', estimate: 's' }),
      C: entry({ title: 'C', parent: 'P', state: 'ready', estimate: 's' }),
      T: entry({ title: 'T', state: 'ready', depends: ['A'], estimate: 's' }),
    }
    // With every state visible, A is scheduled and the real edge renders (A→T).
    const all = ganttLayoutFor(raw, new Set(['active']))
    expect(all.edges).toHaveLength(1)
    expect(all.edges[0].sourceId).toBe('A')
    expect(all.edges[0].targetId).toBe('T')

    // Filtering 'done' out removes A from S → no bar for A → no resurrected P→T edge.
    const filtered = ganttLayoutFor(raw, new Set(['active']), new Set<TaskState>(['ready']))
    expect(filtered.bars.has('A')).toBe(false)
    expect(filtered.edges).toHaveLength(0)
  })

  it('omits right-to-left back-edges from a depends cycle (no negative bezier coords)', () => {
    // A↔B mutual depends. One arc is forward (sx ≤ tx), the reverse is a back-edge whose
    // FS routing would need negative control coords — it must be omitted, not emitted.
    const raw: RawTaskMap = {
      A: entry({ title: 'A', depends: ['B'], estimate: 's' }),
      B: entry({ title: 'B', depends: ['A'], estimate: 's' }),
    }
    const layout = ganttLayoutFor(raw, new Set(['active']))

    // Same cubic shape TaskGraphEdges.getEdgeMidpoint parses — strictly non-negative coords.
    const cubic = /^M\s+([\d.]+),([\d.]+)\s+C\s+([\d.]+),([\d.]+)\s+([\d.]+),([\d.]+)\s+([\d.]+),([\d.]+)$/
    expect(layout.edges.length).toBeGreaterThan(0)
    for (const e of layout.edges) {
      const m = e.path.match(cubic)
      expect(m).not.toBeNull()
      const nums = m!.slice(1).map(Number)
      expect(nums.every(n => n >= 0)).toBe(true)  // no negative control coords
      expect(nums[0]).toBeLessThanOrEqual(nums[6]) // left→right: start x ≤ end x
    }
    // The reverse (right-to-left) arc B→A is gone; the forward arc A→B remains.
    expect(layout.edges.some(e => e.sourceId === 'B' && e.targetId === 'A')).toBe(false)
  })
})

describe('gantt layout — effective-cycle bars', () => {
  it('flags cycle tasks on the bar (cycle:true) and never marks them critical', () => {
    // A↔B mutual depends → an effective cycle; both bars carry cycle and stay non-critical.
    const raw: RawTaskMap = {
      A: entry({ title: 'A', depends: ['B'], estimate: 's' }),
      B: entry({ title: 'B', depends: ['A'], estimate: 's' }),
    }
    const layout = ganttLayoutFor(raw, new Set(['active']))

    for (const id of ['A', 'B']) {
      const bar = layout.bars.get(id)!
      expect(bar.cycle).toBe(true)
      expect(bar.critical).toBe(false)
    }
  })
})

describe('gantt layout — extends GraphLayout', () => {
  it('carries nodes/groups/edges/visibleOrder/visibleChildrenByTask/bounds/hasCycles', () => {
    const raw: RawTaskMap = {
      P: entry({ title: 'P' }),
      C1: entry({ title: 'C1', parent: 'P' }),
      C2: entry({ title: 'C2', parent: 'P', depends: ['C1'] }),
    }
    const layout = ganttLayoutFor(raw, new Set(['active']))

    // GraphLayout fields keep selection/keyboard/search/collapse working unchanged.
    expect(layout.nodes.has('P')).toBe(true)
    expect(layout.visibleOrder).toContain('P')
    expect(layout.visibleChildrenByTask.get('P')).toEqual(expect.arrayContaining(['C1', 'C2']))
    expect(layout.groups.some(g => g.id === 'P')).toBe(true)
    expect(typeof layout.hasCycles).toBe('boolean')

    // Gantt-specific additions.
    expect(layout.bars instanceof Map).toBe(true)
    expect(layout.ruler.ticks.length).toBeGreaterThan(0)
    expect(layout.bounds.width).toBe(layout.leftWidth)
    expect(layout.timeWidth).toBeGreaterThan(0)
  })
})

describe('gantt layout — critical-path flags propagate to the bars', () => {
  it('marks the converging critical chain and leaves the slack branch unmarked', () => {
    // A (m=3) and B (s=2) both feed C (m=3). The long branch A→C is critical
    // (slack 0); B carries 1 unit of slack. Criticality must reach the bars.
    const raw: RawTaskMap = {
      a: entry({ title: 'A', estimate: 'm' }),
      b: entry({ title: 'B', estimate: 's' }),
      c: entry({ title: 'C', depends: ['a', 'b'], estimate: 'm' }),
    }
    const layout = ganttLayoutFor(raw, new Set(['active']))

    expect(layout.bars.get('a')!.critical).toBe(true)
    expect(layout.bars.get('c')!.critical).toBe(true)
    expect(layout.bars.get('b')!.critical).toBe(false)

    // Integer-exact: the critical bars abut edge-to-edge (zero slack gap), while the
    // slack branch ends short of the converging successor's start.
    const a = layout.bars.get('a')!
    const b = layout.bars.get('b')!
    const c = layout.bars.get('c')!
    expect(a.x + a.width).toBe(c.x)
    expect(b.x + b.width).toBeLessThan(c.x)
  })
})
