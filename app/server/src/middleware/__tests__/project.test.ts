import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'fs/promises'
import { realpathSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'

// Point a named project at our temp repo; the middleware reads it via loadProjects.
let testProjectPath: string
vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([{ name: 'test-project', path: testProjectPath }]),
}))

const { withProject } = await import('../project')

type EchoEnv = { Variables: { project: { name: string; path: string } } }

/** Mount the real middleware on a route that echoes the resolved project path. */
function makeApp() {
  const app = new Hono<EchoEnv>()
  app.get('/:project', withProject, c =>
    c.json({ name: c.var.project.name, path: c.var.project.path }),
  )
  return app
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd })
}
function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  git(['config', 'user.email', 'test@test'], dir)
  git(['config', 'user.name', 'test'], dir)
}

/** Request `/test-project` with an optional `?worktree=<abspath>` (url-encoded). */
async function resolveProject(worktreeAbsPath?: string): Promise<Response> {
  const q = worktreeAbsPath === undefined ? '' : `?worktree=${encodeURIComponent(worktreeAbsPath)}`
  return makeApp().request(`/test-project${q}`)
}

let externalParent: string

describe('withProject — ?worktree= abspath allowlist', () => {
  beforeEach(async () => {
    testProjectPath = await mkdtemp(join(tmpdir(), 'mw-project-test-'))
    externalParent = await mkdtemp(join(tmpdir(), 'mw-project-ext-'))
    gitInit(testProjectPath)
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
    const res = await makeApp().request('/nope')
    expect(res.status).toBe(404)
  })

  it('resolves project.path to the base root when no ?worktree= is given', async () => {
    const res = await resolveProject()
    expect(res.status).toBe(200)
    // No worktree → the configured path is passed through verbatim (cache identity
    // must stay stable, so we do NOT realpath the base case).
    expect((await res.json()).path).toBe(testProjectPath)
  })

  it('resolves a listed internal worktree abspath to that worktree (canonicalized)', async () => {
    const wt = join(testProjectPath, '.worktrees', 'feat')
    git(['worktree', 'add', '-q', '-b', 'task/feat', wt], testProjectPath)

    const res = await resolveProject(wt)
    expect(res.status).toBe(200)
    expect((await res.json()).path).toBe(realpathSync(wt))
  })

  it('resolves a listed external worktree abspath (outside .worktrees/)', async () => {
    const ext = join(externalParent, 'ext-wt')
    git(['worktree', 'add', '-q', '-b', 'ext', ext], testProjectPath)

    const res = await resolveProject(ext)
    expect(res.status).toBe(200)
    expect((await res.json()).path).toBe(realpathSync(ext))
  })

  it('collapses a passed-primary abspath back to the base project path', async () => {
    // git lists the primary too; selecting it must behave like no ?worktree=.
    const res = await resolveProject(testProjectPath)
    expect(res.status).toBe(200)
    expect((await res.json()).path).toBe(testProjectPath)
  })

  it('rejects an unlisted (never-registered) path with 404', async () => {
    const stranger = join(externalParent, 'not-a-worktree')
    await mkdir(stranger, { recursive: true })
    const res = await resolveProject(stranger)
    expect(res.status).toBe(404)
  })

  it('rejects a stale path whose worktree dir was removed with 404', async () => {
    const wt = join(testProjectPath, '.worktrees', 'gone')
    git(['worktree', 'add', '-q', '-b', 'task/gone', wt], testProjectPath)
    await rm(wt, { recursive: true, force: true }) // dir gone; git list may still mention it

    const res = await resolveProject(wt)
    expect(res.status).toBe(404)
  })

  it('rejects a traversal path that escapes the worktree set with 404', async () => {
    const traversal = join(testProjectPath, '.worktrees', '..', '..', 'etc')
    const res = await resolveProject(traversal)
    expect(res.status).toBe(404)
  })

  it('rejects a symlink that lives under .worktrees/ but escapes the repo with 404', async () => {
    // A naive prefix check (`startsWith(.worktrees/)`) would accept this; realpath
    // canonicalization is what closes the symlink-escape hole.
    const secret = join(externalParent, 'secret')
    await mkdir(secret, { recursive: true })
    const link = join(testProjectPath, '.worktrees', 'escape')
    await mkdir(join(testProjectPath, '.worktrees'), { recursive: true })
    await symlink(secret, link)

    const res = await resolveProject(link)
    expect(res.status).toBe(404)
  })

  it('rejects a non-absolute worktree value with 404', async () => {
    const res = await resolveProject('feat')
    expect(res.status).toBe(404)
  })
})
