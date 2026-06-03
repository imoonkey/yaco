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
    const state = await sweep({ sampler: async () => PTY_SOFT_LIMIT })
    expect(state).toBe('degraded')
    expect(getActualPtyCount()).toBe(PTY_SOFT_LIMIT)
  })

  it('sweep stays healthy when actual is far from soft limit even with no tracked count', async () => {
    // Regression: leakGap check used to false-trip at low absolute load
    const state = await sweep({ sampler: async () => 100 })
    expect(state).toBe('healthy')
  })

  it('sweep transitions to draining at hard limit and fires onDrain', async () => {
    let drained = false
    const state = await sweep({
      sampler: async () => PTY_HARD_LIMIT,
      onDrain: () => { drained = true },
    })
    expect(state).toBe('draining')
    expect(drained).toBe(true)
  })

  it('sweep returns to healthy only after two consecutive sub-low-water sweeps', async () => {
    await sweep({ sampler: async () => PTY_SOFT_LIMIT })
    expect(getPressureState()).toBe('degraded')

    await sweep({ sampler: async () => PTY_LOW_WATER - 1 })
    expect(getPressureState()).toBe('degraded') // one clean sweep

    await sweep({ sampler: async () => PTY_LOW_WATER - 1 })
    expect(getPressureState()).toBe('healthy')
  })

  it('sweep resets clean-sweep counter if pressure climbs again', async () => {
    await sweep({ sampler: async () => PTY_SOFT_LIMIT })
    await sweep({ sampler: async () => PTY_LOW_WATER - 1 })
    await sweep({ sampler: async () => PTY_LOW_WATER + 10 })
    await sweep({ sampler: async () => PTY_LOW_WATER - 1 })
    expect(getPressureState()).toBe('degraded') // counter was reset, only one clean
  })

  it('sweep steps down from draining to degraded once pressure eases', async () => {
    await sweep({ sampler: async () => PTY_HARD_LIMIT })
    expect(getPressureState()).toBe('draining')

    await sweep({ sampler: async () => PTY_LOW_WATER - 1 })
    expect(getPressureState()).toBe('degraded')
  })

  it('sweep keeps previous state when sampler returns null', async () => {
    await sweep({ sampler: async () => PTY_SOFT_LIMIT })
    expect(getPressureState()).toBe('degraded')

    const state = await sweep({ sampler: async () => null })
    expect(state).toBe('degraded')
  })
})
