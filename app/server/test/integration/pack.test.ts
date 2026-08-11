/** The tarball, end to end: pack both packages, install them into a clean
 *  prefix, and fetch a page from the server that install produced.
 *
 *  Every other test in this suite runs the server out of the checkout it was
 *  built in, where the UI is a sibling directory away and every dependency is
 *  hoisted into a shared `node_modules` — so a path that only resolves inside a
 *  checkout, and a dependency the manifest never declared, both still work.
 *  This file removes the checkout: `npm pack` produces the bytes an
 *  `npm install -g @yaco/app` delivers, the install runs under its own HOME and
 *  prefix, and the server is started from a working directory with no yaco
 *  above it.
 *
 *  It is slow on purpose — the app's install compiles `node-pty` from source on
 *  Linux — which is why it is the `integration` project and not the default
 *  `npm test`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SERVER_DIR = resolve(import.meta.dirname, '../..')
const REPO_ROOT = resolve(SERVER_DIR, '../..')
const APP_MANIFEST = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf-8'))
const CLI_MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, 'cli/package.json'), 'utf-8'))

let sandbox: string
let prefix: string
let home: string
let installedApp: string
let appTarballEntries: string[]
/** HOME's contents the instant the install finished — the only honest moment to
 *  ask what installing wrote, before a running server can create anything. */
let homeAfterInstall: string[]
let server: ChildProcess | undefined
let baseUrl: string

/** A port the kernel just handed out and gave back: two servers in the same
 *  suite must not collide, and a hardcoded one collides with the developer's
 *  own app on :3001. */
async function freePort(): Promise<number> {
  return await new Promise((ok, err) => {
    const probe = createServer()
    probe.on('error', err)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => ok(port))
    })
  })
}

async function waitForHealth(url: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server never became healthy at ${url}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'yaco-app-pack-'))
  prefix = join(sandbox, 'prefix')
  home = join(sandbox, 'home')
  for (const d of ['stage', 'home', 'nowhere', 'prefix', 'yaco']) {
    mkdirSync(join(sandbox, d), { recursive: true })
  }

  // One pack call for both, because they release in lockstep: `prepack` builds
  // the UI and the bundle, so a pack that succeeds has also proved the build.
  const packed = spawnSync(
    'npm',
    [
      'pack',
      '--workspace', '@yaco/cli',
      '--workspace', '@yaco/app',
      '--pack-destination', join(sandbox, 'stage'),
    ],
    { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 900_000 },
  )
  if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`)

  const stage = join(sandbox, 'stage')
  const tarballs = readdirSync(stage).filter((f) => f.endsWith('.tgz'))
  expect(tarballs.sort()).toEqual(['yaco-app-0.1.0.tgz', 'yaco-cli-0.1.0.tgz'])

  appTarballEntries = spawnSync('tar', ['-tzf', join(stage, 'yaco-app-0.1.0.tgz')], {
    encoding: 'utf-8',
  })
    .stdout.split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ''))

  // Both tarballs in one install: `@yaco/app` requires `@yaco/cli` by version
  // range, and nothing has published it yet, so the co-installed tarball is
  // what has to satisfy that edge.
  const installed = spawnSync(
    'npm',
    [
      'install', '--global', '--prefix', prefix,
      join(stage, 'yaco-cli-0.1.0.tgz'),
      join(stage, 'yaco-app-0.1.0.tgz'),
    ],
    {
      cwd: sandbox,
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
      timeout: 1_800_000,
    },
  )
  if (installed.status !== 0) {
    throw new Error(`npm install of the tarballs failed:\n${installed.stderr}`)
  }
  installedApp = join(prefix, 'lib', 'node_modules', '@yaco', 'app')
  homeAfterInstall = readdirSync(home)

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(join(prefix, 'bin', 'yaco-app'), {
    cwd: join(sandbox, 'nowhere'),
    stdio: 'ignore',
    env: {
      PATH: `${join(prefix, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      YACO_HOME: join(sandbox, 'yaco'),
      WORKFLOW_PORT: String(port),
    },
  })
  await waitForHealth(baseUrl, 60_000)
}, 2_400_000)

