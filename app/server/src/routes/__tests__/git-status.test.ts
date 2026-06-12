import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock loadProjects to point a named project at our temp dir.
let testProjectPath: string
vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([{ name: 'test-project', path: testProjectPath }]),
}))

const { gitRoutes } = await import('../git')
const { clearColocatedReposCache } = await import('../../lib/colocatedRepos')

function gitInit(dir: string) {
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
}
function commitAll(dir: string, msg = 'init') {
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', msg], { cwd: dir })
}

/** In-place colocated repo under the host, kept out of host git via info/exclude. */
async function makeColocatedRepo(name: string): Promise<string> {
  const dir = join(testProjectPath, name)
  await mkdir(dir, { recursive: true })
  gitInit(dir)
  await writeFile(join(dir, 'base.md'), 'base\n')
  commitAll(dir)
  await excludeFromHost(name)
  return dir
}
async function excludeFromHost(name: string) {
  const path = join(testProjectPath, '.git', 'info', 'exclude')
  const existing = existsSync(path) ? await readFile(path, 'utf-8') : ''
  await writeFile(path, `${existing}/${name}/\n`)
}

/** Break a repo's git while keeping `.git` present, so it stays detected as a
 *  colocated repo but its git commands fail. */
async function breakGit(dir: string) {
  await rm(join(dir, '.git'), { recursive: true, force: true })
  await writeFile(join(dir, '.git'), 'gitdir: /nonexistent-gitdir\n')
}

type StatusResponse = { changes: { path: string; status: string }[]; stale: boolean; stats?: { added: number; deleted: number } }
async function fetchStatus(query = ''): Promise<StatusResponse> {
  const res = await gitRoutes.request(`/test-project/status${query}`)
  expect(res.status).toBe(200)
  return res.json()
}

