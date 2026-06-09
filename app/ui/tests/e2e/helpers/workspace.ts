import { expect, type Page, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Shared e2e helpers for the workspace persistence / worktree / binary specs.
//
// Two jobs:
//  1. Speak the CURRENT app's localStorage contract — `yaco-workspace:<project>`
//     (and `:wt:<slug>` for worktree scope), matching `hooks/workspaceTypes.ts`.
//     The pre-rebrand `workflow-workspace` key the app no longer touches, so any
//     spec still using it round-trips a dead key.
//  2. Namespace every provisioned project + created fixture file with a unique
//     per-run id. Parallel git-worktree e2e runs share one `~/.yaco` and one set
//     of on-disk project files; a fixed name (`worktree-qa`, `Tax2025`, a shared
//     test filename) collides across runs. The per-run tag keeps them isolated.

// --- Per-run namespacing ---

// Stable per-worktree prefix: the slug from a `.worktrees/<slug>/` cwd, else
// `main`. Same derivation as app/ui/e2ePorts.ts, kept local so the helper has no
// cross-tree import.
const WORKTREE_SLUG = (() => {
  const m = process.cwd().match(/\.worktrees\/([^/]+)/)
  return m ? m[1] : 'main'
})()

let runCounter = 0

/** A unique-per-run token: worktree slug + pid + monotonic counter + entropy.
 *  URL-safe so it is valid in a project name and a filename. */
export function runTag(): string {
  runCounter += 1
  return `${WORKTREE_SLUG}-${process.pid}-${runCounter}-${Math.random().toString(36).slice(2, 7)}`
}

/** A unique fixture filename, e.g. `__e2e_main-1234-1-ab9cd_persist_tab.txt`. */
export function uniqueFileName(base: string): string {
  return `__e2e_${runTag()}_${base}`
}

// --- localStorage contract (current app key) ---

/** Workspace persistence key, scoped by worktree slug when present. Mirrors
 *  `layoutKey` in app/ui/src/hooks/workspaceTypes.ts. */
export function layoutKey(project: string, worktree?: string | null): string {
  return worktree ? `yaco-workspace:${project}:wt:${worktree}` : `yaco-workspace:${project}`
}

/** Read + parse the persisted workspace state the app actually writes. */
export function getWorkspaceState(page: Page, project: string, worktree?: string | null) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, layoutKey(project, worktree))
}

// --- Workspace navigation ---

type ProjectInfo = { name: string; path: string }

async function fetchProjects(page: Page): Promise<ProjectInfo[]> {
  return page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<ProjectInfo[]>
  })
}

/** Wait for the app shell to be interactive. There is no `<header>` element; the
 *  theme toggle renders in both the desktop top bar and the mobile shell, so it
 *  is the stable "app loaded" signal across viewports and reloads. */
export async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.locator('[aria-label="Toggle theme"]').first()).toBeVisible({ timeout: 10_000 })
}

/** Load the app and select the first registered project. */
export async function openWorkspace(page: Page): Promise<ProjectInfo> {
  await page.goto('/')
  await waitForAppReady(page)
  const projects = await fetchProjects(page)
  expect(projects.length).toBeGreaterThan(0)
  const project = projects[0]
  await page.locator('button', { hasText: project.name }).first().click()
  return project
}

/** Select a named project once its sidebar button is present. */
export async function selectProject(page: Page, name: string): Promise<void> {
  await expect(page.locator('button', { hasText: name }).first()).toBeVisible({ timeout: 10_000 })
  await page.locator('button', { hasText: name }).first().click()
}

/** Provision a fresh isolated project, load the app, and select it. The standard
 *  entry point for layout/persistence specs: it depends on nothing already in the
 *  registry, so it works against an empty per-worktree YACO_HOME. Dispose the
 *  returned fixture when done. */
export async function provisionWorkspace(page: Page, request: APIRequestContext): Promise<FixtureProject> {
  const project = await createFixtureProject(request)
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, project.name)
  return project
}

