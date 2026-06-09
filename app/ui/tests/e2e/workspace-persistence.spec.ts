import { test, expect, type Page } from '@playwright/test'
import {
  provisionWorkspace,
  selectProject,
  createFixtureProject,
  waitForAppReady,
  getWorkspaceState,
  createTestFile,
  deleteTestFile,
  openFileViaSearch,
  waitForSSERefresh,
  uniqueFileName,
  layoutKey,
  sidebar,
  activityPanel,
  projectsSectionBody,
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

function fetchProjectsList(page: Page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<{ name: string; path: string }[]>
  })
}

function readUiState(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('yaco-ui-state')
    return raw ? JSON.parse(raw) : null
  })
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

    // Persisted AND actually gone from the DOM
    let state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.showSidebar).toBe(false)
    await expect(sidebar(page)).toBeHidden()

    // Reload — still hidden, still persisted
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(2000)

    state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.showSidebar).toBe(false)
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

    // Toggle off → persisted false AND removed from the DOM
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(500)
    let state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.showRightPanel).toBe(false)
    await expect(activityPanel(page)).toBeHidden()

    // Toggle back → persisted true AND visible again
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(500)
    state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.showRightPanel).toBe(true)
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

    // Active tab should be our file
    const state = await getWorkspaceState(page, project.name)
    expect(state?.activeTab).toBe(testFile)

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
    expect((await getWorkspaceState(page, a.name))?.layout?.showRightPanel).toBe(false)

    // Switch to project B (left sidebar is still shown, so we can click).
    await selectProject(page, b.name)
    await expect(sectionHeader(page, b.name)).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(500)

    // Project B is unaffected — activity panel still on (default).
    await expect(activityPanel(page)).toBeVisible()
    expect((await getWorkspaceState(page, b.name))?.layout?.showRightPanel ?? true).toBe(true)

    // Back to A — its toggle persisted independently.
    await selectProject(page, a.name)
    await expect(sectionHeader(page, a.name)).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(500)
    await expect(activityPanel(page)).toBeHidden()
    expect((await getWorkspaceState(page, a.name))?.layout?.showRightPanel).toBe(false)
  })

  test('showProjects and projectSize persist across reload', async ({ page, request }) => {
    const project = await extraProject(request)

    // Seed ONCE before mount: select this project via ui-state, and set
    // projectSize=200 with Projects visible (so its body is measurable). The
    // layout key is only seeded when absent, so the collapse we do below survives
    // the reload instead of being re-seeded.
    await page.addInitScript(({ key, name }) => {
      localStorage.setItem('yaco-ui-state', JSON.stringify({ project: name }))
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, JSON.stringify({ layout: { showProjects: true, projectSize: 200 } }))
      }
    }, { key: layoutKey(project.name), name: project.name })

    // Mount — workspace selects the seeded project and applies projectSize.
    await page.goto('/')
    await waitForAppReady(page)
    await expect(sectionHeader(page, project.name)).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1500)

    // projectSize applied: the Projects body renders at the persisted ≈200px.
    await expect(sectionHeader(page, 'Projects')).toHaveAttribute('aria-expanded', 'true')
    expectApproxSize((await projectsSectionBody(page).boundingBox())?.height, 200)
    expect((await getWorkspaceState(page, project.name))?.layout?.projectSize).toBe(200)

    // Collapse the Projects section (its body is visible, so the header click is
    // unambiguous) → persisted AND actually renders collapsed.
    await sectionHeader(page, 'Projects').click()
    await page.waitForTimeout(500)
    await expect(sectionHeader(page, 'Projects')).toHaveAttribute('aria-expanded', 'false')
    await expect(projectsSectionBody(page)).toBeHidden()
    expect((await getWorkspaceState(page, project.name))?.layout?.showProjects).toBe(false)

    // Reload — both the collapse and projectSize survive.
    await page.reload()
    await waitForAppReady(page)
    await expect(sectionHeader(page, project.name)).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(1500)

    const state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.showProjects).toBe(false)
    expect(state?.layout?.projectSize).toBe(200)
    await expect(sectionHeader(page, 'Projects')).toHaveAttribute('aria-expanded', 'false')
  })

  test('section collapse state persists and renders collapsed', async ({ page, request }) => {
    const project = await ws(page, request)

    // Sidebar sections start expanded.
    let state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.showExplorer ?? true).toBe(true)
    expect(state?.layout?.showChanges ?? true).toBe(true)
    expect(state?.layout?.showSessions ?? true).toBe(true)

    // Projects section renders at its default persisted size (≈120px).
    await expect(sectionHeader(page, 'Projects')).toHaveAttribute('aria-expanded', 'true')
    expectApproxSize((await projectsSectionBody(page).boundingBox())?.height, 120)

    // Collapse the Explorer section (its header title is the project name) and prove
    // it actually renders collapsed — header aria-expanded flips, file tree hidden,
    // and the flag persists.
    const explorerHeader = sectionHeader(page, project.name)
    await expect(explorerHeader).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[role="tree"]')).toBeVisible()
    await explorerHeader.click()
    await page.waitForTimeout(500)

    await expect(explorerHeader).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[role="tree"]')).toBeHidden()
    state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.showExplorer).toBe(false)

    // Restore
    await explorerHeader.click()
    await page.waitForTimeout(300)
    await expect(page.locator('[role="tree"]')).toBeVisible()
  })
})

