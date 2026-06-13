import { expect, type Page, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FIXTURE_MARKER, ephemeralYacoHome } from './cleanup'

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

// --- Persisted group-tree readers (VSCode tab-group model) ---
//
// Editor tab state (tabId / preview / pinned) now lives in the panel-layout TREE:
// each working-area GROUP (a `tabs` node) carries an ordered `tabs[]` of mixed
// editor/terminal entries plus its own `activeTab` instanceId. There is no
// `editorViews` map. Terminal session bindings stay in `terminalBindings` (by
// instanceId), with `terminalMru` naming the active one, and the focused/open
// target group is `activeGroupId`. These readers walk the persisted tree to
// expose the single-value equivalents the old global `openTabs`/`activeTab` (and
// per-instance editorViews) exposed, so characterization specs assert the same
// observable persisted state through the group shape.

type PersistedGroupTab =
  | { instanceId: string; kind: 'editor'; tabId: string; preview?: boolean; pinned?: boolean }
  | { instanceId: string; kind: 'terminal' }
type PersistedTreeNode = {
  kind: string
  id?: string
  panel?: string
  tabs?: PersistedGroupTab[]
  activeTab?: string
  children?: { node: PersistedTreeNode }[]
}
type PersistedGroupState = {
  panelLayout?: { desktop?: PersistedTreeNode }
  activeGroupId?: string
  terminalBindings?: Record<string, string>
  editorMru?: string[]
  terminalMru?: string[]
} | null | undefined

/** Every working-area GROUP (`tabs` node) in document order. */
function groupsInOrder(node: PersistedTreeNode | undefined, out: PersistedTreeNode[] = []): PersistedTreeNode[] {
  if (!node) return out
  if (node.kind === 'tabs') out.push(node)
  else for (const c of node.children ?? []) groupsInOrder(c.node, out)
  return out
}

/** The active group: the one named by `activeGroupId` if it is live, else the
 *  first group — mirroring the loader's `targetGroup` fallback. */
function activeGroup(state: PersistedGroupState): PersistedTreeNode | null {
  const groups = groupsInOrder(state?.panelLayout?.desktop)
  if (groups.length === 0) return null
  return groups.find((g) => g.id === state?.activeGroupId) ?? groups[0]
}

/** The active group's editor tab ids (each a file path or `diff:` id), in tab
 *  order — the per-group replacement for the old global `openTabs`. */
export function openEditorTabIds(state: PersistedGroupState): string[] {
  const g = activeGroup(state)
  return (g?.tabs ?? []).flatMap((t) => (t.kind === 'editor' ? [t.tabId] : []))
}

/** The active group's ACTIVE editor tab id (file path or `diff:` id), or null —
 *  the per-group replacement for the old global `activeTab`. */
export function activeEditorTabId(state: PersistedGroupState): string | null {
  const g = activeGroup(state)
  const active = g?.tabs?.find((t) => t.instanceId === g.activeTab)
  return active && active.kind === 'editor' ? active.tabId : null
}

/** Every editor tab id across ALL groups (tree-wide), in document order. */
export function allEditorTabIds(state: PersistedGroupState): string[] {
  return groupsInOrder(state?.panelLayout?.desktop)
    .flatMap((g) => (g.tabs ?? []).flatMap((t) => (t.kind === 'editor' ? [t.tabId] : [])))
}

/** The session bound to the active terminal — the value the old flat blob stored
 *  as `activeSession`. Returns '' when no terminal is bound (the detached state).
 *  `terminalBindings`/`terminalMru` are unchanged by the tab-group rework. */
