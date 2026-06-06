import { describe, it, expect } from 'vitest'
import { buildTaskGraphModel, type RawTaskMap, type RawTaskEntry } from './taskGraphModel'
import { computeGanttSchedule, type GanttSchedule } from './ganttSchedule'

function entry(partial: Partial<RawTaskEntry> & { title: string }): RawTaskEntry {
  return { parent: null, depends: [], state: 'ready', ...partial }
}

// Schedule over a visible set (defaults to every task) — mirrors how the screen
// feeds the filter-visible set into the pure scheduler.
function schedule(raw: RawTaskMap, visible?: Set<string>): GanttSchedule {
  const { model } = buildTaskGraphModel(raw)
  const vis = visible ?? new Set(model.tasks.keys())
  return computeGanttSchedule(
    { tasks: model.tasks, subtreeIdsByTask: model.subtreeIdsByTask },
    vis,
  )
}

// --- Duration map + assumed default ------------------------------------------

describe('duration map and assumed default', () => {
  const cases: Array<[string | null | undefined, number, boolean]> = [
    ['xs', 1, false],
    ['s', 2, false],
    ['m', 3, false],
    ['l', 5, false],
    ['xl', 8, false],
    [undefined, 3, true], // missing → m, assumed
    [null, 3, true],
    ['xxl', 3, true], // unknown → m, assumed
    ['', 3, true],
    ['toString', 3, true], // Object.prototype key must not leak in as a valid estimate
    ['constructor', 3, true],
    ['__proto__', 3, true],
  ]

  for (const [estimate, duration, assumed] of cases) {
    it(`estimate ${JSON.stringify(estimate)} → duration ${duration}, assumed ${assumed}`, () => {
      const s = schedule({ t: entry({ title: 'T', estimate: estimate ?? undefined }) })
      const e = s.entries.get('t')!
      expect(e.duration).toBe(duration)
      expect(e.assumed).toBe(assumed)
      expect(e.start).toBe(0)
      expect(e.finish).toBe(duration)
    })
  }

  it('every start/finish/duration is an integer', () => {
    const s = schedule({
      a: entry({ title: 'A', estimate: 'l' }),
      b: entry({ title: 'B', estimate: 's', depends: ['a'] }),
    })
    for (const e of s.entries.values()) {
      expect(Number.isInteger(e.start)).toBe(true)
      expect(Number.isInteger(e.finish)).toBe(true)
      expect(Number.isInteger(e.duration)).toBe(true)
    }
  })
})

// --- Forward pass: leaf → leaf -----------------------------------------------

describe('forward pass — leaf → leaf chain', () => {
  it('places a dependent leaf after its predecessor finishes', () => {
    const s = schedule({
      a: entry({ title: 'A', estimate: 'm' }),
      b: entry({ title: 'B', estimate: 'm', depends: ['a'] }),
    })
    expect(s.entries.get('a')).toMatchObject({ start: 0, finish: 3 })
    expect(s.entries.get('b')).toMatchObject({ start: 3, finish: 6 })
    expect(s.makespan).toBe(6)
    // Single chain → everything is critical.
    expect(s.entries.get('a')!.critical).toBe(true)
    expect(s.entries.get('b')!.critical).toBe(true)
    expect(s.entries.get('a')!.slack).toBe(0)
  })

  it('a no-dependency leaf starts at 0', () => {
    const s = schedule({ a: entry({ title: 'A', estimate: 's' }) })
    expect(s.entries.get('a')).toMatchObject({ start: 0, finish: 2 })
    expect(s.makespan).toBe(2)
  })
})

// --- leaf → group (group dep expands to its leaves) --------------------------

