import { describe, it, expect } from 'vitest'
import {
  buildTaskGraphModel,
  computeDisplayLayout,
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
} from './taskGraphModel'
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