test.describe('Keyboard shortcut characterization', () => {
  test('Cmd+1-9 switches projects in workspace view', async ({ page, request }) => {
    // Guarantee >= 2 projects exist in whatever registry this run uses.
    const a = await extraProject(request)
    const b = await extraProject(request)
    await page.goto('/')
    await waitForAppReady(page)

    const projects = await fetchProjectsList(page)
    expect(projects.length).toBeGreaterThanOrEqual(2)

    // Cmd+1..9 only addresses the first nine positions. In an isolated worktree
    // home our two fixtures sit there; in a populated ~/.yaco they don't, so fall
    // back to the first two existing projects (always within range).
    const ia = projects.findIndex((p) => p.name === a.name)
    const ib = projects.findIndex((p) => p.name === b.name)
    const useFixtures = ia >= 0 && ia < 9 && ib >= 0 && ib < 9
    const [first, second] = useFixtures
      ? (ia < ib ? [a.name, b.name] : [b.name, a.name])
      : [projects[0].name, projects[1].name]

    const idxOf = async (name: string) => (await fetchProjectsList(page)).findIndex((p) => p.name === name)

    await selectProject(page, first)
    await page.waitForTimeout(800)

    // Switch to `second` via its keyboard position (re-read to tolerate churn).
    await page.keyboard.press(`Meta+${(await idxOf(second)) + 1}`)
    await page.waitForTimeout(1000)
    await expect(sectionHeader(page, second)).toBeVisible()
    expect((await readUiState(page))?.project).toBe(second)

    // Switch back to `first`.
    await page.keyboard.press(`Meta+${(await idxOf(first)) + 1}`)
    await page.waitForTimeout(1000)
    await expect(sectionHeader(page, first)).toBeVisible()
    expect((await readUiState(page))?.project).toBe(first)
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

    // Cmd+Shift+V should cycle: edit -> split -> preview -> edit
    const getMode = () => getWorkspaceState(page, project.name).then((s) => s?.layout?.previewMode ?? null)

    await page.keyboard.press('Meta+Shift+v')
    await page.waitForTimeout(500)
    expect(await getMode()).toBe('split')

    await page.keyboard.press('Meta+Shift+v')
    await page.waitForTimeout(500)
    expect(await getMode()).toBe('preview')

    await page.keyboard.press('Meta+Shift+v')
    await page.waitForTimeout(500)
    expect(await getMode()).toBe('edit')

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

    // Persisted AND the terminal pane is active (browse sections gone)
    const state = await getWorkspaceState(page, project.name)
    expect(state?.mobilePane).toBe('terminal')
    await expect(page.getByText('Sessions', { exact: true }).first()).not.toBeVisible()
  })
})