describe('leaf → group dependency expands to descendant leaves', () => {
  const raw: RawTaskMap = {
    G: entry({ title: 'Group' }),
    G1: entry({ title: 'G1', parent: 'G', estimate: 's' }), // 2
    G2: entry({ title: 'G2', parent: 'G', estimate: 'm' }), // 3
    B: entry({ title: 'B', estimate: 'm', depends: ['G'] }),
  }

  it('starts the dependent after the latest finish among the group leaves', () => {
    const s = schedule(raw)
    expect(s.entries.get('G1')).toMatchObject({ start: 0, finish: 2 })
    expect(s.entries.get('G2')).toMatchObject({ start: 0, finish: 3 })
    // B depends on G → effPreds(B) = {G1, G2}; start = max(finish) = 3.
    expect(s.entries.get('B')).toMatchObject({ start: 3, finish: 6 })
  })

  it('summarizes the group as a bar spanning its visible leaves', () => {
    const s = schedule(raw)
    const g = s.entries.get('G')!
    expect(g.start).toBe(0)
    expect(g.finish).toBe(3)
    expect(g.isSummary).toBe(true)
  })
})

// --- group → task ancestor inheritance ---------------------------------------

describe('ancestor inheritance — a leaf inherits its ancestors depends', () => {
  it('a child inherits the parent group dependency', () => {
    const s = schedule({
      X: entry({ title: 'X', estimate: 'm' }), // 3
      P: entry({ title: 'Parent', depends: ['X'] }),
      C: entry({ title: 'Child', parent: 'P', estimate: 's' }), // 2
    })
    // C inherits P.depends = [X] → effPreds(C) = {X}; starts at finish(X) = 3.
    expect(s.entries.get('C')).toMatchObject({ start: 3, finish: 5 })
  })

  it('a parent depending on its own descendant produces no self-edge', () => {
    // Canonical: leavesOf(C) ∩ {C-leaf} \ {C} = ∅, so C starts at 0 — no cycle.
    const s = schedule({
      P: entry({ title: 'Parent', depends: ['C'] }),
      C: entry({ title: 'Child', parent: 'P', estimate: 'm' }),
    })
    const c = s.entries.get('C')!
    expect(c.start).toBe(0)
    expect(c.cycle).toBe(false)
  })
})

// --- multi-root / multi-sink slack -------------------------------------------

describe('multi-root convergence — slack and critical path', () => {
  it('computes slack from the longest converging chain', () => {
    const s = schedule({
      a: entry({ title: 'A', estimate: 'm' }), // 3
      b: entry({ title: 'B', estimate: 's' }), // 2
      c: entry({ title: 'C', estimate: 'm', depends: ['a', 'b'] }), // 3
    })
    expect(s.makespan).toBe(6)
    // A on the critical path (slack 0); B has 1 unit of slack.
    expect(s.entries.get('a')).toMatchObject({ slack: 0, critical: true })
    expect(s.entries.get('c')).toMatchObject({ slack: 0, critical: true })
    expect(s.entries.get('b')!.slack).toBe(1)
    expect(s.entries.get('b')!.critical).toBe(false)
  })

  it('a lone sink uses the global makespan as its latest finish', () => {
    // Two independent chains of different length share one makespan; the shorter
    // chain's tail carries slack relative to the global makespan.
    const s = schedule({
      a: entry({ title: 'A', estimate: 'xl' }), // 8, lone chain
      b: entry({ title: 'B', estimate: 'm' }), // 3, lone chain
    })
    expect(s.makespan).toBe(8)
    expect(s.entries.get('a')).toMatchObject({ slack: 0, critical: true })
    expect(s.entries.get('b')!.slack).toBe(5)
    expect(s.entries.get('b')!.critical).toBe(false)
  })

  it('a shared predecessor takes the MIN latestStart across its successors', () => {
    // P fans out to two successors of different chain lengths:
    //   P (m=3) → short (s=2, sink)
    //   P (m=3) → long  (xl=8, sink)
    // makespan = 3 + 8 = 11.
    //   short: latestStart = 11 - 2 = 9
    //   long:  latestStart = 11 - 8 = 3   ← tighter
    // P.latestFinish = min(9, 3) = 3 → latestStart 0, slack 0, critical.
    // The long chain drives P's criticality; the loose `short` edge must not
    // relax it.
    const s = schedule({
      P: entry({ title: 'P', estimate: 'm' }),
      short: entry({ title: 'Short', estimate: 's', depends: ['P'] }),
      long: entry({ title: 'Long', estimate: 'xl', depends: ['P'] }),
    })
    expect(s.makespan).toBe(11)
    expect(s.entries.get('P')).toMatchObject({ start: 0, slack: 0, critical: true })
    // The long chain is critical end-to-end; the short branch carries slack.
    expect(s.entries.get('long')).toMatchObject({ slack: 0, critical: true })
    expect(s.entries.get('short')!.slack).toBe(6)
    expect(s.entries.get('short')!.critical).toBe(false)
  })
})