// --- File API helpers (run through the proxied /api routes from the page) ---

/** Create an empty file, then write its content via a revisioned PUT. */
export async function createTestFile(page: Page, project: string, path: string, content: string): Promise<void> {
  await page.evaluate(async ({ project, path }) => {
    await fetch(`/api/files/${encodeURIComponent(project)}/create-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  }, { project, path })
  await writeFileViaAPI(page, project, path, content)
}

/** Overwrite a file's content via a revisioned PUT (read current revision first). */
export async function writeFileViaAPI(page: Page, project: string, path: string, content: string): Promise<void> {
  const { revision } = await page.evaluate(async ({ project, path }) => {
    const res = await fetch(`/api/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`)
    return res.json() as Promise<{ revision: number }>
  }, { project, path })
  await page.evaluate(async ({ project, path, content, revision }) => {
    await fetch(`/api/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseRevision: revision }),
    })
  }, { project, path, content, revision })
}

/** Delete a fixture file via the API. */
export async function deleteTestFile(page: Page, project: string, path: string): Promise<void> {
  await page.evaluate(async ({ project, path }) => {
    await fetch(`/api/files/${encodeURIComponent(project)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  }, { project, path })
}

/** Open a file through the Cmd+P quick-open search. */
export async function openFileViaSearch(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Meta+p')
  await expect(page.locator('input[placeholder="Search files..."]')).toBeVisible({ timeout: 10_000 })
  await page.locator('input[placeholder="Search files..."]').fill(query)
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1000)
}

/** Wait for an SSE-driven refetch to settle. Time-based by design: SSE events
 *  fan out to several independent refetches with no single settle signal. */
export async function waitForSSERefresh(page: Page, timeoutMs = 8000): Promise<void> {
  await page.waitForTimeout(timeoutMs)
}

// --- Geometry / DOM probes against the current renderer ---

export const sidebar = (page: Page) => page.locator('[role="navigation"][aria-label="Sidebar"]')
export const activityPanel = (page: Page) => page.locator('[role="complementary"][aria-label="Activity panel"]')
/** The Projects-section body wrapper (carries the persisted projectSize height). */
export const projectsSectionBody = (page: Page) =>
  sidebar(page).locator('.flex.flex-col.gap-0\\.5.px-1.py-1').locator('xpath=..')
/** A section header row by title, exposing aria-expanded for collapse state. */
export const sectionHeader = (page: Page, title: string) =>
  page.locator(`[role="button"][aria-label="${title} section"]`)

/** Assert a measured pixel size is within tolerance of an expected value. */
export function expectApproxSize(actual: number | undefined, expected: number, tol = 12): void {
  expect(actual, `expected ~${expected}px (±${tol}), got ${actual}`).toBeGreaterThan(expected - tol)
  expect(actual).toBeLessThan(expected + tol)
}

// --- Per-run fixture projects ---

export interface FixtureProject {
  name: string
  path: string
  dispose: () => Promise<void>
}

export interface BinaryFixtureProject extends FixtureProject {
  pdfTab: string
  textTab: string
  imagePath: string
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function initRepo(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'e2e@yaco.test'])
  git(root, ['config', 'user.name', 'yaco-e2e'])
  return root
}

async function registerProject(request: APIRequestContext, name: string, path: string): Promise<void> {
  const res = await request.post('/api/projects', { data: { name, path } })
  if (!res.ok()) throw new Error(`register fixture project failed: ${res.status()} ${await res.text()}`)
}

function disposer(request: APIRequestContext, name: string, root: string): () => Promise<void> {
  return async () => {
    await request.delete(`/api/projects/${encodeURIComponent(name)}`).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
}

/** Provision a minimal isolated git project registered under a unique per-run
 *  name. Used by specs that need a project scope nobody else shares (e.g.
 *  server-side pinned-session state). */
export async function createFixtureProject(request: APIRequestContext): Promise<FixtureProject> {
  const name = `fixture-${runTag()}`
  const root = initRepo('yaco-e2e-proj-')
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'init fixture'])
  await registerProject(request, name, root)
  return { name, path: root, dispose: disposer(request, name, root) }
}

/**
 * Provision an isolated git project whose task graph exposes three worktree
 * shapes the worktree spec pins:
 *  - auth-v2:   active worktree, dirty (untracked wip.txt), 1 commit ahead
 *  - perf-cache: active worktree, clean
 *  - ui-cleanup: no worktree (worktree: null)
 *
 * Registered under a unique per-run name so parallel worktree runs never share
 * the fixture in `~/.yaco`.
 */
export async function createWorktreeFixture(request: APIRequestContext): Promise<FixtureProject> {
  const name = `wt-fixture-${runTag()}`
  const root = initRepo('yaco-e2e-wt-')

  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'plan/tasks'), { recursive: true })
  writeFileSync(join(root, 'src/index.js'), 'export const main = 1\n')
  writeFileSync(join(root, 'README.md'), '# worktree fixture\n')
  const tasks = {
    'auth-v2': { parent: null, depends: [], state: 'running', workset: 'active', title: 'Auth v2', description: 'auth work', acceptCriteria: ['ships'], worktree: 'auth-v2' },
    'perf-cache': { parent: null, depends: [], state: 'ready', workset: 'active', title: 'Perf cache', description: 'perf work', acceptCriteria: ['ships'], worktree: 'perf-cache' },
    'ui-cleanup': { parent: null, depends: [], state: 'ready', workset: 'active', title: 'UI cleanup', description: 'ui work', acceptCriteria: ['ships'], worktree: null },
  }
  writeFileSync(join(root, 'plan/tasks/tasks.json'), JSON.stringify(tasks, null, 2) + '\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'init worktree fixture'])

  // auth-v2: one commit ahead of main + a dirty (untracked) file.
  git(root, ['worktree', 'add', '-q', '-b', 'task/auth-v2', '.worktrees/auth-v2'])
  const authDir = join(root, '.worktrees/auth-v2')
  writeFileSync(join(authDir, 'src/v2.js'), 'export const v2 = true\n')
  git(authDir, ['add', '-A'])
  git(authDir, ['commit', '-q', '-m', 'auth-v2 feature'])
  writeFileSync(join(authDir, 'wip.txt'), 'work in progress\n')

  // perf-cache: clean, even with main.
  git(root, ['worktree', 'add', '-q', '-b', 'task/perf-cache', '.worktrees/perf-cache'])

  await registerProject(request, name, root)
  return { name, path: root, dispose: disposer(request, name, root) }
}

// A 1x1 transparent PNG and a minimal PDF. Content validity is not the point —
// the binary spec checks the editor renders/serves them without white-screening.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const MINIMAL_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf-8')

/**
 * Provision an isolated project holding a text file, a PDF, and a PNG so the
 * binary-preview spec exercises real content instead of a project that may not
 * exist in this environment.
 */
export async function createBinaryFixture(request: APIRequestContext): Promise<BinaryFixtureProject> {
  const name = `bin-fixture-${runTag()}`
  const root = initRepo('yaco-e2e-bin-')

  mkdirSync(join(root, 'ui/public'), { recursive: true })
  writeFileSync(join(root, 'notes.txt'), 'just some notes\n')
  writeFileSync(join(root, 'coinbase.pdf'), MINIMAL_PDF)
  writeFileSync(join(root, 'ui/public/icon-192.png'), PNG_1x1)
  writeFileSync(join(root, 'package.json'), '{"name":"bin-fixture","private":true}\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'init binary fixture'])

  await registerProject(request, name, root)
  return {
    name,
    path: root,
    pdfTab: 'coinbase.pdf',
    textTab: 'notes.txt',
    imagePath: 'ui/public/icon-192.png',
    dispose: disposer(request, name, root),
  }
}