export function activeBoundSession(state: PersistedGroupState): string {
  const bindings = state?.terminalBindings ?? {}
  for (const id of state?.terminalMru ?? []) {
    const session = bindings[id]
    if (typeof session === 'string' && session) return session
  }
  const first = Object.values(bindings).find((s): s is string => typeof s === 'string' && s.length > 0)
  return first ?? ''
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
 *  registry, so it works against an empty per-run YACO_HOME. Pass `opts` to seed
 *  extra repo shape (files, a task graph). Dispose the returned fixture when done. */
export async function provisionWorkspace(
  page: Page,
  request: APIRequestContext,
  opts: FixtureOptions = {},
): Promise<FixtureProject> {
  const project = await createFixtureProject(request, opts)
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

/** True when the server can serve the file's content (i.e. it exists). */
export function fileExistsOnServer(page: Page, project: string, path: string): Promise<boolean> {
  return page.evaluate(async ({ project, path }) => {
    const res = await fetch(`/api/files/${encodeURIComponent(project)}/content?path=${encodeURIComponent(path)}`)
    return res.ok
  }, { project, path })
}

/** True when the server can list the directory's children (i.e. it exists). */
export function dirExistsOnServer(page: Page, project: string, path: string): Promise<boolean> {
  return page.evaluate(async ({ project, path }) => {
    const res = await fetch(`/api/files/${encodeURIComponent(project)}/children?dir=${encodeURIComponent(path)}`)
    return res.ok
  }, { project, path })
}

/** Open a file through the Cmd+P quick-open search. The palette does a live
 *  `/api/files/<project>/search-index` fetch on open (reads disk), so a file
 *  created via the API moments earlier is found — wait for its result row
 *  rather than sleeping, then open the top match. */
export async function openFileViaSearch(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Meta+p')
  const input = page.locator('input[placeholder="Search files..."]')
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill(query)
  await expect(page.locator('[data-search-result-idx]', { hasText: query }).first())
    .toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Enter')
  await expect(input).toBeHidden({ timeout: 10_000 })
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

// --- Working-area group probes (VSCode tab-group model) ----------------------
//
// The working area is a grid of GROUPS, each `data-group-id`. A group renders a
// mixed tab strip (`[data-testid="group-tab"]`, kind via `data-tab-kind`, active
// via `data-tab-active`) over the ACTIVE tab's BODY wrapper — the body alone
// carries `data-instance-id` + `data-panel-leaf="editor|terminal"` + the focus
// markers (`data-focused`/`data-active`). A NON-active tab has no body in the DOM,
// so select its tab first to mount it. The FIRST group is the `role="main"`
// landmark. Terminals are tabs in the working groups now — NOT in the activity
// panel — so a bound session's xterm/body lives under a group, not the dock.

/** The first working-area group — the `role="main"` landmark. */
export const mainGroup = (page: Page) => page.locator('[role="main"]')
/** A working-area group container by its structural id (e.g. 'group:1'). */
export const group = (page: Page, groupId: string) => page.locator(`[data-group-id="${groupId}"]`)
/** All working-area group containers, in document order. */
export const allGroups = (page: Page) => page.locator('[data-group-id]')
/** A group-tab by its visible title (editor: its tabId; terminal: session name),
 *  optionally scoped to a single group locator. */
export const groupTab = (scope: Page | ReturnType<Page['locator']>, title: string) =>
  scope.locator(`[data-testid="group-tab"][title="${title}"]`)
/** The active tab BODY of `kind` inside `scope` (a group, or the page for the
 *  single-group case) — carries data-instance-id / data-focused / data-active. */
export const groupBody = (scope: Page | ReturnType<Page['locator']>, kind: 'editor' | 'terminal') =>
  scope.locator(`[data-panel-leaf="${kind}"]`)

/** Open a file as a PINNED editor tab in the active group. Quick-open selects it
 *  as a PREVIEW (italic) tab and reveals it in the explorer; a double-click on its
 *  explorer row pins it (the real "make permanent" gesture, mirroring VSCode —
 *  single-click previews, double-click pins). Without pinning, opening a second
 *  file would REPLACE the first's preview slot instead of adding a sibling tab. */
export async function openPinnedFile(page: Page, query: string): Promise<void> {
  await openFileViaSearch(page, query)
  const base = query.split('/').pop() as string
  const row = sidebar(page).getByText(base, { exact: true }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.dblclick()
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
  // Marker so global cleanup only ever deletes helper-created fixtures.
  writeFileSync(join(root, FIXTURE_MARKER), '')
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

/** Optional extra shape to seed into a fixture repo before its initial commit. */
export interface FixtureOptions {
  /** Extra files to write (repo-relative path → content). Parent dirs created. */
  files?: Record<string, string>
  /** Task graph written to plan/tasks/tasks.json. */
  tasks?: Record<string, unknown>
}

/** Provision a minimal isolated git project registered under a unique per-run
 *  name. Pass `opts` to seed extra files / a task graph. Used by specs that need
 *  a project scope nobody else shares (e.g. server-side pinned-session state). */
export async function createFixtureProject(
  request: APIRequestContext,
  opts: FixtureOptions = {},
): Promise<FixtureProject> {
  const name = `fixture-${runTag()}`
  const root = initRepo('yaco-e2e-proj-')
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  if (opts.tasks) {
    mkdirSync(join(root, 'plan/tasks'), { recursive: true })
    writeFileSync(join(root, 'plan/tasks/tasks.json'), JSON.stringify(opts.tasks, null, 2) + '\n')
  }
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'init fixture'])
  await registerProject(request, name, root)
  return { name, path: root, dispose: disposer(request, name, root) }
}

/** A $HOME-rooted directory tree for the /api/browse spec. The browse endpoint
 *  only serves paths under $HOME (server/src/routes/browse.ts), so this can't
 *  live in the temp YACO_HOME. Holds one git subdir and one plain subdir so the
 *  spec can assert the isGit flag deterministically. Not a registered project. */
export interface BrowseFixture {
  /** Absolute path under $HOME to pass as the /api/browse `prefix`. */
  root: string
  /** Subdir that IS a git repo (browse flags isGit: true). */
  gitDir: string
  /** Subdir that is NOT a git repo (isGit: false). */
  plainDir: string
  dispose: () => void
}

export function createBrowseFixture(): BrowseFixture {
  const root = mkdtempSync(join(homedir(), '.yaco-e2e-browse-'))
  writeFileSync(join(root, FIXTURE_MARKER), '')
  const gitDir = 'with-git'
  const plainDir = 'plain-dir'
  mkdirSync(join(root, gitDir))
  git(join(root, gitDir), ['init', '-q', '-b', 'main'])
  mkdirSync(join(root, plainDir))
  return { root, gitDir, plainDir, dispose: () => rmSync(root, { recursive: true, force: true }) }
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

// --- Attention-surface seeding (Facet B) -------------------------------------
//
// The attention engine (app/server) projects from THREE on-disk sources under
// the ephemeral YACO_HOME the isolated server binds (the same one this test
// process resolves):
//   - `${YACO_HOME}/sessions/<handle>.json`         — live session snapshot.
//   - `${YACO_HOME}/projects/<project>/events.jsonl` — durable edge/generation log.
//   - `${YACO_HOME}/ui-state/pinned-sessions.json`   — pins (promote to OWNED).
//
// `GET /api/sessions` reads the session state files DIRECTLY (a pure read, no
// liveness GC — see server/src/routes/sessions.ts), so a hand-written state
// file with a non-running pid still renders. `GET /api/attention/feed` projects
// the CURRENT snapshot from these same files. The engine's boot reconciliation
// (which mints a `session_idle` event for an owned-idle session) only runs at
// server startup against an empty home, so a spec that needs a Ready item seeds
// the matching `session_idle` event directly — the byte-shape the engine writes.

/** The ephemeral YACO_HOME the isolated e2e server binds. Throws in E2E_REUSE
 *  mode (real ~/.yaco) — attention seeding specs run isolated only. */
function requireEphemeralHome(): string {
  const home = ephemeralYacoHome()
  if (!home) throw new Error('attention seeding requires the isolated e2e server (no E2E_REUSE)')
  return home
}

/** A seedable session-state file (`${YACO_HOME}/sessions/<handle>.json`). The
 *  shape mirrors cli `SessionState` (see cli/src/lib/core/agent/model.ts). The
 *  server associates it to a project by `sessionPath` being the project path or
 *  a descendant of it. */
export interface SeedSessionOpts {
  handle: string
  /** Must equal (or be under) the fixture project's path so it associates. */
  sessionPath: string
  status: 'starting' | 'idle' | 'processing' | 'blocked' | 'crashed'
  /** ISO time the status was entered — the status-edge generation key. */
  statusEnteredAt: string
  provider?: string
  exitCode?: number
  blockReason?: 'permission' | 'question' | 'trust'
  spawnedBy?: 'user:web' | 'user:terminal' | 'agent'
  parentSession?: string
  pid?: number
  createdAt?: string
}

/** Write one session state file into the ephemeral sessions dir. Returns the
 *  handle so callers can build selectors / event ids off it. */
export function seedSession(opts: SeedSessionOpts): string {
  const dir = join(requireEphemeralHome(), 'sessions')
  mkdirSync(dir, { recursive: true })
  const state: Record<string, unknown> = {
    handle: opts.handle,
    provider: opts.provider ?? 'claude',
    sessionPath: opts.sessionPath,
    pid: opts.pid ?? 999_999, // a non-running pid; the pure read does not GC it.
    sessionId: `seed-${opts.handle}`,
    status: opts.status,
    createdAt: opts.createdAt ?? opts.statusEnteredAt,
    statusEnteredAt: opts.statusEnteredAt,
  }
  if (opts.exitCode !== undefined) state.exitCode = opts.exitCode
  if (opts.blockReason !== undefined) state.blockReason = opts.blockReason
  if (opts.spawnedBy !== undefined) state.spawnedBy = opts.spawnedBy
  if (opts.parentSession !== undefined) state.parentSession = opts.parentSession
  writeFileSync(join(dir, `${opts.handle}.json`), JSON.stringify(state, null, 2))
  return opts.handle
}

/** Append a `session_idle` event for an owned-idle session, byte-shaped exactly
 *  as the engine writes it (id = generation, payload carries sessionName+owner),
 *  so the projector emits an unacked Ready ("Your turn") item. `statusEnteredAt`
 *  MUST match the session's so the live generation and the durable event agree. */
export function seedSessionIdleEvent(project: string, handle: string, statusEnteredAt: string): void {
  const generation = `session_idle:${project}::${handle}:${statusEnteredAt}`
  const event = {
    id: generation,
    ts: statusEnteredAt,
    kind: 'session_idle',
    projectId: project,
    sessionId: handle,
    payload: { sessionName: handle, owner: 'OWNED' },
  }
  const file = join(requireEphemeralHome(), 'projects', project, 'events.jsonl')
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(event) + '\n')
}