// --- raw cycles --------------------------------------------------------------

describe('raw cycles — every node still gets a defined schedule', () => {
  it('breaks a 2-node cycle, flags both, excludes them from critical', () => {
    const s = schedule({
      a: entry({ title: 'A', estimate: 'm', depends: ['b'] }),
      b: entry({ title: 'B', estimate: 'm', depends: ['a'] }),
    })
    for (const id of ['a', 'b']) {
      const e = s.entries.get(id)!
      expect(e.cycle).toBe(true)
      expect(e.critical).toBe(false)
      expect(Number.isInteger(e.start)).toBe(true)
      expect(Number.isInteger(e.finish)).toBe(true)
      expect(e.finish).toBe(e.start + e.duration)
    }
  })
})

// --- generated effective cycles + self-deps ----------------------------------

describe('generated effective cycles and self-deps', () => {
  it('a self-dependency terminates and is not a cycle', () => {
    const s = schedule({ a: entry({ title: 'A', estimate: 'm', depends: ['a'] }) })
    expect(s.entries.get('a')).toMatchObject({ start: 0, cycle: false })
  })

  it('detects a cycle generated by ancestor inheritance that the raw graph lacks', () => {
    // Raw graph: A and B have no direct depends → acyclic.
    // P1 depends on B (leaf in P2); P2 depends on A (leaf in P1).
    // Inheritance: A inherits [B], B inherits [A] → effective A↔B cycle.
    const s = schedule({
      P1: entry({ title: 'P1', depends: ['B'] }),
      A: entry({ title: 'A', parent: 'P1', estimate: 'm' }),
      P2: entry({ title: 'P2', depends: ['A'] }),
      B: entry({ title: 'B', parent: 'P2', estimate: 'm' }),
    })
    expect(s.entries.get('A')!.cycle).toBe(true)
    expect(s.entries.get('B')!.cycle).toBe(true)
    for (const id of ['A', 'B']) {
      const e = s.entries.get(id)!
      expect(Number.isInteger(e.start)).toBe(true)
      expect(Number.isInteger(e.finish)).toBe(true)
    }
  })
})

// --- hidden-predecessor view-local rule --------------------------------------

describe('view-local — a predecessor outside the visible set is dropped', () => {
  const raw: RawTaskMap = {
    a: entry({ title: 'A', estimate: 'm' }),
    b: entry({ title: 'B', estimate: 'm', depends: ['a'] }),
  }

  it('honors the dependency when both are visible', () => {
    const s = schedule(raw, new Set(['a', 'b']))
    expect(s.entries.get('b')!.start).toBe(3)
  })

  it('drops the dependency and starts B at 0 when A is hidden', () => {
    const s = schedule(raw, new Set(['b']))
    expect(s.entries.get('b')!.start).toBe(0)
    expect(s.entries.has('a')).toBe(false)
  })
})

// --- group summary edge cases ------------------------------------------------

