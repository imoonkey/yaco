import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat, mkdir, writeFile, symlink } from 'fs/promises'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock loadProjects to return a test project pointing to our temp dir
let testProjectPath: string
vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([{ name: 'test-project', path: testProjectPath }]),
}))

// Import the file routes (after mocks are set up)
const { fileRoutes } = await import('../files')
const { clearColocatedReposCache } = await import('../../lib/colocatedRepos')

describe('POST /:project/create-file', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'workflow-test-'))
  })
  afterEach(async () => {
    await rm(testProjectPath, { recursive: true, force: true })
  })

  it('creates a file at the project root', async () => {
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'hello.txt' }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ path: 'hello.txt' })

    // Verify file on disk
    const absPath = join(testProjectPath, 'hello.txt')
    expect(existsSync(absPath)).toBe(true)
    expect(await readFile(absPath, 'utf-8')).toBe('')
  })

  it('creates a file inside a subdirectory (mkdir -p)', async () => {
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'src/components/Button.tsx' }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(testProjectPath, 'src/components/Button.tsx'))).toBe(true)
  })

  it('returns 400 for empty path', async () => {
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for path with ..', async () => {
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../escape.txt' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 409 if file already exists', async () => {
    // Create first
    await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'exists.txt' }),
    })
    // Try again
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'exists.txt' }),
    })
    expect(res.status).toBe(409)
  })

  it('returns 404 for unknown project', async () => {
    const res = await fileRoutes.request('/nonexistent/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test.txt' }),
    })
    expect(res.status).toBe(404)
  })

  it('creates a file when project path has a trailing slash (regression)', async () => {
    // Regression: projects.json sometimes stores paths with trailing /;
    // validateNewPath's startsWith(projectPath + '/') check double-slashed
    // and rejected all writes.
    const baseDir = testProjectPath
    testProjectPath = baseDir + '/'
    const res = await fileRoutes.request('/test-project/create-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'doc/trailing.txt' }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(baseDir, 'doc/trailing.txt'))).toBe(true)
  })
})

describe('POST /:project/create-dir', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'workflow-test-'))
  })
  afterEach(async () => {
    await rm(testProjectPath, { recursive: true, force: true })
  })

  it('creates a directory at the project root', async () => {
    const res = await fileRoutes.request('/test-project/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'new-folder' }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ path: 'new-folder' })

    const absPath = join(testProjectPath, 'new-folder')
    expect(existsSync(absPath)).toBe(true)
    expect((await stat(absPath)).isDirectory()).toBe(true)
  })

  it('creates nested directories', async () => {
    const res = await fileRoutes.request('/test-project/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a/b/c' }),
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(testProjectPath, 'a/b/c'))).toBe(true)
  })

  it('returns 400 for path traversal', async () => {
    const res = await fileRoutes.request('/test-project/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../outside' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 409 if directory already exists', async () => {
    await fileRoutes.request('/test-project/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'exists-dir' }),
    })
    const res = await fileRoutes.request('/test-project/create-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'exists-dir' }),
    })
    expect(res.status).toBe(409)
  })
})

