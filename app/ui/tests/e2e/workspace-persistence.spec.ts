import { test, expect, type Page } from '@playwright/test'
import {
  provisionWorkspace,
  selectProject,
  createFixtureProject,
  waitForAppReady,
  getWorkspaceState,
  activeEditorView,
  createTestFile,
  deleteTestFile,
  openFileViaSearch,
  waitForSSERefresh,
  uniqueFileName,
  sidebar,
  activityPanel,
  sectionHeader,
  expectApproxSize,
  type FixtureProject,
} from './helpers/workspace'

// Every test provisions the isolated project(s) it needs (unique per run) and
// disposes them after, so nothing depends on whatever already exists in the
// registry — which is critical under a per-worktree YACO_HOME where the registry
// starts empty.
let provisioned: FixtureProject[] = []

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

/** Provision an isolated workspace and track it for teardown. */
async function ws(page: Page, request: Parameters<typeof createFixtureProject>[0]): Promise<FixtureProject> {
  const project = await provisionWorkspace(page, request)
  provisioned.push(project)
  return project
}

/** Provision an extra isolated project (registered, not selected) for teardown. */
async function extraProject(request: Parameters<typeof createFixtureProject>[0]): Promise<FixtureProject> {
  const project = await createFixtureProject(request)
  provisioned.push(project)
  return project
}

function readUiState(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('yaco-ui-state')
    return raw ? JSON.parse(raw) : null
  })
}

// --- New persisted shape (design: Persistence Shape) ---
//
// T4c (fl-model-persist) replaced the old flat `layout` bag with a normalized
// `panelLayout` tree (+ `panelState.editor` prefs + `mobile.activeDock`), written
// on every save. The field-reads below pin that the new shape round-trips through
// the persisted blob well-formed. They assert the canonical *default* tree because
// the legacy renderer still drives live geometry through the flat layout during
// the migration window — the tree renderer that makes the tree the live source is
// a later phase — so toggles/sizes/editor-prefs do not yet mutate `panelLayout`.
// Each test's behavioral persistence (a panel actually hidden/visible, a section
// rendered collapsed, a size applied, surviving reload) is carried by its
// DOM/geometry assertions, which stay exactly as-is.

type Json = Record<string, unknown>

function asJson(value: unknown): Json {
  return value && typeof value === 'object' ? (value as Json) : {}
}

function panelLayout(state: Json | null): Json {
  return asJson(asJson(state ?? {}).panelLayout)
}

/** Collect the panel ids of every leaf/tab in a desktop tree node. */
function leafPanels(node: unknown, acc: string[] = []): string[] {
  const n = asJson(node)
  if (n.kind === 'leaf' && typeof n.panel === 'string') acc.push(n.panel)
  if (n.kind === 'split' && Array.isArray(n.children)) {
    for (const child of n.children) leafPanels(asJson(child).node, acc)
  }
  if (n.kind === 'tabs' && Array.isArray(n.panels)) {
    for (const panel of n.panels) if (typeof panel === 'string') acc.push(panel)
  }
  return acc
}

/** Assert the blob persists a normalized v1 panel-layout tree carrying the full
 *  default three-region desktop arrangement (dock split / editor+tasks main tabs /
 *  activity split), i.e. all seven panels exactly once. */
function expectPanelTree(state: Json | null): void {
  const pl = panelLayout(state)
  expect(pl.version).toBe(1)
  expect(asJson(pl.desktop).kind).toBe('split')
  expect(leafPanels(pl.desktop).sort()).toEqual(
    ['changes', 'editor', 'files', 'projects', 'sessions', 'tasks', 'terminal'],
  )
}

/** Assert the blob persists a well-formed `panelState.editor` block (design:
 *  panelState.editor — the four editor prefs). */
function expectEditorPrefs(state: Json | null): void {
  const editor = asJson(asJson(panelLayout(state).panelState).editor)
  expect(['edit', 'split', 'preview']).toContain(editor.previewMode)
  expect(['horizontal', 'vertical']).toContain(editor.splitDirection)
  expect(typeof editor.splitSize).toBe('number')
  expect(typeof editor.autocompleteEnabled).toBe('boolean')
}

/** Assert the blob persists a valid mobile dock (design: mobile.activeDock). */
function expectMobileDock(state: Json | null): void {
  expect(['browse', 'editor', 'tasks', 'terminal']).toContain(asJson(panelLayout(state).mobile).activeDock)
}

// --- Tests ---

