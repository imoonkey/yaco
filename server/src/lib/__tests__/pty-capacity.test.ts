import { describe, it, expect, beforeEach } from 'vitest'
import {
  PtyCapacityError,
  assertCanSpawn,
  sweep,
  markDegraded,
  getPressureState,
  getActualPtyCount,
  __resetForTests,
  PTY_SOFT_LIMIT,
  PTY_HARD_LIMIT,
  PTY_LOW_WATER,
  PTY_LEAK_SLACK,
} from '../pty-capacity'

describe('pty-capacity', () => {
  beforeEach(() => {
    __resetForTests()
  })

  it('assertCanSpawn passes when healthy', () => {
    expect(() => assertCanSpawn()).not.toThrow()
    expect(getPressureState()).toBe('healthy')
  })

  it('assertCanSpawn throws PtyCapacityError when degraded', () => {
    markDegraded('test')
    expect(() => assertCanSpawn()).toThrow(PtyCapacityError)
    expect(getPressureState()).toBe('degraded')
  })

  it('sweep transitions healthy -> degraded at soft limit', async () => {
    const state = await sweep({
      trackedCount: PTY_SOFT_LIMIT,
      sampler: async () => PTY_SOFT_LIMIT,
    })
    expect(state).toBe('degraded')
    expect(getActualPtyCount()).toBe(PTY_SOFT_LIMIT)
  })

  it('sweep transitions to degraded when actual exceeds tracked + slack', async () => {
    const tracked = 50
    const state = await sweep({
      trackedCount: tracked,
      sampler: async () => tracked + PTY_LEAK_SLACK + 1,
    })
    expect(state).toBe('degraded')
  })

  it('sweep transitions to draining at hard limit and fires onDrain', async () => {
    let drained = false
    const state = await sweep({
      trackedCount: PTY_HARD_LIMIT,
      sampler: async () => PTY_HARD_LIMIT,
      onDrain: () => { drained = true },
    })
    expect(state).toBe('draining')
    expect(drained).toBe(true)
  })

  it('sweep returns to healthy only after two consecutive sub-low-water sweeps', async () => {
    await sweep({ trackedCount: PTY_SOFT_LIMIT, sampler: async () => PTY_SOFT_LIMIT })
    expect(getPressureState()).toBe('degraded')

    await sweep({ trackedCount: PTY_LOW_WATER - 1, sampler: async () => PTY_LOW_WATER - 1 })
    expect(getPressureState()).toBe('degraded') // one clean sweep

    await sweep({ trackedCount: PTY_LOW_WATER - 1, sampler: async () => PTY_LOW_WATER - 1 })
    expect(getPressureState()).toBe('healthy')
  })

  it('sweep resets clean-sweep counter if pressure climbs again', async () => {
    await sweep({ trackedCount: PTY_SOFT_LIMIT, sampler: async () => PTY_SOFT_LIMIT })
    await sweep({ trackedCount: PTY_LOW_WATER - 1, sampler: async () => PTY_LOW_WATER - 1 })
    await sweep({ trackedCount: PTY_LOW_WATER + 10, sampler: async () => PTY_LOW_WATER + 10 })
    await sweep({ trackedCount: PTY_LOW_WATER - 1, sampler: async () => PTY_LOW_WATER - 1 })
    expect(getPressureState()).toBe('degraded') // counter was reset, only one clean
  })

  it('sweep steps down from draining to degraded once pressure eases', async () => {
    await sweep({ trackedCount: PTY_HARD_LIMIT, sampler: async () => PTY_HARD_LIMIT })
    expect(getPressureState()).toBe('draining')

    await sweep({ trackedCount: PTY_LOW_WATER - 1, sampler: async () => PTY_LOW_WATER - 1 })
    expect(getPressureState()).toBe('degraded')
  })

  it('sweep keeps previous state when sampler returns null', async () => {
    await sweep({ trackedCount: PTY_SOFT_LIMIT, sampler: async () => PTY_SOFT_LIMIT })
    expect(getPressureState()).toBe('degraded')

    const state = await sweep({ trackedCount: 0, sampler: async () => null })
    expect(state).toBe('degraded')
  })
})
