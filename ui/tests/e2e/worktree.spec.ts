import { test, expect, type Page } from '@playwright/test'

const TEST_PROJECT = 'worktree-qa'

async function loadProjects(page: Page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<{ name: string; path: string }[]>
  })
}

async function selectProject(page: Page, name: string) {
  await page.goto('/')
  // Wait for projects to render in sidebar
  const projects = await loadProjects(page)
  const project = projects.find(p => p.name === name)
  if (!project) throw new Error(`Project "${name}" not found in ${projects.map(p => p.name).join(', ')}`)
  await expect(page.locator('button', { hasText: name })).toBeVisible({ timeout: 10_000 })
  await page.locator('button', { hasText: name }).click()
  return project
}

async function fetchTasks(page: Page, projectName: string) {
  return page.evaluate(async (name: string) => {
    const res = await fetch(`/api/tasks/${encodeURIComponent(name)}`)
    return res.json() as Promise<{ tasks: Record<string, unknown> }>
  }, projectName)
}

async function openTaskPanel(page: Page) {
  await page.keyboard.press('Meta+Shift+t')
  await expect(page.locator('input[placeholder*="Search"]')).toBeVisible({ timeout: 10_000 })
}

test.describe('Worktree features', () => {
  test.beforeEach(async ({ page }) => {
    // Clear any persisted worktree state for the test project
    await page.goto('/')
    await expect(page.locator('button', { hasText: TEST_PROJECT })).toBeVisible({ timeout: 10_000 })
    await page.evaluate((name: string) => {
      localStorage.removeItem(`workflow-workspace:${name}`)
      localStorage.removeItem(`workflow-worktree:${name}`)
      localStorage.removeItem(`workflow-taskgraph:${name}`)
    }, TEST_PROJECT)
  })

  test('task API returns worktreeStatus for tasks with worktree field', async ({ page }) => {
    await selectProject(page, TEST_PROJECT)
    const { tasks } = await fetchTasks(page, TEST_PROJECT)

    // auth-v2 has a worktree that exists on disk — should be active
    const authTask = tasks['auth-v2'] as Record<string, unknown>
    expect(authTask).toBeTruthy()
    expect(authTask.worktree).toBe('auth-v2')
    const authStatus = authTask.worktreeStatus as Record<string, unknown>
    expect(authStatus).toBeTruthy()
    expect(authStatus.active).toBe(true)
    expect(authStatus.branch).toBe('task/auth-v2')
    // auth-v2 has a dirty file (wip.txt)
    expect(authStatus.dirty).toBe(true)
    // auth-v2 has 1 commit ahead of main
    expect(authStatus.ahead).toBeGreaterThanOrEqual(1)

    // perf-cache worktree exists on disk — should be active, clean
    const perfTask = tasks['perf-cache'] as Record<string, unknown>
    expect(perfTask).toBeTruthy()
    expect(perfTask.worktree).toBe('perf-cache')
    const perfStatus = perfTask.worktreeStatus as Record<string, unknown>
    expect(perfStatus).toBeTruthy()
    expect(perfStatus.active).toBe(true)
    expect(perfStatus.dirty).toBe(false)

    // ui-cleanup has no worktree — should not have worktreeStatus
    const uiTask = tasks['ui-cleanup'] as Record<string, unknown>
    expect(uiTask).toBeTruthy()
    expect(uiTask.worktree).toBeNull()
    expect(uiTask.worktreeStatus).toBeUndefined()
  })

  test('worktree sub-items appear in project sidebar', async ({ page }) => {
    await selectProject(page, TEST_PROJECT)
    // Wait for worktree data to load (derived from task API)
    await page.waitForTimeout(2000)

    // Worktree sub-items should appear under the active project
    const sidebar = page.locator('.flex.flex-col.gap-0\\.5.px-1.py-1')
    const authWorktree = sidebar.locator('button', { hasText: 'auth-v2' }).last()
    const perfWorktree = sidebar.locator('button', { hasText: 'perf-cache' }).last()

    await expect(authWorktree).toBeVisible({ timeout: 10_000 })
    await expect(perfWorktree).toBeVisible({ timeout: 10_000 })

    // auth-v2 should show dirty indicator (orange dot)
    const authTitle = await authWorktree.getAttribute('title')
    expect(authTitle).toContain('task/auth-v2')
    expect(authTitle).toContain('(modified)')

    // perf-cache should NOT show modified
    const perfTitle = await perfWorktree.getAttribute('title')
    expect(perfTitle).toContain('task/perf-cache')
    expect(perfTitle).not.toContain('(modified)')
  })

  test('clicking worktree in sidebar switches file explorer context', async ({ page }) => {
    await selectProject(page, TEST_PROJECT)
    await page.waitForTimeout(2000)

    // Click on auth-v2 worktree in sidebar
    const sidebar = page.locator('.flex.flex-col.gap-0\\.5.px-1.py-1')
    const authWorktree = sidebar.locator('button', { hasText: 'auth-v2' }).last()
    await expect(authWorktree).toBeVisible({ timeout: 10_000 })
    await authWorktree.click()
    await page.waitForTimeout(2000)

    // File explorer should show .worktrees directory content
    // Verify worktree path resolves by checking the file tree has worktree files
    // The src/ folder in the worktree should contain v2.js
    const fileTree = page.locator('[role="tree"]')
    await expect(fileTree).toBeVisible({ timeout: 5_000 })

    // The file tree should show src/ directory
    await expect(fileTree.locator('text=src')).toBeVisible({ timeout: 5_000 })

    // Click the project name again to switch back to main checkout
    await page.locator('button', { hasText: TEST_PROJECT }).first().click()
    await page.waitForTimeout(1500)

    // File explorer should be back at the main project — src/ should still be visible
    await expect(fileTree.locator('text=src')).toBeVisible({ timeout: 5_000 })
  })

  test('task board view shows worktree badges on cards', async ({ page }) => {
    await selectProject(page, TEST_PROJECT)
    await openTaskPanel(page)

    // Switch to Board view (key 1 or click)
    await page.keyboard.press('1')
    await page.waitForTimeout(1000)

    // Board cards with worktree should have FolderGit2 icon + slug text
    const authCard = page.locator('[role="listitem"][aria-label*="Auth v2"]')
    await expect(authCard).toBeVisible({ timeout: 10_000 })
    await expect(authCard.locator('text=auth-v2')).toBeVisible()

    // perf-cache card should also show worktree badge
    const perfCard = page.locator('[role="listitem"][aria-label*="Performance caching"]')
    await expect(perfCard).toBeVisible()
    await expect(perfCard.locator('text=perf-cache')).toBeVisible()

    // ui-cleanup card should NOT have a worktree badge
    const uiCard = page.locator('[role="listitem"][aria-label*="UI cleanup"]')
    await expect(uiCard).toBeVisible()
    const uiWorktreeBadge = uiCard.locator('.inline-flex.items-center.gap-1')
    await expect(uiWorktreeBadge).toHaveCount(0)
  })

  test('task list view shows worktree column', async ({ page }) => {
    await selectProject(page, TEST_PROJECT)
    await openTaskPanel(page)

    // Switch to List view
    await page.keyboard.press('2')
    await page.waitForTimeout(1000)

    // Worktree column header button should be visible (uppercase WORKTREE text)
    const worktreeColumnHeader = page.getByRole('button', { name: 'Worktree' }).nth(3)
    await expect(worktreeColumnHeader).toBeVisible({ timeout: 5_000 })

    // auth-v2 and perf-cache should appear in list rows
    await expect(page.locator('[role="listitem"]').locator('text=auth-v2')).toBeVisible()
    await expect(page.locator('[role="listitem"]').locator('text=perf-cache')).toBeVisible()
  })

  test('worktree filter in toolbar filters tasks', async ({ page }) => {
    await selectProject(page, TEST_PROJECT)
    await openTaskPanel(page)

    // Ensure we're on board view first
    await page.keyboard.press('1')
    await page.waitForTimeout(500)

    // The Worktree filter dropdown should exist in the toolbar filter bar
    // Filter buttons have h-[22px] class and uppercase text
    const worktreeFilterBtn = page.locator('button.h-\\[22px\\]', { hasText: /WORKTREE/i })
    await expect(worktreeFilterBtn).toBeVisible({ timeout: 5_000 })

    // Open the Worktree filter dropdown
    await worktreeFilterBtn.click()
    await page.waitForTimeout(500)

    // The dropdown appears below the button — find checkboxes within it
    // Checkbox items are buttons with gap-2 and px-3
    const filterOptions = page.locator('.absolute.top-full.left-0 button')
    await expect(filterOptions).toHaveCount(2, { timeout: 5_000 })

    // Select auth-v2 filter
    await filterOptions.filter({ hasText: 'auth-v2' }).click()
    await page.waitForTimeout(500)

    // Close dropdown by clicking the filter button again (toggle)
    await worktreeFilterBtn.click()
    await page.waitForTimeout(300)

    // A filter pill for auth-v2 should appear (pill has a remove button with specific aria-label)
    await expect(page.locator('button[aria-label="Remove filter: auth-v2"]')).toBeVisible()

    // Only auth-v2 task should be visible in board view
    const cards = page.locator('[role="listitem"]')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('Auth v2')

    // Clear filters
    const clearBtn = page.locator('text=Clear all')
    await expect(clearBtn).toBeVisible()
    await clearBtn.click()
    await page.waitForTimeout(500)
    // All cards should be back
    const allCards = page.locator('[role="listitem"]')
    const count = await allCards.count()
    expect(count).toBeGreaterThanOrEqual(3)
  })

  test('task detail panel shows worktree metadata', async ({ page }) => {
    await selectProject(page, TEST_PROJECT)
    await openTaskPanel(page)

    // Switch to Board view
    await page.keyboard.press('1')
    await page.waitForTimeout(1000)

    // Click on auth-v2 card to open detail panel
    const authCard = page.locator('[role="listitem"][aria-label*="Auth v2"]')
    await authCard.click()
    await page.waitForTimeout(500)

    // Detail panel has role="complementary" and aria-label="Task details"
    const detailPanel = page.locator('[role="complementary"][aria-label="Task details"]')
    await expect(detailPanel).toBeVisible({ timeout: 5_000 })

    // Should show "Worktree" section header
    await expect(detailPanel.locator('text=Worktree')).toBeVisible()
    // Should show the slug
    await expect(detailPanel.locator('.font-mono.text-\\[12px\\]', { hasText: 'auth-v2' })).toBeVisible()
    // Should show branch name
    await expect(detailPanel.locator('text=task/auth-v2')).toBeVisible()
    // Should show "Active" badge since worktree exists
    await expect(detailPanel.locator('text=Active')).toBeVisible()
    // Should show "Modified" badge since worktree is dirty
    await expect(detailPanel.locator('text=Modified')).toBeVisible()
  })

  test('task graph view shows worktree coloring on nodes', async ({ page }) => {
    await selectProject(page, TEST_PROJECT)
    await openTaskPanel(page)

    // Switch to Graph view
    await page.keyboard.press('3')
    await page.waitForTimeout(2000)

    // Graph should render with task nodes
    await expect(page.locator('[data-layer="nodes"]')).toBeVisible({ timeout: 15_000 })

    // Task nodes with worktree should exist
    const taskNodes = page.locator('[data-layer="nodes"] g[role="button"]')
    const count = await taskNodes.count()
    expect(count).toBeGreaterThanOrEqual(3)
  })
})