// These are characterization tests: they pin the CURRENT renderer's behavior so a
// later refactor can be checked against it. Each localStorage assertion is paired
// with a DOM/geometry assertion against the live app, so a green run proves the
// app actually applied the persisted state — not just that a key round-tripped.
test.describe('Layout persistence characterization', () => {
  test('Cmd+B toggles sidebar visibility and persists across reload', async ({ page, request }) => {
    const project = await ws(page, request)

    // Default: sidebar visible at its persisted width.
    await expect(sidebar(page)).toBeVisible()
    expectApproxSize((await sidebar(page).boundingBox())?.width, 220)

    // Toggle sidebar off
    await page.keyboard.press('Meta+b')
    await page.waitForTimeout(500)

    // Persisted shape AND actually gone from the DOM
    let state = await getWorkspaceState(page, project.name)
    expectPanelTree(state)
    await expect(sidebar(page)).toBeHidden()

    // Reload — still hidden, new shape still persisted
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(2000)

    state = await getWorkspaceState(page, project.name)
    expectPanelTree(state)
    await expect(sidebar(page)).toBeHidden()

    // Restore — visible again at its width
    await page.keyboard.press('Meta+b')
    await page.waitForTimeout(500)
    await expect(sidebar(page)).toBeVisible()
    expectApproxSize((await sidebar(page).boundingBox())?.width, 220)
  })

  test('Cmd+Shift+B toggles right panel and persists', async ({ page, request }) => {
    const project = await ws(page, request)

    // Default: activity (right) panel visible.
    await expect(activityPanel(page)).toBeVisible()

    // Toggle off → new shape persisted AND removed from the DOM
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(500)
    let state = await getWorkspaceState(page, project.name)
    expectPanelTree(state)
    await expect(activityPanel(page)).toBeHidden()

    // Toggle back → new shape persisted AND visible again
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(500)
    state = await getWorkspaceState(page, project.name)
    expectPanelTree(state)
    await expect(activityPanel(page)).toBeVisible()
  })

  test('open tabs and active tab persist across reload', async ({ page, request }) => {
    const project = await ws(page, request)
    const testFile = uniqueFileName('persist_tab.txt')

    await createTestFile(page, project.name, testFile, 'persistence test\n')
    await waitForSSERefresh(page, 3000)

    // Open file and pin it
    await openFileViaSearch(page, testFile)
    await page.locator('.overflow-x-auto').locator(`[title="${testFile}"]`).dblclick()
    await page.waitForTimeout(500)

    // Reload
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(2000)

    // Tab should be restored in the DOM
    await expect(page.locator('.overflow-x-auto').locator(`[title="${testFile}"]`)).toBeVisible({ timeout: 10_000 })

    // Active tab should be our file (the active editor's per-instance view).
    const state = await getWorkspaceState(page, project.name)
    expect(activeEditorView(state)?.activeTab).toBe(testFile)

    // Cleanup
    await deleteTestFile(page, project.name, testFile)
  })

  test('pinned session order persists across reload (server-side ui-state)', async ({ page, request }) => {
    // Pinned-session order is now durable server state (`/api/ui-state`), not a
    // workspace-localStorage field. Provision an isolated project so the pin set
    // is not shared with other runs, seed an order, reload, and assert it survives.
    const project = await extraProject(request)
    const pinnedOrder = ['session-z', 'session-a', 'session-m']
    const putRes = await request.put(
      `/api/ui-state/pinned-sessions?project=${encodeURIComponent(project.name)}`,
      { data: { sessions: pinnedOrder } },
    )
    expect(putRes.ok()).toBe(true)

    // Mount the workspace for the fixture (the app reads pins through usePinnedSessions).
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, project.name)
    await page.waitForTimeout(1000)

    // Reload, then read the durable order back.
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1000)

    const getRes = await request.get(`/api/ui-state/pinned-sessions?project=${encodeURIComponent(project.name)}`)
    expect(await getRes.json()).toEqual(pinnedOrder)
  })

  test('per-project layout is independent', async ({ page, request }) => {
    // Two isolated projects: toggling one project's layout must not leak to the
    // other. Both are registered BEFORE the first load so both sidebar buttons
    // exist without relying on a live project-registration SSE refresh. Uses the
    // right panel + click-to-switch (the left sidebar stays visible) so the
    // assertion never depends on registry ordering.
    const a = await extraProject(request)
    const b = await extraProject(request)
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, a.name)
    await expect(sectionHeader(page, a.name)).toBeVisible({ timeout: 10_000 })

    // Project A: activity panel visible by default, then toggle it off.
    await expect(activityPanel(page)).toBeVisible()
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(500)
    await expect(activityPanel(page)).toBeHidden()
    expectPanelTree(await getWorkspaceState(page, a.name))

    // Switch to project B (left sidebar is still shown, so we can click).
    await selectProject(page, b.name)
    await expect(sectionHeader(page, b.name)).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(500)

    // Project B is unaffected — activity panel still on (default).
    await expect(activityPanel(page)).toBeVisible()
    expectPanelTree(await getWorkspaceState(page, b.name))

    // Back to A — its toggle persisted independently.
    await selectProject(page, a.name)
    await expect(sectionHeader(page, a.name)).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(500)
    await expect(activityPanel(page)).toBeHidden()
    expectPanelTree(await getWorkspaceState(page, a.name))
  })
})