describe('GET /:project/search-index — symlinked directories', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'workflow-test-'))
    execFileSync('git', ['init', '-q'], { cwd: testProjectPath })
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: testProjectPath })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: testProjectPath })
  })
  afterEach(async () => {
    await rm(testProjectPath, { recursive: true, force: true })
  })

  async function fetchIndex(): Promise<{ name: string; path: string; type: string }[]> {
    const res = await fileRoutes.request('/test-project/search-index')
    expect(res.status).toBe(200)
    return res.json()
  }

  it('indexes files inside a top-level directory symlink', async () => {
    // External target dir with a file; symlinked from project root
    const target = await mkdtemp(join(tmpdir(), 'workflow-target-'))
    try {
      await writeFile(join(target, 'inside.txt'), 'hi')
      await symlink(target, join(testProjectPath, 'linked'))

      const entries = await fetchIndex()
      const paths = entries.map(e => e.path)
      expect(paths).toContain('linked/inside.txt')
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })

  it('does not double-count top-level file symlinks (git already lists them)', async () => {
    // Real file outside the project, symlinked in. git ls-files lists the symlink
    // entry itself; the walker must not add it as a separate file.
    const targetDir = await mkdtemp(join(tmpdir(), 'workflow-target-'))
    try {
      const targetFile = join(targetDir, 'data.txt')
      await writeFile(targetFile, 'hi')
      await symlink(targetFile, join(testProjectPath, 'shortcut.txt'))
      execFileSync('git', ['add', '-A'], { cwd: testProjectPath })

      const entries = await fetchIndex()
      const matches = entries.filter(e => e.path === 'shortcut.txt')
      expect(matches).toHaveLength(1)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('terminates on a self-referential symlink (loop -> .)', async () => {
    await symlink('.', join(testProjectPath, 'loop'))
    const entries = await Promise.race([
      fetchIndex(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ])
    // Walker should not recurse into the loop; loop/loop/loop... must not appear
    const looped = entries.filter(e => e.path.startsWith('loop/loop'))
    expect(looped).toHaveLength(0)
  })

  it('terminates on a mutual symlink cycle (a -> b, b -> a)', async () => {
    const targetA = await mkdtemp(join(tmpdir(), 'workflow-cycle-a-'))
    const targetB = await mkdtemp(join(tmpdir(), 'workflow-cycle-b-'))
    try {
      // a contains a symlink "to-b" -> targetB; b contains "to-a" -> targetA
      await symlink(targetB, join(targetA, 'to-b'))
      await symlink(targetA, join(targetB, 'to-a'))
      await writeFile(join(targetA, 'a.txt'), '')
      await writeFile(join(targetB, 'b.txt'), '')
      await symlink(targetA, join(testProjectPath, 'aliased'))

      const entries = await Promise.race([
        fetchIndex(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ])
      const paths = entries.map(e => e.path)
      // Cycle must terminate; we should see one full traversal but not infinite nesting
      expect(paths).toContain('aliased/a.txt')
      expect(paths.some(p => p.includes('to-b/to-a/to-b'))).toBe(false)
    } finally {
      await rm(targetA, { recursive: true, force: true })
      await rm(targetB, { recursive: true, force: true })
    }
  })

  it('indexes both of two top-level symlinks pointing to the same target', async () => {
    // Per-recursion-path ancestor tracking: distinct top-level aliases should both work
    const target = await mkdtemp(join(tmpdir(), 'workflow-shared-'))
    try {
      await writeFile(join(target, 'x.txt'), '')
      await symlink(target, join(testProjectPath, 'one'))
      await symlink(target, join(testProjectPath, 'two'))
      const entries = await fetchIndex()
      const paths = entries.map(e => e.path)
      expect(paths).toContain('one/x.txt')
      expect(paths).toContain('two/x.txt')
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })
})

describe('GET /:project/search-index — colocated repos', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'workflow-test-'))
    execFileSync('git', ['init', '-q'], { cwd: testProjectPath })
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: testProjectPath })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: testProjectPath })
    clearColocatedReposCache()
  })
  afterEach(async () => {
    clearColocatedReposCache()
    await rm(testProjectPath, { recursive: true, force: true })
  })

  async function fetchIndex(): Promise<{ name: string; path: string; type: string }[]> {
    const res = await fileRoutes.request('/test-project/search-index')
    expect(res.status).toBe(200)
    return res.json()
  }

  /** Create an in-place colocated repo under the host, excluded via the host's
   *  info/exclude (the shape `yaco plan init` produces). */
  function makeColocatedRepo(name: string) {
    const dir = join(testProjectPath, name)
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
    // Neutralize any global gitignore so plan/ isn't hidden from the host's
    // ls-files --others query. (Detection itself uses ls-files -z without
    // --others, so global excludes don't affect it; per-test info/exclude keeps
    // plan/ out of the host index.)
    execFileSync('git', ['config', 'core.excludesFile', ''], { cwd: testProjectPath })
    return dir
  }

  it('indexes files inside an info/excluded colocated repo (the v1 blocker)', async () => {
    const plan = makeColocatedRepo('plan')
    await writeFile(join(plan, 'foo.md'), '# foo')
    execFileSync('git', ['add', '-A'], { cwd: plan })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: plan })
    await writeFile(join(plan, 'bar.md'), '# bar') // untracked but not ignored
    await writeFile(join(testProjectPath, '.git', 'info', 'exclude'), '/plan/\n')

    const paths = (await fetchIndex()).map(e => e.path)
    expect(paths).toContain('plan/foo.md')
    expect(paths).toContain('plan/bar.md')
    // The dir node is derived too (undimmed in the tree elsewhere).
    expect(paths).toContain('plan')
  })

  it("honors the colocated repo's own .gitignore (hides logs/locks)", async () => {
    const plan = makeColocatedRepo('plan')
    await writeFile(join(plan, '.gitignore'), '*.log\n*.lock\n')
    await writeFile(join(plan, 'keep.md'), 'k')
    await writeFile(join(plan, 'poll.log'), 'noise')
    await writeFile(join(plan, 'session.lock'), 'x')
    await writeFile(join(testProjectPath, '.git', 'info', 'exclude'), '/plan/\n')

    const paths = (await fetchIndex()).map(e => e.path)
    expect(paths).toContain('plan/keep.md')
    expect(paths).not.toContain('plan/poll.log')
    expect(paths).not.toContain('plan/session.lock')
  })

  it('does not double-list a colocated file (single seen-set)', async () => {
    const plan = makeColocatedRepo('plan')
    await writeFile(join(plan, 'foo.md'), '# foo')
    await writeFile(join(testProjectPath, '.git', 'info', 'exclude'), '/plan/\n')

    const entries = await fetchIndex()
    expect(entries.filter(e => e.path === 'plan/foo.md')).toHaveLength(1)
  })

  it('orders host entries before colocated entries deterministically', async () => {
    await writeFile(join(testProjectPath, 'host.md'), 'h')
    execFileSync('git', ['add', '-A'], { cwd: testProjectPath })
    const plan = makeColocatedRepo('plan')
    await writeFile(join(plan, 'foo.md'), '# foo')
    await writeFile(join(testProjectPath, '.git', 'info', 'exclude'), '/plan/\n')

    const paths = (await fetchIndex()).map(e => e.path)
    expect(paths.indexOf('host.md')).toBeLessThan(paths.indexOf('plan/foo.md'))
  })
})