describe('GET /:project/status — colocated repos', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'git-status-test-'))
    gitInit(testProjectPath)
    clearColocatedReposCache()
  })
  afterEach(async () => {
    clearColocatedReposCache()
    await rm(testProjectPath, { recursive: true, force: true })
  })

  it('surfaces colocated changes as <repo>/<file> with correct status letters', async () => {
    const plan = await makeColocatedRepo('plan')
    await writeFile(join(plan, 'base.md'), 'base\nmore\n')      // modified tracked → M
    await writeFile(join(plan, 'untracked.md'), 'u')            // untracked → U
    await writeFile(join(plan, 'staged.md'), 's')
    execFileSync('git', ['add', 'staged.md'], { cwd: plan })    // staged add → A

    const { changes } = await fetchStatus()
    const byPath = Object.fromEntries(changes.map(c => [c.path, c.status]))
    expect(byPath['plan/base.md']).toBe('M')
    expect(byPath['plan/untracked.md']).toBe('U')
    expect(byPath['plan/staged.md']).toBe('A')
  })

  it('leaves a host-only project unchanged', async () => {
    await writeFile(join(testProjectPath, 'host.md'), 'h\n')
    commitAll(testProjectPath)
    await writeFile(join(testProjectPath, 'host.md'), 'h\nmore\n')

    const res = await fetchStatus()
    expect(res.changes).toEqual([{ path: 'host.md', status: 'M' }])
    expect(res.stale).toBe(false)
    expect(res.stats).toBeDefined()
  })

  it('orders host changes first, then colocated repos sorted by prefix', async () => {
    await writeFile(join(testProjectPath, 'host.md'), 'h')
    const aaa = await makeColocatedRepo('aaa')
    const zzz = await makeColocatedRepo('zzz')
    await writeFile(join(aaa, 'a.md'), 'a')
    await writeFile(join(zzz, 'z.md'), 'z')

    const paths = (await fetchStatus()).changes.map(c => c.path)
    expect(paths.indexOf('host.md')).toBeLessThan(paths.indexOf('aaa/a.md'))
    expect(paths.indexOf('aaa/a.md')).toBeLessThan(paths.indexOf('zzz/z.md'))
  })

  it('sums stats across host and colocated repos when all fresh', async () => {
    await writeFile(join(testProjectPath, 'host.md'), 'h\n')
    const plan = await makeColocatedRepo('plan')
    commitAll(testProjectPath) // commits host.md AND records nothing about excluded plan
    await writeFile(join(testProjectPath, 'host.md'), 'h\nadded\n')   // +1 in host
    await writeFile(join(plan, 'base.md'), 'base\nadded\n')           // +1 in plan

    const res = await fetchStatus()
    expect(res.stale).toBe(false)
    expect(res.stats).toEqual({ added: 2, deleted: 0 })
  })

  it('degrades when a colocated repo git fails with no snapshot (host fresh, repo absent, stale)', async () => {
    await writeFile(join(testProjectPath, 'host.md'), 'h')
    // A dir with a broken .git FILE: detected as colocated, but git status fails.
    const broken = join(testProjectPath, 'plan')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, '.git'), 'gitdir: /nonexistent-gitdir\n')
    await writeFile(join(broken, 'foo.md'), 'x')
    await excludeFromHost('plan')

    const res = await fetchStatus()
    expect(res.changes.some(c => c.path === 'host.md')).toBe(true)
    expect(res.changes.some(c => c.path.startsWith('plan/'))).toBe(false)
    expect(res.stale).toBe(true)
    expect(res.stats).toBeUndefined()
  })

  it('falls back to a stale colocated repo snapshot after it starts failing', async () => {
    const plan = await makeColocatedRepo('plan')
    await writeFile(join(plan, 'note.md'), 'n') // untracked → U

    // Poll 1: fresh — snapshot stored for plan.
    const first = await fetchStatus()
    expect(first.changes.some(c => c.path === 'plan/note.md')).toBe(true)
    expect(first.stale).toBe(false)

    // Break plan's git while keeping .git present (still detected; cache still warm).
    await breakGit(plan)

    // Poll 2: plan git fails → its last snapshot is returned, response is stale.
    const second = await fetchStatus()
    expect(second.changes.some(c => c.path === 'plan/note.md')).toBe(true)
    expect(second.stale).toBe(true)
    expect(second.stats).toBeUndefined()
  })

  it('falls back to the host last snapshot when the host git starts failing (state-table row 4)', async () => {
    await writeFile(join(testProjectPath, 'host.md'), 'h\n')
    commitAll(testProjectPath)
    await writeFile(join(testProjectPath, 'host.md'), 'h\nmore\n') // host change → M
    const plan = await makeColocatedRepo('plan')
    await writeFile(join(plan, 'note.md'), 'n')                    // colocated untracked → U

    // Poll 1: both fresh — snapshots stored for host and plan.
    const first = await fetchStatus()
    expect(first.changes.some(c => c.path === 'host.md')).toBe(true)
    expect(first.stale).toBe(false)

    // Host git starts failing; plan stays healthy.
    await breakGit(testProjectPath)

    // Poll 2: host returns its own last snapshot (stale), plan still fresh.
    const second = await fetchStatus()
    expect(second.changes.some(c => c.path === 'host.md')).toBe(true)
    expect(second.changes.some(c => c.path === 'plan/note.md')).toBe(true)
    expect(second.stale).toBe(true)
    expect(second.stats).toBeUndefined()
  })

  it('isolates a worktree: it shows its own changes, not the primary colocated repo', async () => {
    const plan = await makeColocatedRepo('plan')
    await writeFile(join(plan, 'note.md'), 'n')

    // A worktree checkout (no plan inside it — plan is info/excluded from the branch).
    const wt = join(testProjectPath, '.worktrees', 'wt')
    await mkdir(wt, { recursive: true })
    gitInit(wt)
    execFileSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: wt })
    await writeFile(join(wt, 'wt-only.md'), 'w')

    const primary = await fetchStatus()
    expect(primary.changes.some(c => c.path === 'plan/note.md')).toBe(true)

    const worktree = await fetchStatus('?worktree=wt')
    expect(worktree.changes.some(c => c.path === 'wt-only.md')).toBe(true)
    expect(worktree.changes.some(c => c.path.startsWith('plan/'))).toBe(false)
  })
})