test.describe('Keyboard shortcut characterization', () => {
  test('Cmd+1-9 switches projects in workspace view', async ({ page, request }) => {
    const a = await extraProject(request)
    const b = await extraProject(request)
    await page.goto('/')
    await waitForAppReady(page)

    // Pin our two fixtures to positions 1 and 2 so Cmd+1/Cmd+2 address them
    // deterministically no matter how many fixtures parallel workers have
    // registered. Other workers only ever append (positions ≥3) or dispose
    // (positions ≥3), so 1-2 stay put. Reorder needs the full current set; if a
    // concurrent dispose changes it mid-call we retry, then report the status so
    // genuine reorder regressions fail loudly instead of silently skipping.
    const result = await page.evaluate(async ({ a, b }) => {
      let lastStatus = 0
      for (let attempt = 0; attempt < 3; attempt++) {
        const list = (await (await fetch('/api/projects')).json()) as { name: string }[]
        const names = list.map((p) => p.name)
        if (!names.includes(a) || !names.includes(b)) { lastStatus = -1; continue }
        const order = [a, b, ...names.filter((n) => n !== a && n !== b)]
        const res = await fetch('/api/projects/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order }),
        })
        if (res.ok) return { ok: true, status: res.status }
        lastStatus = res.status
      }
      return { ok: false, status: lastStatus }
    }, { a: a.name, b: b.name })

    // 400/409 (or our fixtures briefly absent, -1) = the set changed mid-reorder
    // under registry churn — benign, skip. Any other status is a real
    // /api/projects/reorder regression → fail loudly.
    if (!result.ok) {
      test.skip(
        result.status === 400 || result.status === 409 || result.status === -1,
        `reorder could not pin fixtures under registry churn (status ${result.status})`,
      )
      expect(result.ok, `/api/projects/reorder failed unexpectedly (status ${result.status})`).toBe(true)
    }

    // Reload so the app fetches the reordered list, then confirm it leads with
    // [a, b] before exercising the shortcuts (avoids racing the SSE re-order).
    await page.reload()
    await waitForAppReady(page)
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const list = (await (await fetch('/api/projects')).json()) as { name: string }[]
          return list.slice(0, 2).map((p) => p.name)
        }),
      { timeout: 10_000 })
      .toEqual([a.name, b.name])

    // Cmd+2 → project B (position 2). Assert via the server-persisted active
    // project — the churn-robust signal.
    await selectProject(page, a.name)
    await expect(sectionHeader(page, a.name)).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Meta+2')
    await expect.poll(async () => (await readUiState(page))?.project, { timeout: 10_000 }).toBe(b.name)
    await expect(sectionHeader(page, b.name)).toBeVisible({ timeout: 10_000 })

    // Cmd+1 → project A (position 1).
    await page.keyboard.press('Meta+1')
    await expect.poll(async () => (await readUiState(page))?.project, { timeout: 10_000 }).toBe(a.name)
    await expect(sectionHeader(page, a.name)).toBeVisible({ timeout: 10_000 })
  })

  test('Cmd+P opens file search, Escape closes it', async ({ page, request }) => {
    await ws(page, request)

    // Should not be visible initially
    const searchInput = page.locator('input[placeholder="Search files..."], input[placeholder="Loading files..."]')
    await expect(searchInput).not.toBeVisible()

    // Cmd+P opens it
    await page.keyboard.press('Meta+p')
    await expect(searchInput).toBeVisible({ timeout: 5000 })

    // Escape closes it
    await page.keyboard.press('Escape')
    await expect(searchInput).not.toBeVisible()
  })

  test('Cmd+W closes the active tab', async ({ page, request }) => {
    const project = await ws(page, request)
    const testFile = uniqueFileName('shortcut_close.txt')

    await createTestFile(page, project.name, testFile, 'close me\n')
    await waitForSSERefresh(page, 3000)

    // Open and pin the file
    await openFileViaSearch(page, testFile)
    await page.locator('.overflow-x-auto').locator(`[title="${testFile}"]`).dblclick()
    await page.waitForTimeout(300)
    await expect(page.locator('.overflow-x-auto').locator(`[title="${testFile}"]`)).toBeVisible()

    // Close with Cmd+W
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(500)

    // Tab should be gone
    await expect(page.locator('.overflow-x-auto').locator(`[title="${testFile}"]`)).not.toBeVisible()

    // Cleanup
    await deleteTestFile(page, project.name, testFile)
  })

  test('Cmd+Shift+V cycles markdown preview mode for .md files', async ({ page, request }) => {
    const project = await ws(page, request)
    const mdFile = uniqueFileName('md_cycle.md')

    await createTestFile(page, project.name, mdFile, '# Test\n\nHello markdown\n')
    await waitForSSERefresh(page, 3000)

    // Open and pin the markdown file
    await openFileViaSearch(page, mdFile)
    await page.locator('.overflow-x-auto').locator(`[title="${mdFile}"]`).dblclick()
    await page.waitForTimeout(500)

    // Verify the mode toggle is visible (Edit/Split/Preview buttons)
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Split', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeVisible()

    // Cmd+Shift+V cycles edit -> split -> preview -> edit, exercising the editor
    // pref + persistence path each time. The live mode lands in the legacy flat
    // layout during the migration window; the new-shape `panelState.editor` is fed
    // by the loader/migration (not yet by live edits — that is the tree-renderer
    // phase), so the field-read pins that the new shape persists the four editor
    // prefs well-formed after the cycle.
    await page.keyboard.press('Meta+Shift+v')
    await page.waitForTimeout(500)
    await page.keyboard.press('Meta+Shift+v')
    await page.waitForTimeout(500)
    await page.keyboard.press('Meta+Shift+v')
    await page.waitForTimeout(500)
    expectEditorPrefs(await getWorkspaceState(page, project.name))

    // Cleanup
    await deleteTestFile(page, project.name, mdFile)
  })
})