describe('group summary rules', () => {
  it('min start / max finish / min slack / any critical over visible leaves', () => {
    const s = schedule({
      G: entry({ title: 'Group' }),
      G1: entry({ title: 'G1', parent: 'G', estimate: 'm' }), // critical chain head
      G2: entry({ title: 'G2', parent: 'G', estimate: 's' }), // shorter → slack
      tail: entry({ title: 'Tail', estimate: 'm', depends: ['G1'] }),
    })
    const g = s.entries.get('G')!
    const g1 = s.entries.get('G1')!
    const g2 = s.entries.get('G2')!
    expect(g.start).toBe(Math.min(g1.start, g2.start))
    expect(g.finish).toBe(Math.max(g1.finish, g2.finish))
    expect(g.slack).toBe(Math.min(g1.slack, g2.slack))
    expect(g.critical).toBe(g1.critical || g2.critical)
    expect(g.isSummary).toBe(true)
  })

  it('a visible group with no scheduled visible leaves gets no bar', () => {
    const raw: RawTaskMap = {
      G: entry({ title: 'Group' }),
      C: entry({ title: 'Child', parent: 'G', estimate: 'm' }),
    }
    // Only the group is visible; its single leaf is filtered out.
    const s = schedule(raw, new Set(['G']))
    expect(s.entries.has('G')).toBe(false)
    expect(s.entries.has('C')).toBe(false)
  })
})

// --- empty view --------------------------------------------------------------

describe('empty visible set', () => {
  it('yields an empty schedule with makespan 0', () => {
    const s = schedule({ a: entry({ title: 'A' }) }, new Set())
    expect(s.entries.size).toBe(0)
    expect(s.makespan).toBe(0)
  })
})

// --- determinism -------------------------------------------------------------

// Order-independent fingerprint of an entire schedule (sorted by id so two runs
// with different Map insertion order still compare equal when truly identical).
function fingerprint(s: GanttSchedule): { makespan: number; rows: string[] } {
  return {
    makespan: s.makespan,
    rows: [...s.entries.entries()]
      .map(([id, e]) =>
        `${id}:${e.start},${e.finish},${e.duration},${e.slack},` +
        `${e.critical ? 1 : 0},${e.cycle ? 1 : 0},${e.assumed ? 1 : 0},${e.isSummary ? 1 : 0}`)
      .sort(),
  }
}

const reversed = (raw: RawTaskMap): RawTaskMap =>
  Object.fromEntries(Object.entries(raw).reverse()) as RawTaskMap

describe('determinism — identical input yields an identical schedule', () => {
  // Exercises every path at once: a group summary, a multi-dep converging sink,
  // explicit + assumed estimates, and an independent longer chain (slack).
  const raw: RawTaskMap = {
    G: entry({ title: 'G' }),
    G1: entry({ title: 'G1', parent: 'G', estimate: 'l' }), // 5
    G2: entry({ title: 'G2', parent: 'G', estimate: 's' }), // 2
    mid: entry({ title: 'Mid', depends: ['G'], estimate: 'm' }), // starts at 5
    sink: entry({ title: 'Sink', depends: ['mid', 'G2'] }), // missing estimate → assumed
    lone: entry({ title: 'Lone', estimate: 'xl' }), // 8, independent
  }

  it('is byte-identical across repeated runs of the same input', () => {
    expect(fingerprint(schedule(raw))).toEqual(fingerprint(schedule(raw)))
  })

  it('does not depend on the input key insertion order', () => {
    expect(fingerprint(schedule(reversed(raw)))).toEqual(fingerprint(schedule(raw)))
  })
})

describe('determinism — effective-cycle scheduling is stable and terminates', () => {
  // A 3-node effective cycle (A→B→C→A). Cycle members must be flagged, kept
  // non-critical, given finite integer bars, and positioned identically in any order.
  const raw: RawTaskMap = {
    A: entry({ title: 'A', depends: ['C'], estimate: 'm' }),
    B: entry({ title: 'B', depends: ['A'], estimate: 's' }),
    C: entry({ title: 'C', depends: ['B'], estimate: 'l' }),
  }

  it('flags every cycle node the same way each run, in any input order', () => {
    const a = schedule(raw)
    const b = schedule(reversed(raw))
    for (const id of ['A', 'B', 'C']) {
      const e = a.entries.get(id)!
      expect(e.cycle).toBe(true)
      expect(e.critical).toBe(false)
      expect(Number.isInteger(e.start)).toBe(true)
      expect(e.finish).toBe(e.start + e.duration)
    }
    expect(fingerprint(a)).toEqual(fingerprint(b))
  })
})
