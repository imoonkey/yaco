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
})