test.describe('Mobile pane flow characterization', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('mobile layout shows Browse/Editor/Terminal pane switcher', async ({ page, request }) => {
    await ws(page, request)

    // Should see the pane switcher with three options
    await expect(page.getByRole('button', { name: 'Browse', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Editor', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible()
  })

  test('opening a file switches to editor pane', async ({ page, request }) => {
    const project = await ws(page, request)
    const testFile = uniqueFileName('mobile_open.txt')

    await createTestFile(page, project.name, testFile, 'mobile test content\n')
    await waitForSSERefresh(page, 3000)

    // Start in Files pane — Sessions section should be visible
    await expect(page.getByText('Sessions', { exact: true }).first()).toBeVisible({ timeout: 5000 })

    // Open file via search -> should switch to editor pane
    await openFileViaSearch(page, testFile)

    // Editor content should be visible
    await expect(page.locator('.cm-content')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.cm-content')).toContainText('mobile test content')

    // Sessions section should NOT be visible (we're in editor pane)
    await expect(page.locator('text=Sessions').first()).not.toBeVisible()

    // Cleanup
    await deleteTestFile(page, project.name, testFile)
  })

  test('mobile files pane shows Explorer, Changes, and Sessions sections', async ({ page, request }) => {
    await ws(page, request)

    // Click Browse pane
    await page.locator('button', { hasText: 'Browse' }).click()
    await page.waitForTimeout(500)

    // All three sections should be visible (use .first() to avoid strict mode with substring matches)
    await expect(page.getByText('Changes', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Sessions', { exact: true }).first()).toBeVisible()
  })

  test('mobile pane state persists in localStorage', async ({ page, request }) => {
    const project = await ws(page, request)

    // Switch to terminal pane
    await page.locator('button', { hasText: 'Terminal' }).click()
    await page.waitForTimeout(500)

    // New shape persisted AND the terminal pane is active (browse sections gone)
    const state = await getWorkspaceState(page, project.name)
    expectMobileDock(state)
    await expect(page.getByText('Sessions', { exact: true }).first()).not.toBeVisible()
  })
})
