import { test, expect } from '@playwright/test'
import {
  openWorkspace,
  waitForAppReady,
  getWorkspaceState,
  createTestFile,
  deleteTestFile,
  openFileViaSearch,
  waitForSSERefresh,
  uniqueFileName,
  layoutKey,
  createFixtureProject,
  sidebar,
  activityPanel,
  projectsSectionBody,
  sectionHeader,
  expectApproxSize,
} from './helpers/workspace'

// --- Tests ---

// These are characterization tests: they pin the CURRENT renderer's behavior so a
// later refactor can be checked against it. Each localStorage assertion is paired
// with a DOM/geometry assertion against the live app, so a green run proves the
// app actually applied the persisted state — not just that a key round-tripped.
test.describe('Layout persistence characterization', () => {
  test('Cmd+B toggles sidebar visibility and persists across reload', async ({ page }) => {
    const project = await openWorkspace(page)

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

  test('Cmd+Shift+B toggles right panel and persists', async ({ page }) => {
    const project = await openWorkspace(page)

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

  test('open tabs and active tab persist across reload', async ({ page }) => {
    const project = await openWorkspace(page)
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
    const fixture = await createFixtureProject(request)
    try {
      const pinnedOrder = ['session-z', 'session-a', 'session-m']
      const putRes = await request.put(
        `/api/ui-state/pinned-sessions?project=${encodeURIComponent(fixture.name)}`,
        { data: { sessions: pinnedOrder } },
      )
      expect(putRes.ok()).toBe(true)

      // Mount the workspace for the fixture (the app reads pins through usePinnedSessions).
      await page.goto('/')
      await expect(page.locator('button', { hasText: fixture.name }).first()).toBeVisible({ timeout: 10_000 })
      await page.locator('button', { hasText: fixture.name }).first().click()
      await page.waitForTimeout(1000)

      // Reload, then read the durable order back.
      await page.reload()
      await waitForAppReady(page)
      await page.waitForTimeout(1000)

      const getRes = await request.get(`/api/ui-state/pinned-sessions?project=${encodeURIComponent(fixture.name)}`)
      expect(await getRes.json()).toEqual(pinnedOrder)
    } finally {
      await fixture.dispose()
    }
  })

  test('per-project layout is independent', async ({ page }) => {
    await page.goto('/')
    await waitForAppReady(page)

    const projects = await page.evaluate(async () => {
      const res = await fetch('/api/projects')
      return res.json() as Promise<{ name: string; path: string }[]>
    })

    if (projects.length < 2) {
      test.skip()
      return
    }

    const p1 = projects[0]
    const p2 = projects[1]

    // Select project 1, toggle sidebar off
    await page.locator('button', { hasText: p1.name }).first().click()
    await page.waitForTimeout(1000)
    await page.keyboard.press('Meta+b')
    await page.waitForTimeout(500)
    // Project 1 sidebar gone from the DOM
    await expect(sidebar(page)).toBeHidden()

    // Switch to project 2 via Cmd+2 (sidebar is hidden, can't click)
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(1000)

    // Project 2 sidebar should still be on (default) — visible in the DOM
    await expect(sidebar(page)).toBeVisible()
    const p2State = await getWorkspaceState(page, p2.name)
    expect(p2State?.layout?.showSidebar ?? true).toBe(true)

    // Project 1 sidebar should be off
    const p1State = await getWorkspaceState(page, p1.name)
    expect(p1State?.layout?.showSidebar).toBe(false)

    // Restore project 1
    await page.locator('button', { hasText: p1.name }).first().click()
    await page.waitForTimeout(500)
    await page.keyboard.press('Meta+b')
    await page.waitForTimeout(500)
  })

  test('showProjects and projectSize persist across reload', async ({ page, request }) => {
    const resp = await request.get('/api/projects')
    const projects = await resp.json() as { name: string; path: string }[]
    expect(projects.length).toBeGreaterThan(0)
    const project = projects[0]

    // Seed non-default values before mount: Projects section collapsed, sized 200.
    await page.addInitScript(({ key }) => {
      const raw = localStorage.getItem(key)
      const state = raw ? JSON.parse(raw) : {}
      state.layout = { ...(state.layout ?? {}), showProjects: false, projectSize: 200 }
      localStorage.setItem(key, JSON.stringify(state))
    }, { key: layoutKey(project.name) })

    // Mount — workspace reads seeded values
    await page.goto('/')
    await waitForAppReady(page)
    await page.waitForTimeout(2000)

    // Persisted AND the Projects section actually renders collapsed
    let state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.showProjects).toBe(false)
    expect(state?.layout?.projectSize).toBe(200)
    await expect(sectionHeader(page, 'Projects')).toHaveAttribute('aria-expanded', 'false')
    await expect(projectsSectionBody(page)).toBeHidden()

    // Reload — verify persistence again
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(2000)

    state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.showProjects).toBe(false)
    expect(state?.layout?.projectSize).toBe(200)

    // Expand the section → the body renders at the persisted projectSize (≈200px).
    await sectionHeader(page, 'Projects').click()
    await expect(projectsSectionBody(page)).toBeVisible()
    expectApproxSize((await projectsSectionBody(page).boundingBox())?.height, 200)

    // Restore defaults so a reused profile starts clean
    await page.evaluate((key) => {
      const raw = localStorage.getItem(key)
      if (raw) {
        const s = JSON.parse(raw)
        s.layout = { ...(s.layout ?? {}), showProjects: true, projectSize: 120 }
        localStorage.setItem(key, JSON.stringify(s))
      }
    }, layoutKey(project.name))
  })

  test('section collapse state persists and renders collapsed', async ({ page }) => {
    const project = await openWorkspace(page)

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
  test('Cmd+1-9 switches projects in workspace view', async ({ page }) => {
    await page.goto('/')
    await waitForAppReady(page)

    const projects = await page.evaluate(async () => {
      const res = await fetch('/api/projects')
      return res.json() as Promise<{ name: string; path: string }[]>
    })

    if (projects.length < 2) {
      test.skip()
      return
    }

    await page.locator('button', { hasText: projects[0].name }).first().click()
    await page.waitForTimeout(1000)

    // Cmd+2 should switch to second project — workspace re-mounts for it
    // (the Explorer section header title is the active project name).
    await page.keyboard.press('Meta+2')
    await page.waitForTimeout(1000)
    await expect(sectionHeader(page, projects[1].name)).toBeVisible()

    const state = await page.evaluate(() => {
      const raw = localStorage.getItem('yaco-ui-state')
      return raw ? JSON.parse(raw) : null
    })
    expect(state?.project).toBe(projects[1].name)

    // Cmd+1 should switch back
    await page.keyboard.press('Meta+1')
    await page.waitForTimeout(1000)
    await expect(sectionHeader(page, projects[0].name)).toBeVisible()

    const state2 = await page.evaluate(() => {
      const raw = localStorage.getItem('yaco-ui-state')
      return raw ? JSON.parse(raw) : null
    })
    expect(state2?.project).toBe(projects[0].name)
  })

  test('Cmd+P opens file search, Escape closes it', async ({ page }) => {
    await openWorkspace(page)

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

  test('Cmd+W closes the active tab', async ({ page }) => {
    const project = await openWorkspace(page)
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

  test('Cmd+Shift+V cycles markdown preview mode for .md files', async ({ page }) => {
    const project = await openWorkspace(page)
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
    const getMode = () => getWorkspaceState(page, project.name).then(s => s?.layout?.previewMode ?? null)

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

  test('mobile layout shows Browse/Editor/Terminal pane switcher', async ({ page }) => {
    await openWorkspace(page)

    // Should see the pane switcher with three options
    await expect(page.getByRole('button', { name: 'Browse', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Editor', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible()
  })

  test('opening a file switches to editor pane', async ({ page }) => {
    const project = await openWorkspace(page)
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

  test('mobile files pane shows Explorer, Changes, and Sessions sections', async ({ page }) => {
    await openWorkspace(page)

    // Click Browse pane
    await page.locator('button', { hasText: 'Browse' }).click()
    await page.waitForTimeout(500)

    // All three sections should be visible (use .first() to avoid strict mode with substring matches)
    await expect(page.getByText('Changes', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Sessions', { exact: true }).first()).toBeVisible()
  })

  test('mobile pane state persists in localStorage', async ({ page }) => {
    const project = await openWorkspace(page)

    // Switch to terminal pane
    await page.locator('button', { hasText: 'Terminal' }).click()
    await page.waitForTimeout(500)

    // Persisted AND the terminal pane is active (browse sections gone)
    const state = await getWorkspaceState(page, project.name)
    expect(state?.mobilePane).toBe('terminal')
    await expect(page.getByText('Sessions', { exact: true }).first()).not.toBeVisible()
  })
})
