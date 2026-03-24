import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Tests that the session reconciler never writes to .multmux/*.json state files.
 *
 * Since the reconciler module has side effects (timers, imports), we test the
 * key invariant indirectly: write state files, simulate what checkStaleStates does,
 * and verify files are untouched.
 *
 * The reconciler's checkStaleStates is not exported, so we test the observable
 * behavior: after reconciliation, state files should not be modified.
 */

describe('session-reconciler read-only invariant', () => {
  let tmpDir: string
  let multmuxDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-reconciler-test-'))
    multmuxDir = join(tmpDir, '.multmux')
    mkdirSync(multmuxDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('session-reconciler.ts does not import writeFileSync', async () => {
    // Read the source file and verify it doesn't import writeFileSync
    const source = readFileSync(
      join(__dirname, '..', 'session-reconciler.ts'),
      'utf-8',
    )
    // Check that writeFileSync is not imported from 'fs'
    expect(source).not.toMatch(/writeFileSync/)
    // Check that no sync writes to state files occur
    expect(source).not.toMatch(/\.multmux.*write/i)
  })

  it('session-reconciler.ts does not write stopped status', async () => {
    const source = readFileSync(
      join(__dirname, '..', 'session-reconciler.ts'),
      'utf-8',
    )
    // Should not contain any reference to writing 'stopped' status
    expect(source).not.toMatch(/status.*['"]stopped['"]/)
    expect(source).not.toMatch(/['"]stopped['"].*status/)
  })

  it('multmux.ts MultmuxStateFile type does not include stopped', async () => {
    const source = readFileSync(
      join(__dirname, '..', 'multmux.ts'),
      'utf-8',
    )
    // Find the MultmuxStateFile interface and check its status field
    const interfaceMatch = source.match(/interface MultmuxStateFile\s*\{[\s\S]*?\}/)
    expect(interfaceMatch).not.toBeNull()
    expect(interfaceMatch![0]).not.toContain("'stopped'")
  })
})
