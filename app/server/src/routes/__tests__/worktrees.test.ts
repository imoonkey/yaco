import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { realpathSync } from 'fs'
import { execFileSync } from 'child_process'
import { basename, join } from 'path'
import { tmpdir } from 'os'

// Mock loadProjects to point a named project at our temp repo.
let testProjectPath: string
vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([{ name: 'test-project', path: testProjectPath }]),
}))

const { worktreeRoutes } = await import('../worktrees')

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd })
}
// Init on `main` so worktreeStatus's `main...HEAD` ahead/behind is deterministic.
function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  git(['config', 'user.email', 'test@test'], dir)
  git(['config', 'user.name', 'test'], dir)
}
// Identity check that is robust to a symlinked $TMPDIR (macOS /var -> /private/var).
function sameRealpath(a: string, b: string): boolean {
  return realpathSync(a) === realpathSync(b)
}

interface WorktreeInfo {
  id: string
  name: string
  branch: string
  head: string
  isPrimary: boolean
  dirty: boolean
  ahead: number
  behind: number
}

async function fetchWorktrees(): Promise<WorktreeInfo[]> {
  const res = await worktreeRoutes.request('/test-project')
  expect(res.status).toBe(200)
  return (await res.json()).worktrees
}

let externalParent: string

describe('GET /:project — worktrees', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'worktrees-route-test-'))
    externalParent = await mkdtemp(join(tmpdir(), 'worktrees-route-ext-'))
    gitInit(testProjectPath)
    // Mirror the real repo: .worktrees/ is gitignored, so internal worktrees
    // don't show up as untracked noise in the primary's `git status`.
    await writeFile(join(testProjectPath, '.gitignore'), '.worktrees/\n')
    await writeFile(join(testProjectPath, 'base.md'), 'base\n')
    git(['add', '-A'], testProjectPath)
    git(['commit', '-qm', 'init'], testProjectPath)
  })

  afterEach(async () => {
    await rm(testProjectPath, { recursive: true, force: true })
    await rm(externalParent, { recursive: true, force: true })
  })

  it('returns 404 for an unknown project', async () => {
    const res = await worktreeRoutes.request('/nope')
    expect(res.status).toBe(404)
  })

  it('lists the primary checkout alone for a fresh repo', async () => {
    const wts = await fetchWorktrees()

    expect(wts).toHaveLength(1)
    expect(wts[0].isPrimary).toBe(true)
    expect(wts[0].name).toBe(`${basename(testProjectPath)} (primary)`)
    expect(sameRealpath(wts[0].id, testProjectPath)).toBe(true)
    expect(wts[0].head).toMatch(/^[0-9a-f]{7}$/)
    expect(wts[0].branch).toBe('main')
    expect(wts[0].ahead).toBe(0)
    expect(wts[0].behind).toBe(0)
  })

  it('lists primary + internal + external worktrees with status', async () => {
    // Linked worktree under .worktrees/
    git(['worktree', 'add', '-q', '-b', 'task/feat', join(testProjectPath, '.worktrees', 'feat')], testProjectPath)
    // Linked worktree OUTSIDE .worktrees/ (path identity must still list it)
    const extPath = join(externalParent, 'ext-wt')
    git(['worktree', 'add', '-q', '-b', 'ext', extPath], testProjectPath)
    // Put `ext` one commit ahead of main, then leave an untracked file (dirty).
    await writeFile(join(extPath, 'work.md'), 'work\n')
    git(['add', '-A'], extPath)
    git(['commit', '-qm', 'ext work'], extPath)
    await writeFile(join(extPath, 'dirty.md'), 'x\n')

    const wts = await fetchWorktrees()
    expect(wts).toHaveLength(3)

    const primary = wts.find(w => w.isPrimary)!
    expect(primary).toBeDefined()
    expect(sameRealpath(primary.id, testProjectPath)).toBe(true)
    expect(primary.dirty).toBe(false)

    const feat = wts.find(w => w.branch === 'task/feat')!
    expect(feat).toBeDefined()
    expect(feat.isPrimary).toBe(false)
    expect(feat.name).toBe('feat')
    expect(feat.dirty).toBe(false)
    expect(feat.ahead).toBe(0)
    expect(feat.behind).toBe(0)

    const ext = wts.find(w => w.branch === 'ext')!
    expect(ext).toBeDefined()
    expect(ext.isPrimary).toBe(false)
    expect(ext.name).toBe('ext-wt')                  // basename, not a .worktrees slug
    expect(ext.id.includes('/.worktrees/')).toBe(false) // genuinely outside .worktrees
    expect(sameRealpath(ext.id, extPath)).toBe(true)    // exact path identity through the route
    expect(ext.dirty).toBe(true)
    expect(ext.ahead).toBe(1)                           // one commit ahead of main, via the route
    expect(ext.behind).toBe(0)
  })
})
