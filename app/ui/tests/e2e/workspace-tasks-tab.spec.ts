import { test, expect, type Page } from '@playwright/test'

// The Tasks area is a single task workspace (one stacked graph + toolbar), opened
// as an overlay via Cmd/Ctrl+Shift+T. There is no Board/List/Graph/Archive pane
// switching — workset is a filter on one workspace, not a separate surface.

async function loadProjects(page: Page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<{ name: string; path: string }[]>
  })
}

async function openWorkspace(page: Page) {
  await page.goto('/')
  const projects = await loadProjects(page)
  expect(projects.length).toBeGreaterThan(0)
  await page.locator('button', { hasText: projects[0].name }).first().click()
  await page.evaluate((name: string) => localStorage.removeItem(`yaco-task-workspace:${name}`), projects[0].name)
  return projects
}

const search = (page: Page) => page.locator('input[placeholder="Search tasks..."]')

test.describe('Workspace Tasks', () => {
  test('Cmd+Shift+T toggles the single task workspace open and closed', async ({ page }) => {
    await openWorkspace(page)

    await page.keyboard.press('Meta+Shift+t')
    await expect(search(page)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-layer="nodes"]')).toBeVisible()

    await page.keyboard.press('Meta+Shift+t')
    await expect(search(page)).toHaveCount(0)
    await expect(page.locator('[data-layer="nodes"]')).toHaveCount(0)
  })

  test('is one workspace surface — no Board/List/Archive panels, workset is a filter', async ({ page }) => {
    await openWorkspace(page)
    await page.keyboard.press('Meta+Shift+t')
    await expect(page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"]').first())
      .toBeVisible({ timeout: 15_000 })

    // No Board/List/Archive surface switchers (these were deleted in V1).
    for (const surface of ['Board', 'List', 'Archive']) {
      expect(await page.getByRole('button', { name: surface, exact: true }).count()).toBe(0)
      expect(await page.getByRole('tab', { name: surface, exact: true }).count()).toBe(0)
    }

    // Archive is a workset filter chip, not a panel — present, and OFF by default.
    const worksetGroup = page.locator('[role="group"][aria-label="Workset filter"]')
    await expect(worksetGroup).toBeVisible()
    await expect(page.locator('button[aria-label="Workset: active"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('button[aria-label="Workset: backlog"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('button[aria-label="Workset: archive"]')).toHaveAttribute('aria-pressed', 'false')
  })
})
