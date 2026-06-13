import { test, expect, type Page } from '@playwright/test'
import {
  provisionWorkspace,
  openFileViaSearch,
  type FixtureProject,
} from './helpers/workspace'

// The Tasks area is a single task workspace (one stacked graph + toolbar), opened
// as an overlay via Cmd/Ctrl+Shift+T. There is no Board/List/Graph/Archive pane
// switching — workset is a filter on one workspace, not a separate surface.

// Seed a task graph with one active root and one archived root so the archive
// chip has something to reveal, plus a package.json the quick-open spec opens.
const FIXTURE_OPTS = {
  files: { 'package.json': '{"name":"fixture","private":true}\n' },
  tasks: {
    'active-root': { parent: null, depends: [], state: 'ready', workset: 'active', title: 'Active Root', description: 'active', acceptCriteria: ['ships'], worktree: null },
    'archived-root': { parent: null, depends: [], state: 'done', workset: 'archive', title: 'Archived Root', description: 'archived', acceptCriteria: ['ships'], worktree: null },
  },
}

const search = (page: Page) => page.locator('input[placeholder="Search tasks..."]')

test.describe('Workspace Tasks', () => {
  let fixture: FixtureProject

  test.beforeEach(async ({ page, request }) => {
    fixture = await provisionWorkspace(page, request, FIXTURE_OPTS)
    await page.evaluate((name: string) => localStorage.removeItem(`yaco-task-workspace:${name}`), fixture.name)
  })

  test.afterEach(async () => {
    await fixture.dispose()
  })

  // Tasks is a toggled full-width overlay (showTasks), opened via Cmd/Ctrl+Shift+T —
  // not a persistent dock leaf. This pins that opening it renders the live graph.
  test('opening Tasks renders the single task workspace with its live graph', async ({ page }) => {
    await page.keyboard.press('Meta+Shift+t')
    await expect(search(page)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-layer="nodes"]')).toBeVisible()
    // It reflects the live task graph (the seeded active root renders a node).
    await expect(page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"]').first())
      .toBeVisible({ timeout: 15_000 })
  })

  // Regression (T7 H1 legacy): re-opening the already-active file must still leave
  // exactly one editor tab in the working group.
  test('re-opening the already-active file keeps exactly one editor tab', async ({ page }) => {
    // A real file as the active editor tab.
    await openFileViaSearch(page, 'package.json')
    await expect(page.locator('[data-testid="group-tab"]')).toHaveCount(1)

    // Re-open the SAME (already-active) file — it stays a single editor tab.
    await openFileViaSearch(page, 'package.json')
    await expect(page.locator('[data-testid="group-tab"]')).toHaveCount(1)
  })

  test('is one workspace surface — no Board/List/Archive panels, workset is a filter', async ({ page }) => {
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
    }, fixture.name)
    // There IS an archived task in this fixture's data; fail loudly if not.
    expect(archiveTitle, 'an archived root task with a unique title').toBeTruthy()

    const archiveNode = page.locator(`g[role="button"][aria-label^="Task: ${archiveTitle}, status:"]`)

    // Hidden by default; rendered once the archive workset is enabled.
    await expect(archiveNode).toHaveCount(0)
    await page.locator('button[aria-label="Workset: archive"]').click()
    await expect(archiveNode).toHaveCount(1)
  })
})
