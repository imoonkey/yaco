import { describe, it, expect } from 'vitest'
import { buildSessionLineage, groupSessionLineage, filterCollapsedRows } from '../sessionLineage'
import type { AgentSession, SessionStatus } from '../../types'

function makeSession(name: string, parentSession?: string, status: SessionStatus = 'idle'): AgentSession {
  return { name, provider: 'claude', status, project: 'test', summary: '', parentSession }
}

/** Flatten rows to `[name, depth]` pairs for compact assertions. */
function flat(sessions: AgentSession[]): Array<[string, number]> {
  return buildSessionLineage(sessions).map(r => [r.session.name, r.depth])
}

describe('buildSessionLineage', () => {
  it('renders a flat list with no lineage as all roots at depth 0', () => {
    const sessions = [makeSession('a'), makeSession('b'), makeSession('c')]
    expect(flat(sessions)).toEqual([['a', 0], ['b', 0], ['c', 0]])
  })

  it('nests a child immediately after its parent, indented one level', () => {
    const sessions = [makeSession('parent'), makeSession('child', 'parent')]
    expect(flat(sessions)).toEqual([['parent', 0], ['child', 1]])
  })

  it('renders descendants depth-first with increasing depth', () => {
    const sessions = [
      makeSession('root'),
      makeSession('child', 'root'),
      makeSession('grandchild', 'child'),
    ]
    expect(flat(sessions)).toEqual([['root', 0], ['child', 1], ['grandchild', 2]])
  })

  it('places a child immediately after its parent even when listed later', () => {
    const sessions = [
      makeSession('parent'),
      makeSession('other'),
      makeSession('child', 'parent'),
    ]
    expect(flat(sessions)).toEqual([['parent', 0], ['child', 1], ['other', 0]])
  })

  it('preserves sibling input order under a shared parent', () => {
    const sessions = [
      makeSession('parent'),
      makeSession('c2', 'parent'),
      makeSession('c1', 'parent'),
    ]
    expect(flat(sessions)).toEqual([['parent', 0], ['c2', 1], ['c1', 1]])
  })

  it('renders a session as a root when its parent is not visible', () => {
    const sessions = [makeSession('orphan', 'missing-parent')]
    expect(flat(sessions)).toEqual([['orphan', 0]])
  })

  it('treats a self-referencing parent as a root', () => {
    const sessions = [makeSession('loop', 'loop')]
    expect(flat(sessions)).toEqual([['loop', 0]])
  })

  it('breaks a two-node cycle without looping and renders every session once', () => {
    const sessions = [makeSession('a', 'b'), makeSession('b', 'a')]
    const rows = flat(sessions)
    expect(rows.map(r => r[0]).sort()).toEqual(['a', 'b'])
    // First node in input order anchors the cycle as a root.
    expect(rows[0]).toEqual(['a', 0])
  })

  it('renders each session exactly once across a forest', () => {
    const sessions = [
      makeSession('r1'),
      makeSession('r1c', 'r1'),
      makeSession('r2'),
      makeSession('r2c', 'r2'),
    ]
    expect(flat(sessions)).toEqual([
      ['r1', 0], ['r1c', 1], ['r2', 0], ['r2c', 1],
    ])
  })

  it('flags hasChildren only on sessions that have a visible child', () => {
    const sessions = [makeSession('parent'), makeSession('child', 'parent')]
    expect(buildSessionLineage(sessions).map(r => [r.session.name, r.hasChildren]))
      .toEqual([['parent', true], ['child', false]])
  })

  it('does not flag hasChildren when the only child is not visible', () => {
    const sessions = [makeSession('parent')]
    expect(buildSessionLineage(sessions).map(r => r.hasChildren)).toEqual([false])
  })
})

