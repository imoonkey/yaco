import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'

/**
 * The session reconciler is reduced to the 60s liveness GC + safety-net pass
 * (T4): it delegates GC to `yaco agent list --reconcile` and emits a `sessions`
 * refresh on snapshot drift. Attention EDGE production (idle/blocked/crashed/
 * task) now lives in the change-driven attention-engine, so the reconciler must
 * no longer detect idle transitions or dispatch notifications.
 */

describe('session-reconciler — reduced to GC + safety', () => {
  const source = readFileSync(join(__dirname, '..', 'session-reconciler.ts'), 'utf-8')

  it('does not contain checkStaleStates (delegated to yaco agent CLI)', () => {
    expect(source).not.toMatch(/checkStaleStates/)
  })

  it('does not contain isTmuxAlive (delegated to yaco agent CLI)', () => {
    expect(source).not.toMatch(/isTmuxAlive/)
  })

  it('does not directly delete state files', () => {
    expect(source).not.toMatch(/unlinkSync/)
  })

  it('delegates reconciliation to fetchAllSessionsFromCli', () => {
    expect(source).toMatch(/fetchAllSessionsFromCli/)
  })

  it('still emits the sessions refresh safety net', () => {
    expect(source).toMatch(/emitRefresh\(['"]sessions['"]\)/)
  })

  it('no longer produces attention edges (detectIdleTransitions / emitSessionIdle removed)', () => {
    expect(source).not.toMatch(/detectIdleTransitions/)
    expect(source).not.toMatch(/emitSessionIdle/)
  })

  it('no longer dispatches notifications (engine owns edges)', () => {
    expect(source).not.toMatch(/dispatchNotification/)
    // The notify import must not pull in `dispatch`.
    const notifyImport = source.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/notify['"]/)
    expect(notifyImport).not.toBeNull()
    expect(notifyImport![1]).not.toMatch(/\bdispatch\b/)
  })
})

describe('agent.ts AgentSessionState type', () => {
  it('does not include stopped', () => {
    const source = readFileSync(join(__dirname, '..', 'agent.ts'), 'utf-8')
    const interfaceMatch = source.match(/interface AgentSessionState\s*\{[\s\S]*?\}/)
    expect(interfaceMatch).not.toBeNull()
    expect(interfaceMatch![0]).not.toContain("'stopped'")
  })
})
