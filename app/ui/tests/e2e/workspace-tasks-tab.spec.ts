import { test, expect, type Page } from '@playwright/test'
import { openFileViaSearch } from './helpers/workspace'

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

  // Regression (T7 H1): opening a file from Tasks must ALWAYS return the main
  // surface to the editor — even when the file is already the active tab (so
  // `activeTab` does not change). The old fake tasks tab made any file-open
  // switch `activeTab` away from Tasks; the real panel needs an explicit switch.
  test('opening the already-active file from Tasks returns to the editor', async ({ page }) => {
    await openWorkspace(page)

    // A real file as the active editor tab.
    await openFileViaSearch(page, 'package.json')
    await expect(page.locator('[data-testid="tab"]')).toHaveCount(1)

    // Open Tasks over the editor.
    await page.keyboard.press('Meta+Shift+t')
    await expect(search(page)).toBeVisible({ timeout: 10_000 })

    // Re-open the SAME (already-active) file from quick-open while Tasks shows.
    await openFileViaSearch(page, 'package.json')

    // The editor returns: the tasks workspace is gone and the file tab is shown.
    await expect(search(page)).toHaveCount(0)
    await expect(page.locator('[data-layer="nodes"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="tab"]')).toHaveCount(1)
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

  test('archive node is hidden by default and rendered after enabling the archive chip', async ({ page }) => {
    const projects = await openWorkspace(page)
    await page.keyboard.press('Meta+Shift+t')
    await expect(page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"]').first())
      .toBeVisible({ timeout: 15_000 })

    // Discover a uniquely-titled archived root task from the live data.
    const archiveTitle = await page.evaluate(async (name: string) => {
      const res = await fetch(`/api/tasks/${encodeURIComponent(name)}`)
      const { tasks } = await res.json() as {
        tasks: Record<string, { title: string; parent: string | null; workset?: string }>
      }
      const entries = Object.values(tasks)
      const count = new Map<string, number>()
      for (const t of entries) count.set(t.title, (count.get(t.title) ?? 0) + 1)
      const hit = entries.find(t => t.workset === 'archive' && t.parent === null
        && !/["\\]/.test(t.title) && count.get(t.title) === 1)
      return hit?.title ?? null
    }, projects[0].name)
    // There ARE archived tasks in this repo's data; fail loudly if not.
    expect(archiveTitle, 'an archived root task with a unique title').toBeTruthy()

    const archiveNode = page.locator(`g[role="button"][aria-label^="Task: ${archiveTitle}, status:"]`)

    // Hidden by default; rendered once the archive workset is enabled.
    await expect(archiveNode).toHaveCount(0)
    await page.locator('button[aria-label="Workset: archive"]').click()
    await expect(archiveNode).toHaveCount(1)
  })
})
