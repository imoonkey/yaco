import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink, unlink } from 'fs/promises'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

// Real git + real fs (no child_process mock) — proves /diff and /baseline route
// a colocated-repo file to its own repo, and that /diff (deny policy) never runs
// git outside the project for an external symlink.
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
async function excludeFromHost(name: string) {
  const path = join(testProjectPath, '.git', 'info', 'exclude')
  await writeFile(path, `/${name}/\n`, { flag: 'a' })
}
async function makeColocatedRepo(name: string): Promise<string> {
  const dir = join(testProjectPath, name)
  await mkdir(dir, { recursive: true })
  gitInit(dir)
  await writeFile(join(dir, 'base.md'), 'base\n')
  commitAll(dir)
  await excludeFromHost(name)
  return dir
}

async function diff(path: string): Promise<string> {
  const res = await gitRoutes.request(`/test-project/diff?path=${encodeURIComponent(path)}`)
  expect(res.status).toBe(200)
  return (await res.json() as { diff: string }).diff
}
async function baseline(path: string): Promise<{ content: string; exists: boolean }> {
  const res = await gitRoutes.request(`/test-project/baseline?path=${encodeURIComponent(path)}`)
  expect(res.status).toBe(200)
  return res.json()
}

describe('GET /:project/diff + /baseline — colocated repos', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'git-diff-colo-'))
    gitInit(testProjectPath)
    clearColocatedReposCache()
  })
  afterEach(async () => {
    clearColocatedReposCache()
    await rm(testProjectPath, { recursive: true, force: true })
  })

  it('diffs a modified colocated file against its own repo HEAD', async () => {
    const plan = await makeColocatedRepo('plan')
    await writeFile(join(plan, 'base.md'), 'base\nadded\n')
    const out = await diff('plan/base.md')
    expect(out).toContain('+added')
  })

  it('diffs a staged colocated file', async () => {
    const plan = await makeColocatedRepo('plan')
    await writeFile(join(plan, 'staged.md'), 'staged content\n')
    execFileSync('git', ['add', 'staged.md'], { cwd: plan })
    const out = await diff('plan/staged.md')
    expect(out).toContain('+staged content')
  })

  it('shows an untracked colocated file as all-additions', async () => {
    const plan = await makeColocatedRepo('plan')
    await writeFile(join(plan, 'fresh.md'), 'brand new\n')
    const out = await diff('plan/fresh.md')
    expect(out).toContain('+brand new')
  })

  it('diffs a DELETED colocated file (deletion resolves to the repo HEAD)', async () => {
    const plan = await makeColocatedRepo('plan')
    await writeFile(join(plan, 'gone.md'), 'will be removed\n')
    commitAll(plan, 'add gone')
    await unlink(join(plan, 'gone.md'))
    const out = await diff('plan/gone.md')
    expect(out).toContain('-will be removed')
  })

  it('does not resolve plan2/x to the plan repo (path boundary)', async () => {
    await makeColocatedRepo('plan')
    const plan2 = await makeColocatedRepo('plan2')
    await writeFile(join(plan2, 'only-in-plan2.md'), 'p2\n')
    const out = await diff('plan2/only-in-plan2.md')
    expect(out).toContain('+p2')
  })

  it('leaves a host file host-rooted', async () => {
    await writeFile(join(testProjectPath, 'host.md'), 'h\n')
    commitAll(testProjectPath)
    await writeFile(join(testProjectPath, 'host.md'), 'h\nchanged\n')
    const out = await diff('host.md')
    expect(out).toContain('+changed')
  })

  it('deny: an external symlink yields an empty diff (no external content leaks)', async () => {
    const external = await mkdtemp(join(tmpdir(), 'git-diff-ext-'))
    try {
      gitInit(external)
      await writeFile(join(external, 'file.txt'), 'v1\n')
      commitAll(external)
      await writeFile(join(external, 'file.txt'), 'v2\n')
      await symlink(join(external, 'file.txt'), join(testProjectPath, 'extlink.txt'))

      const out = await diff('extlink.txt')
      // Path resolves outside the project tree → the no-index fallback is skipped;
      // neither the external repo's HEAD ("-v1") nor its working copy ("v2") leaks.
      expect(out).toBe('')
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('baseline of a deleted colocated file resolves to its repo HEAD blob', async () => {
    const plan = await makeColocatedRepo('plan')
    await writeFile(join(plan, 'foo.md'), 'committed\n')
    commitAll(plan, 'add foo')
    await unlink(join(plan, 'foo.md')) // deleted on disk — host has no idea about it
    const res = await baseline('plan/foo.md')
    expect(res).toEqual({ content: 'committed\n', exists: true })
  })

  it('deny: a symlinked directory pointing outside never leaks file content (no-index skipped)', async () => {
    const external = await mkdtemp(join(tmpdir(), 'git-diff-extdir-'))
    try {
      await writeFile(join(external, 'secret.txt'), 'TOPSECRET\n')
      await symlink(external, join(testProjectPath, 'extdir')) // top-level symlinked dir
      const out = await diff('extdir/secret.txt')
      expect(out).not.toContain('TOPSECRET')
      expect(out).toBe('')
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('leaves the base/compare ref-diff branch host-rooted (colocated path not routed)', async () => {
    // Host has two commits so HEAD~1 exists at the host root.
    await writeFile(join(testProjectPath, 'host.md'), 'one\n')
    commitAll(testProjectPath, 'c1')
    await writeFile(join(testProjectPath, 'host.md'), 'two\n')
    commitAll(testProjectPath, 'c2')

    // A colocated repo with its own history for base.md.
    const plan = await makeColocatedRepo('plan')
    await writeFile(join(plan, 'base.md'), 'base\nchanged\n')
    commitAll(plan, 'change base')

    // Ref-compare runs at the host root; the host does not track plan/base.md,
    // so the diff is empty. (It would be non-empty if it routed into the plan repo.)
    const res = await gitRoutes.request(
      `/test-project/diff?path=${encodeURIComponent('plan/base.md')}&base=HEAD~1&compare=HEAD`,
    )
    expect(res.status).toBe(200)
    expect((await res.json() as { diff: string }).diff).toBe('')
  })
})
