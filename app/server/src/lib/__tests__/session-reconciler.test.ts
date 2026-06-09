import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'

// detectIdleTransitions calls emitSessionIdle → appendEvent + dispatch; mock both
// so the behavioral tests can assert whether a session_idle was emitted.
const { appendEvent } = vi.hoisted(() => ({ appendEvent: vi.fn() }))
const { dispatch, emitRefresh } = vi.hoisted(() => ({ dispatch: vi.fn(), emitRefresh: vi.fn() }))
vi.mock('../eventsLog', () => ({ appendEvent }))
vi.mock('../notify', () => ({ dispatch, emitRefresh }))

import { detectIdleTransitions, __resetReconcilerStateForTest } from '../session-reconciler'
import type { AgentSession } from '../agent'
import type { Project } from '../projects'

/**
 * Tests for the session reconciler's delegation to the yaco agent CLI.
 *
 * After W2, the reconciler delegates all liveness checks, GC, and metadata
 * backfill to `yaco agent status --json --all`. It no longer reimplements
 * tmux liveness checks or sessionId backfill.
 */

describe('session-reconciler behavior', () => {
  const source = readFileSync(
    join(__dirname, '..', 'session-reconciler.ts'),
    'utf-8',
  )

  it('does not contain checkStaleStates (delegated to yaco agent CLI)', () => {
    expect(source).not.toMatch(/checkStaleStates/)
  })

  it('does not contain isTmuxAlive (delegated to yaco agent CLI)', () => {
    expect(source).not.toMatch(/isTmuxAlive/)
  })

  it('does not contain backfillSessionIds (delegated to yaco agent CLI)', () => {
    expect(source).not.toMatch(/backfillSessionIds/)
  })

  it('does not directly delete state files', () => {
    expect(source).not.toMatch(/unlinkSync/)
  })

  it('does not write stopped status', () => {
    expect(source).not.toMatch(/status.*['"]stopped['"]/)
    expect(source).not.toMatch(/['"]stopped['"].*status/)
  })

  it('delegates reconciliation to fetchAllSessionsFromCli', () => {
    expect(source).toMatch(/fetchAllSessionsFromCli/)
  })

  it('preserves detectIdleTransitions as workflow domain logic', () => {
    expect(source).toMatch(/detectIdleTransitions/)
  })

  it('does not skip Claude sessions in idle detection', () => {
    expect(source).not.toMatch(/provider.*===.*['"]claude['"].*continue/)
  })
})

describe('detectIdleTransitions — blocked is active, never idle', () => {
  const project = { name: 'proj', path: '/tmp/proj' } as Project

  function session(status: AgentSession['status']): AgentSession {
    return {
      name: 'sess', provider: 'claude', status, project: 'proj',
      sessionPath: '/tmp/proj', sessionId: 'sid', pid: 1,
    }
  }

  const T0 = new Date('2026-06-08T00:00:00.000Z')
  const T20 = new Date('2026-06-08T00:00:20.000Z') // 20s > MIN_PROCESSING_MS (15s)

  beforeEach(() => {
    __resetReconcilerStateForTest()
    appendEvent.mockReset()
    dispatch.mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('processing→idle→idle emits session_idle (control proving the harness can fire)', async () => {
    await detectIdleTransitions([session('processing')], project)
    vi.setSystemTime(T20)
    await detectIdleTransitions([session('idle')], project) // streak 1
    await detectIdleTransitions([session('idle')], project) // streak 2 → emit
    expect(appendEvent).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('processing→blocked emits no session_idle even after a second blocked pass', async () => {
    await detectIdleTransitions([session('processing')], project)
    vi.setSystemTime(T20)
    await detectIdleTransitions([session('blocked')], project)
    await detectIdleTransitions([session('blocked')], project)
    expect(appendEvent).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a blocked pass resets an in-progress idle streak', async () => {
    await detectIdleTransitions([session('processing')], project)
    vi.setSystemTime(T20)
    await detectIdleTransitions([session('idle')], project)    // streak 1
    await detectIdleTransitions([session('blocked')], project) // active → streak reset to 0
    await detectIdleTransitions([session('idle')], project)
    await detectIdleTransitions([session('idle')], project)
    // Without the reset, the pre-block idle streak would have reached 2 and fired.
    expect(appendEvent).not.toHaveBeenCalled()
  })
})

describe('agent.ts AgentSessionState type', () => {
  it('does not include stopped', () => {
    const source = readFileSync(
      join(__dirname, '..', 'agent.ts'),
      'utf-8',
    )
    const interfaceMatch = source.match(/interface AgentSessionState\s*\{[\s\S]*?\}/)
    expect(interfaceMatch).not.toBeNull()
    expect(interfaceMatch![0]).not.toContain("'stopped'")
  })
})
