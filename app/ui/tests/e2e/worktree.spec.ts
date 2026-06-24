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

  // Worktree selection moved from the ProjectList sub-list to a HEADER-TOGGLED picker
  // inside the File Explorer panel, mirroring the Changes "Compare ref" mode (design
  // §P2/§P2b/§P2c): a GitBranch toggle in the Files header reveals an in-panel list
  // (HIDDEN by default); selecting re-roots the explorer AND closes the picker; an X
  // in the header exits. These specs drive those REAL affordances — the toggle, the X,
  // and the rows the user clicks — and assert the observable outcome (the listed
  // worktrees, the explorer re-rooting, the picker opening/closing).
  const worktreeToggle = (page: Page) => page.getByLabel('Select worktree')
  const worktreeList = (page: Page) => page.getByRole('listbox', { name: 'Worktrees' })
  async function openWorktreePicker(page: Page) {
    await expect(worktreeToggle(page)).toBeVisible({ timeout: 10_000 })
    await worktreeToggle(page).click()
    await expect(worktreeList(page)).toBeVisible({ timeout: 5_000 })
  }

  test('the Files header toggle reveals an in-panel list of every git worktree (hidden by default)', async ({ page }) => {
    await selectProject(page, fixture.name)

    // HIDDEN by default: the toggle is in the header, but the list is not rendered
    // until it is clicked.
    await expect(worktreeToggle(page)).toBeVisible({ timeout: 10_000 })
    await expect(worktreeList(page)).toHaveCount(0)

    await openWorktreePicker(page)
    const list = worktreeList(page)
    // git-sourced list: both linked worktrees by branch, plus the primary chip.
    await expect(list.getByText('task/auth-v2', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(list.getByText('task/perf-cache', { exact: true })).toBeVisible()
    await expect(list.getByText('primary', { exact: true })).toBeVisible()

    // The header X exits without selecting — the list closes, the toggle resets.
    await page.getByLabel('Close worktree picker').click()
    await expect(worktreeList(page)).toHaveCount(0)
    await expect(worktreeToggle(page)).toBeVisible()
  })

  test('selecting a worktree in the Files panel re-roots the file explorer AND closes the picker', async ({ page }) => {
    await selectProject(page, fixture.name)
    await openWorktreePicker(page)

    // Pick the auth-v2 worktree. Its tree contains `wip.txt` (untracked at the
    // worktree root) which exists ONLY in that worktree — asserting on it proves
    // the click actually re-rooted the explorer (a `src/` check would pass either
    // way). Selecting also closes the picker (mirrors Compare ref's exit).
    await worktreeList(page).getByRole('option').filter({ hasText: 'task/auth-v2' }).click()
    await expect(worktreeList(page)).toHaveCount(0)
    const fileTree = page.locator('[role="tree"]')
    await expect(fileTree).toBeVisible({ timeout: 5_000 })
    await expect(fileTree.getByText('wip.txt', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Switch back to the main working tree via the picker's primary row.
    await openWorktreePicker(page)
    await worktreeList(page).getByRole('option').filter({ hasText: 'primary' }).click()
    await expect(worktreeList(page)).toHaveCount(0)

    // The worktree-only file is gone; the main tree (still has src/) is back.
    await expect(fileTree.getByText('wip.txt', { exact: true })).toHaveCount(0)
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