afterAll(() => {
  server?.kill('SIGTERM')
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
})

describe('the packed app', () => {
  it('ships the bundle, the built UI, the manifest and the license — and no sources', () => {
    expect(appTarballEntries).toContain('dist/yaco-app.mjs')
    expect(appTarballEntries).toContain('ui/index.html')
    expect(appTarballEntries).toContain('package.json')
    expect(appTarballEntries).toContain('LICENSE')
    // The precompressed siblings the server negotiates are part of the UI, not
    // a build-machine artifact: without them every asset ships uncompressed.
    expect(appTarballEntries.some((e) => e.endsWith('.js.br'))).toBe(true)
    expect(appTarballEntries.filter((e) => e.startsWith('src/'))).toEqual([])
    expect(appTarballEntries.filter((e) => e.startsWith('test/'))).toEqual([])
  })

  it('depends on the published CLI at a shared version, not on a workspace', () => {
    expect(APP_MANIFEST.version).toBe(CLI_MANIFEST.version)
    expect(APP_MANIFEST.dependencies['@yaco/cli']).toBe(`^${CLI_MANIFEST.version}`)
    // Unpublished workspaces are inlined by the bundle, never required from a
    // consumer's registry — `npm install` would 404 on them.
    const required = Object.keys({
      ...APP_MANIFEST.dependencies,
      ...APP_MANIFEST.optionalDependencies,
    })
    expect(required.filter((n) => n.startsWith('@yaco/') && n !== '@yaco/cli')).toEqual([])
  })

  it('resolves the co-installed CLI rather than reaching for the registry', () => {
    const cli = JSON.parse(
      readFileSync(join(prefix, 'lib/node_modules/@yaco/cli/package.json'), 'utf-8'),
    )
    expect(cli.version).toBe(CLI_MANIFEST.version)
  })
})

describe('the installed bundle', () => {
  /** esbuild labels each module it inlined with `// <path>`; the labels are the
   *  only place a path legitimately appears without being one the code uses. */
  const code = () =>
    readFileSync(join(installedApp, 'dist/yaco-app.mjs'), 'utf-8')
      .split('\n')
      .filter((line) => !/^\s*\/\/ \S+$/.test(line))
      .join('\n')

  it('carries no repo-relative asset path', () => {
    expect(code()).not.toContain('../../')
    // The one `..` that belongs: the package-root resolver, which is exactly
    // one level up from `dist/` in the layout this tarball ships.
    const walks = code().split('\n').filter((line) => line.includes('../'))
    expect(walks).toHaveLength(1)
    expect(walks[0]).toContain('PACKAGE_ROOT')
  })

  it('inlines no third-party package', () => {
    // A package that reached the bundle instead of the manifest is a copy of
    // someone else's library shipped inside ours, and it only got there because
    // this monorepo's hoisting made an undeclared import resolve.
    const labels = readFileSync(join(installedApp, 'dist/yaco-app.mjs'), 'utf-8')
      .split('\n')
      .filter((line) => /^\s*\/\/ \S+$/.test(line) && line.includes('node_modules/'))
    expect(labels).toEqual([])
  })
})

describe('the installed server', () => {
  it('writes no yaco state into HOME at install time', () => {
    // §4: installing is files and executables only. npm's own caches are npm's.
    expect(homeAfterInstall.filter((e) => !['.npm', '.cache', '.npmrc'].includes(e))).toEqual([])
  })

  it('serves the built UI over HTTP', async () => {
    const res = await fetch(`${baseUrl}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<div id="root">')

    // The shell alone would pass with an empty `assets/`; the hashed entry
    // module it names is the rest of the UI.
    const entry = html.match(/\/assets\/[^"']+\.js/)?.[0]
    expect(entry).toBeTruthy()
    const asset = await fetch(`${baseUrl}${entry}`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect((await asset.text()).length).toBeGreaterThan(1000)
  })

  it('serves a deep route from the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/some/deep/route`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
  })
})