describe('filterCollapsedRows', () => {
  const names = (rows: ReturnType<typeof buildSessionLineage>) => rows.map(r => r.session.name)
  const lineage = () => buildSessionLineage([
    makeSession('root'),
    makeSession('child', 'root'),
    makeSession('grandchild', 'child'),
    makeSession('sibling'),
  ])

  it('is a no-op when nothing is collapsed', () => {
    const rows = lineage()
    expect(names(filterCollapsedRows(rows, new Set()))).toEqual(['root', 'child', 'grandchild', 'sibling'])
  })

  it('hides the whole subtree under a collapsed root, keeping the root and siblings', () => {
    const rows = lineage()
    expect(names(filterCollapsedRows(rows, new Set(['root'])))).toEqual(['root', 'sibling'])
  })

  it('hides only descendants below a collapsed middle node', () => {
    const rows = lineage()
    expect(names(filterCollapsedRows(rows, new Set(['child'])))).toEqual(['root', 'child', 'sibling'])
  })
})

describe('groupSessionLineage', () => {
  const noPins = () => false
  const namesAt = (rows: Array<{ session: AgentSession; depth: number }>) =>
    rows.map(r => [r.session.name, r.depth] as [string, number])

  it('promotes an idle parent to active when its child is processing (subtree-max)', () => {
    // Subtree-max bucketing: a processing child pulls the whole subtree into the
    // active bucket, but the parent still anchors it (child stays indented).
    const sessions = [
      makeSession('child', 'parent', 'processing'),
      makeSession('parent', undefined, 'idle'),
    ]
    const { pinned, processing, idle } = groupSessionLineage(sessions, noPins)
    expect(pinned).toEqual([])
    expect(idle).toEqual([])
    expect(namesAt(processing)).toEqual([['parent', 0], ['child', 1]])
  })

  it('promotes an idle parent to active when its child is blocked', () => {
    const sessions = [
      makeSession('child', 'parent', 'blocked'),
      makeSession('parent', undefined, 'idle'),
    ]
    const { processing, idle } = groupSessionLineage(sessions, noPins)
    expect(idle).toEqual([])
    expect(namesAt(processing)).toEqual([['parent', 0], ['child', 1]])
  })

  it('places a standalone blocked root in the active bucket (counts as active)', () => {
    const sessions = [makeSession('b', undefined, 'blocked')]
    const { processing, idle } = groupSessionLineage(sessions, noPins)
    expect(idle).toEqual([])
    expect(namesAt(processing)).toEqual([['b', 0]])
  })

  it('sorts a blocked root above processing roots within the active bucket', () => {
    // Input order is processing-then-blocked; blocked must surface to the top.
    const sessions = [
      makeSession('proc', undefined, 'processing'),
      makeSession('blkd', undefined, 'blocked'),
      makeSession('blkc', 'blkd', 'idle'),
    ]
    const { processing, idle } = groupSessionLineage(sessions, noPins)
    expect(idle).toEqual([])
    expect(namesAt(processing)).toEqual([['blkd', 0], ['blkc', 1], ['proc', 0]])
  })

  it('keeps an idle child indented under its processing parent', () => {
    const sessions = [
      makeSession('parent', undefined, 'processing'),
      makeSession('child', 'parent', 'idle'),
    ]
    const { processing, idle } = groupSessionLineage(sessions, noPins)
    expect(idle).toEqual([])
    expect(namesAt(processing)).toEqual([['parent', 0], ['child', 1]])
  })

  it('places a whole subtree in the pinned bucket by its root, regardless of child status', () => {
    const sessions = [
      makeSession('p', undefined, 'idle'),
      makeSession('pc', 'p', 'processing'),
      makeSession('lone', undefined, 'processing'),
    ]
    const { pinned, processing, idle } = groupSessionLineage(sessions, name => name === 'p')
    expect(namesAt(pinned)).toEqual([['p', 0], ['pc', 1]])
    expect(namesAt(processing)).toEqual([['lone', 0]])
    expect(idle).toEqual([])
  })

  it('groups roots into pinned/active/idle by root order', () => {
    const sessions = [
      makeSession('a', undefined, 'processing'),
      makeSession('b', undefined, 'idle'),
    ]
    const { pinned, processing, idle } = groupSessionLineage(sessions, noPins)
    expect(pinned).toEqual([])
    expect(namesAt(processing)).toEqual([['a', 0]])
    expect(namesAt(idle)).toEqual([['b', 0]])
  })
})
