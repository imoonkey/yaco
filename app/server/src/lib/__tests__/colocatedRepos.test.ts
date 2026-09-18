import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'fs/promises'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { getColocatedRepos, clearColocatedReposCache } from '../colocatedRepos'

/** Init a git repo at dir (quiet, with a usable identity). */
function gitInit(dir: string) {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
}

/** Create a depth-1 child directory that is its own git repo. */
async function makeChildRepo(host: string, name: string) {
  const dir = join(host, name)
  await mkdir(dir, { recursive: true })
  gitInit(dir)
  await writeFile(join(dir, 'file.md'), '# hi\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

describe('getColocatedRepos', () => {
  let host: string

  beforeEach(async () => {
    host = await mkdtemp(join(tmpdir(), 'colocated-host-'))
    gitInit(host)
    clearColocatedReposCache()
  })
  afterEach(async () => {
    clearColocatedReposCache()
    await rm(host, { recursive: true, force: true })
  })

  it('detects a depth-1 child repo (untracked, not gitignored)', async () => {
    await makeChildRepo(host, 'plan')
    expect(await getColocatedRepos(host)).toEqual(['plan'])
  })

  it('detects when .git is a worktree-style file', async () => {
    const dir = join(host, 'wt')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.git'), 'gitdir: /somewhere/else\n')
    expect(await getColocatedRepos(host)).toEqual(['wt'])
  })

  it('does NOT detect a plain directory without .git', async () => {
    await mkdir(join(host, 'docs'), { recursive: true })
    await writeFile(join(host, 'docs', 'x.md'), 'x')
    expect(await getColocatedRepos(host)).toEqual([])
  })

  it('does NOT detect a child tracked in the host index (gitlink / submodule)', async () => {
    await makeChildRepo(host, 'sub')
    // Embed it as a gitlink in the host index (the submodule shape).
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'add', 'sub'], { cwd: host })
    expect(await getColocatedRepos(host)).toEqual([])
  })

  it('does NOT detect a child matched by the root .gitignore (node_modules)', async () => {
    await writeFile(join(host, '.gitignore'), 'node_modules/\n')
    const dir = join(host, 'node_modules')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.git'), 'gitdir: x\n')
    expect(await getColocatedRepos(host)).toEqual([])
  })

  it('detects two sibling repos and keeps them distinct (plan vs plan2)', async () => {
    await makeChildRepo(host, 'plan')
    await makeChildRepo(host, 'plan2')
    expect(await getColocatedRepos(host)).toEqual(['plan', 'plan2'])
  })

  it('detects a separate repo symlinked in', async () => {
    const external = await mkdtemp(join(tmpdir(), 'colocated-ext-'))
    try {
      gitInit(external)
      await writeFile(join(external, 'note.md'), 'n')
      await symlink(external, join(host, 'plan'))
      expect(await getColocatedRepos(host)).toEqual(['plan'])
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('does NOT detect a self/ancestor symlink (loop -> .) as a colocated repo', async () => {
    // loop -> . resolves to the host (whose .git exists); must not alias itself.
    await symlink('.', join(host, 'loop'))
    expect(await getColocatedRepos(host)).toEqual([])
  })

  describe('.yaco/plan', () => {
    it('detects a private plan (its own repo) at depth 2, sorted with depth-1 repos', async () => {
      await makeChildRepo(host, '.yaco/plan')
      await makeChildRepo(host, 'vendor-repo')
      expect(await getColocatedRepos(host)).toEqual(['.yaco/plan', 'vendor-repo'])
    })

    it('does NOT detect a .yaco/plan symlink back into the host (no self-alias)', async () => {
      await mkdir(join(host, '.yaco'), { recursive: true })
      await symlink('..', join(host, '.yaco', 'plan'))
      expect(await getColocatedRepos(host)).toEqual([])
    })

    it('does NOT detect a plan without .git (tracked or plain dir)', async () => {
      await mkdir(join(host, '.yaco', 'plan', 'tasks'), { recursive: true })
      await writeFile(join(host, '.yaco', 'plan', 'tasks', 'tasks.json'), '{}\n')
      expect(await getColocatedRepos(host)).toEqual([])
    })

    it('does NOT detect a plan whose files the host index still tracks', async () => {
      await mkdir(join(host, '.yaco', 'plan'), { recursive: true })
      await writeFile(join(host, '.yaco', 'plan', 'x.md'), 'x')
      execFileSync('git', ['add', '-A'], { cwd: host })
      gitInit(join(host, '.yaco', 'plan'))
      expect(await getColocatedRepos(host)).toEqual([])
    })

    it('does NOT detect a plan matched by the root .gitignore', async () => {
      await writeFile(join(host, '.gitignore'), '.yaco/\n')
      await makeChildRepo(host, '.yaco/plan')
      expect(await getColocatedRepos(host)).toEqual([])
    })
  })

  describe('caching', () => {
    it('caches within the TTL and refreshes after clear', async () => {
      await makeChildRepo(host, 'plan')
      expect(await getColocatedRepos(host)).toEqual(['plan'])

      // A second repo added within the TTL is not seen until the cache clears.
      await makeChildRepo(host, 'notes')
      expect(await getColocatedRepos(host)).toEqual(['plan'])

      clearColocatedReposCache()
      expect(await getColocatedRepos(host)).toEqual(['notes', 'plan'])
    })
  })
})
