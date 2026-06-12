// Characterization: the per-session miss-count reconcile that closes a terminal
// pane when its bound session disappears (design: §C / §3.7).
//
// stepSessionMisses is the pure step the provider runs each sessions poll: a
// bound session present in the live set resets; absent increments; reaching 2
// consecutive misses marks the session "dead" so the provider closes the
// terminal pane(s) bound to it. A single transient miss (a race between the
// agent state-file write and the API read) is tolerated. A restored binding is
// pre-seeded at miss-count 1 by the provider, so a session that died between
// reloads drops on the first poll confirming it absent (§3.9).
import { describe, it, expect } from 'vitest'
import { stepSessionMisses } from '../useWorkspaceSessions'

const live = (...names: string[]) => new Set(names)
const bound = (...names: string[]) => new Set(names)

describe('stepSessionMisses (2-poll miss count)', () => {
  it('does not mark dead on the first miss (transient miss tolerated)', () => {
    const { next, dead } = stepSessionMisses(new Map(), bound('s1'), live(/* s1 absent */))
    expect(dead).toEqual([])
    expect(next.get('s1')).toBe(1)
  })

  it('marks dead on the second consecutive miss', () => {
    const first = stepSessionMisses(new Map(), bound('s1'), live())
    const second = stepSessionMisses(first.next, bound('s1'), live())
    expect(second.dead).toEqual(['s1'])
    expect(second.next.has('s1')).toBe(false) // cleared once dead
  })

  it('resets the count when the session reappears', () => {
    const first = stepSessionMisses(new Map(), bound('s1'), live()) // miss 1
    const present = stepSessionMisses(first.next, bound('s1'), live('s1')) // present → reset
    expect(present.next.has('s1')).toBe(false)
    const missAgain = stepSessionMisses(present.next, bound('s1'), live()) // counts as first miss
    expect(missAgain.dead).toEqual([])
    expect(missAgain.next.get('s1')).toBe(1)
  })

  it('pre-seeded restored binding (count 1) drops on the first absent poll', () => {
    // The provider seeds a restored binding's session at 1 on mount.
    const seeded = new Map([['s1', 1]])
    const { dead } = stepSessionMisses(seeded, bound('s1'), live(/* s1 absent */))
    expect(dead).toEqual(['s1'])
  })

  it('drops a session from the map once it is no longer bound', () => {
    const seeded = new Map([['s1', 1]])
    const { next, dead } = stepSessionMisses(seeded, bound(/* s1 unbound now */), live())
    expect(dead).toEqual([])
    expect(next.has('s1')).toBe(false)
  })

  it('handles multiple bound sessions independently', () => {
    // s1 absent (first miss), s2 present (reset), s3 absent second time (dead).
    const prev = new Map([['s3', 1]])
    const { next, dead } = stepSessionMisses(prev, bound('s1', 's2', 's3'), live('s2'))
    expect(dead).toEqual(['s3'])
    expect(next.get('s1')).toBe(1)
    expect(next.has('s2')).toBe(false)
    expect(next.has('s3')).toBe(false)
  })
})
