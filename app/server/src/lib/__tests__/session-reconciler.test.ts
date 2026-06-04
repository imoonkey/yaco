import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'

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

describe('agent.ts MultmuxStateFile type', () => {
  it('does not include stopped', () => {
    const source = readFileSync(
      join(__dirname, '..', 'agent.ts'),
      'utf-8',
    )
    const interfaceMatch = source.match(/interface MultmuxStateFile\s*\{[\s\S]*?\}/)
    expect(interfaceMatch).not.toBeNull()
    expect(interfaceMatch![0]).not.toContain("'stopped'")
  })
})
