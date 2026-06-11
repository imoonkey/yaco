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

  describe('colocatedRepos policy', () => {
    it('"off" detects nothing', async () => {
      await makeChildRepo(host, 'plan')
      await writeFile(join(host, 'yaco.toml'), '[colocated]\nrepos = "off"\n')
      expect(await getColocatedRepos(host)).toEqual([])
    })

    it('allow-list narrows to named children, re-validated by the signal', async () => {
      await makeChildRepo(host, 'plan')
      await makeChildRepo(host, 'notes')
      await writeFile(join(host, 'yaco.toml'), '[colocated]\nrepos = "plan"\n')
      expect(await getColocatedRepos(host)).toEqual(['plan'])
    })

    it('allow-list entry that fails the signal is skipped (no double-listing)', async () => {
      await makeChildRepo(host, 'plan')
      // "ghost" does not exist; "docs" exists but is not a repo.
      await mkdir(join(host, 'docs'), { recursive: true })
      await writeFile(join(host, 'yaco.toml'), '[colocated]\nrepos = "plan, ghost, docs"\n')
      expect(await getColocatedRepos(host)).toEqual(['plan'])
    })

    it('drops allow-list entries with a path separator', async () => {
      await makeChildRepo(host, 'plan')
      await writeFile(join(host, 'yaco.toml'), '[colocated]\nrepos = "plan/sub, plan"\n')
      expect(await getColocatedRepos(host)).toEqual(['plan'])
    })

    it('drops allow-list entries equal to ".." or "."', async () => {
      await makeChildRepo(host, 'plan')
      await writeFile(join(host, 'yaco.toml'), '[colocated]\nrepos = ".., ., plan"\n')
      expect(await getColocatedRepos(host)).toEqual(['plan'])
    })

    it('malformed yaco.toml degrades to "auto"', async () => {
      await makeChildRepo(host, 'plan')
      await writeFile(join(host, 'yaco.toml'), 'this is not = valid = toml [[[\n')
      expect(await getColocatedRepos(host)).toEqual(['plan'])
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
