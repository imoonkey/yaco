import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { readYacoPaths } from '../src/lib/yacoPaths'

const DEFAULTS = {
  tasks: 'projects/tasks.json',
  active: 'projects/active',
  archive: 'projects/archive',
  worktrees: '.worktrees',
}

let repoRoot: string

describe('readYacoPaths', () => {
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'yaco-paths-test-'))
  })
  afterAll(async () => {
    // each beforeEach makes a fresh dir; cleanup of last one is fine to leak in tmpdir
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true })
  })

  it('returns defaults when yaco.toml is missing', () => {
    expect(readYacoPaths(repoRoot)).toEqual(DEFAULTS)
  })

  it('applies [paths] overrides from yaco.toml', async () => {
    await writeFile(
      join(repoRoot, 'yaco.toml'),
      [
        '[paths]',
        'tasks = "plan/tasks.json"',
        'active = "plan/active"',
        'archive = "plan/archive"',
        'worktrees = "wt"',
      ].join('\n'),
      'utf-8',
    )
    expect(readYacoPaths(repoRoot)).toEqual({
      tasks: 'plan/tasks.json',
      active: 'plan/active',
      archive: 'plan/archive',
      worktrees: 'wt',
    })
  })

  it('partial overrides merge with defaults', async () => {
    await writeFile(
      join(repoRoot, 'yaco.toml'),
      '[paths]\ntasks = "custom/tasks.json"\n',
      'utf-8',
    )
    expect(readYacoPaths(repoRoot)).toEqual({
      ...DEFAULTS,
      tasks: 'custom/tasks.json',
    })
  })

  it('rejects absolute paths', async () => {
    await writeFile(
      join(repoRoot, 'yaco.toml'),
      '[paths]\ntasks = "/etc/passwd"\n',
      'utf-8',
    )
    expect(() => readYacoPaths(repoRoot)).toThrow(/repo-relative/)
  })

  it('rejects paths with .. traversal segments', async () => {
    await writeFile(
      join(repoRoot, 'yaco.toml'),
      '[paths]\ntasks = "../../etc/passwd"\n',
      'utf-8',
    )
    expect(() => readYacoPaths(repoRoot)).toThrow(/\.\./)
  })

  it('ignores [project] section even if present', async () => {
    await writeFile(
      join(repoRoot, 'yaco.toml'),
      [
        '[project]',
        'name = "should-be-ignored"',
        'id = "also-ignored"',
        '',
        '[paths]',
        'tasks = "p/tasks.json"',
      ].join('\n'),
      'utf-8',
    )
    const result = readYacoPaths(repoRoot)
    expect(result).toEqual({ ...DEFAULTS, tasks: 'p/tasks.json' })
    expect(JSON.stringify(result)).not.toContain('should-be-ignored')
    expect(JSON.stringify(result)).not.toContain('also-ignored')
    expect(Object.keys(result).sort()).toEqual(['active', 'archive', 'tasks', 'worktrees'])
  })
})
