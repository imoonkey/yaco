import { test, expect, type Page } from '@playwright/test'
import { createWorktreeFixture, selectProject, type FixtureProject } from './helpers/workspace'

async function fetchTasks(page: Page, projectName: string) {
  return page.evaluate(async (name: string) => {
    const res = await fetch(`/api/tasks/${encodeURIComponent(name)}`)
    return res.json() as Promise<{ tasks: Record<string, unknown> }>
  }, projectName)
}

// Each test provisions its own isolated git project (unique per run) with a task
// graph that exposes three worktree shapes. The phantom `worktree-qa` fixture this
// replaces was never registered in `~/.yaco`, so these specs round-tripped nothing.
test.describe('Worktree features', () => {
  let fixture: FixtureProject

  test.beforeEach(async ({ page, request }) => {
    fixture = await createWorktreeFixture(request)
    await page.goto('/')
    await expect(page.locator('button', { hasText: fixture.name })).toBeVisible({ timeout: 10_000 })
  })

  test.afterEach(async () => {
    await fixture?.dispose()
  })

  test('task API returns worktreeStatus for tasks with worktree field', async ({ page }) => {
    await selectProject(page, fixture.name)
    const { tasks } = await fetchTasks(page, fixture.name)

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
    await selectProject(page, fixture.name)
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
    await selectProject(page, fixture.name)
    await page.waitForTimeout(2000)

    // Click on auth-v2 worktree in sidebar
    const sidebar = page.locator('.flex.flex-col.gap-0\\.5.px-1.py-1')
    const authWorktree = sidebar.locator('button', { hasText: 'auth-v2' }).last()
    await expect(authWorktree).toBeVisible({ timeout: 10_000 })
    await authWorktree.click()
    await page.waitForTimeout(2000)

    // File explorer should show the worktree's src/ directory
    const fileTree = page.locator('[role="tree"]')
    await expect(fileTree).toBeVisible({ timeout: 5_000 })
    await expect(fileTree.locator('text=src')).toBeVisible({ timeout: 5_000 })

    // Click the project name again to switch back to main checkout
    await page.locator('button', { hasText: fixture.name }).first().click()
    await page.waitForTimeout(1500)

    // File explorer should be back at the main project — src/ should still be visible
    await expect(fileTree.locator('text=src')).toBeVisible({ timeout: 5_000 })
  })
})

// Worktree metadata is surfaced through the GRAPH path: open the task workspace,
// click a worktree-bearing task node, and read its detail panel. Runs against the
// isolated per-run fixture whose auth-v2 root task carries an active worktree.
test.describe('Worktree metadata via the task graph', () => {
  let fixture: FixtureProject

  test.beforeEach(async ({ request }) => {
    fixture = await createWorktreeFixture(request)
  })

  test.afterEach(async () => {
    await fixture?.dispose()
  })

  test('detail panel shows worktree label, branch, and status badge', async ({ page }) => {
    await page.goto('/')
    await selectProject(page, fixture.name)

    // Open the task workspace for the fixture project.
    await page.evaluate((name: string) => localStorage.removeItem(`yaco-task-workspace:${name}`), fixture.name)
    await page.keyboard.press('Meta+Shift+t')
    await expect(page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"]').first()).toBeVisible({ timeout: 15_000 })

    // Double-click the worktree-bearing task node → detail panel opens.
    await page.locator('g[role="button"][aria-label^="Task: Auth v2, status:"]').first().dblclick()
    const panel = page.getByRole('complementary', { name: 'Task details' })
    await expect(panel).toBeVisible({ timeout: 3_000 })

    // Worktree metadata: section label, worktree/branch name, and Active badge.
    await expect(panel.getByText('Worktree', { exact: true })).toBeVisible()
    await expect(panel.getByText('auth-v2', { exact: true }).first()).toBeVisible()
    await expect(panel.getByText('task/auth-v2', { exact: true })).toBeVisible()
    await expect(panel.getByText('Active', { exact: true })).toBeVisible()
  })
})
