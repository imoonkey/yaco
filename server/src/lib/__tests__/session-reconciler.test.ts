import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Tests for the session reconciler's behavior with .multmux/*.json state files.
 *
 * The reconciler detects dead tmux sessions and deletes their stale state files
 * (defense-in-depth for when multmux wrapper.sh EXIT trap fails).
 */

describe('session-reconciler behavior', () => {
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

  it('session-reconciler.ts imports unlinkSync for stale file cleanup', async () => {
    const source = readFileSync(
      join(__dirname, '..', 'session-reconciler.ts'),
      'utf-8',
    )
    expect(source).toMatch(/unlinkSync/)
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

  it('session-reconciler.ts does not skip Claude sessions in idle detection', async () => {
    const source = readFileSync(
      join(__dirname, '..', 'session-reconciler.ts'),
      'utf-8',
    )
    // Idle detection should be uniform across all providers
    expect(source).not.toMatch(/provider.*===.*['"]claude['"].*continue/)
  })
})