describe('GET /:project — colocated-repo tree badge', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'workflow-test-'))
    execFileSync('git', ['init', '-q'], { cwd: testProjectPath })
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: testProjectPath })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: testProjectPath })
    execFileSync('git', ['config', 'core.excludesFile', ''], { cwd: testProjectPath })
    clearColocatedReposCache()
  })
  afterEach(async () => {
    clearColocatedReposCache()
    await rm(testProjectPath, { recursive: true, force: true })
  })

  /** Create an in-place colocated repo under the host (own git repo). The caller is
   *  responsible for excluding it from the host index via .git/info/exclude. */
  function makeColocatedRepo(name: string) {
    const dir = join(testProjectPath, name)
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
    return dir
  }

  async function fetchRoot(): Promise<{ name: string; path: string; type: string; colocated?: true; gitignored?: true }[]> {
    const res = await fileRoutes.request('/test-project')
    expect(res.status).toBe(200)
    return res.json()
  }

  it('flags a colocated repo root dir with colocated:true (and keeps it undimmed)', async () => {
    makeColocatedRepo('plan')
    await writeFile(join(testProjectPath, '.git', 'info', 'exclude'), '/plan/\n')

    const nodes = await fetchRoot()
    const plan = nodes.find(n => n.path === 'plan')
    expect(plan).toBeDefined()
    expect(plan?.colocated).toBe(true)
    // Colocated repos must stay undimmed (not gitignored).
    expect(plan?.gitignored).toBeUndefined()
  })

  it('does not flag a plain (non-repo) directory', async () => {
    makeColocatedRepo('plan')
    await mkdir(join(testProjectPath, 'src'))
    await writeFile(join(testProjectPath, 'src', 'a.txt'), 'a')
    await writeFile(join(testProjectPath, '.git', 'info', 'exclude'), '/plan/\n')

    const nodes = await fetchRoot()
    expect(nodes.find(n => n.path === 'plan')?.colocated).toBe(true)
    expect(nodes.find(n => n.path === 'src')?.colocated).toBeUndefined()
  })

  it('does not flag a nested directory listed via /children', async () => {
    makeColocatedRepo('plan')
    // A normal nested dir that happens to share the colocated repo's name.
    await mkdir(join(testProjectPath, 'src', 'plan'), { recursive: true })
    await writeFile(join(testProjectPath, 'src', 'plan', 'a.txt'), 'a')
    await writeFile(join(testProjectPath, '.git', 'info', 'exclude'), '/plan/\n')

    const res = await fileRoutes.request('/test-project/children?dir=src')
    expect(res.status).toBe(200)
    const children: { path: string; colocated?: true }[] = await res.json()
    const nested = children.find(n => n.path === 'src/plan')
    expect(nested).toBeDefined()
    expect(nested?.colocated).toBeUndefined()
  })
})
