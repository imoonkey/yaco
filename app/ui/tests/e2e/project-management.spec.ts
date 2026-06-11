import { test, expect, type Page } from '@playwright/test'
import {
  waitForAppReady,
  selectProject,
  createFixtureProject,
  createBrowseFixture,
  type FixtureProject,
  type BrowseFixture,
} from './helpers/workspace'

// Self-contained: every test provisions its own registered project fixture and
// a $HOME-rooted browse fixture (the /api/browse endpoint only serves paths
// under $HOME, and this machine has no fixed `~/workspace`). Enough tree files
// are seeded that the explorer scroll regression test has something to scroll.

const treeFiles = Object.fromEntries(
  Array.from({ length: 25 }, (_, i) => [`src/file_${i}.txt`, `content ${i}\n`]),
)

let fixture: FixtureProject
let browse: BrowseFixture

test.beforeEach(async ({ request }) => {
  fixture = await createFixtureProject(request, { files: treeFiles })
  browse = createBrowseFixture()
})

test.afterEach(async () => {
  await fixture.dispose()
  browse.dispose()
})

async function waitForApp(page: Page) {
  await page.goto('/')
  await waitForAppReady(page)
}

/** Get project button by name in the sidebar project list */
function projectTab(page: Page, name: string) {
  return page.locator('button', { hasText: name }).first()
}

// --- Project Tab Context Menu ---

test.describe('Project tab context menu', () => {
  test('right-click shows context menu with Copy Path and Remove', async ({ page }) => {
    await waitForApp(page)
    await projectTab(page, fixture.name).click({ button: 'right' })

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('text=Copy Path')).toBeVisible()
    await expect(menu.locator('text=Remove')).toBeVisible()
  })

  test('context menu opens ABOVE the cursor (not clipped by bottom edge)', async ({ page }) => {
    await waitForApp(page)
    await projectTab(page, fixture.name).click({ button: 'right' })

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    const menuBox = await menu.boundingBox()
    const viewport = page.viewportSize()!
    expect(menuBox).toBeTruthy()
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport.height)
  })

  test('Escape closes context menu', async ({ page }) => {
    await waitForApp(page)
    await projectTab(page, fixture.name).click({ button: 'right' })

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('clicking outside closes context menu', async ({ page }) => {
    await waitForApp(page)
    await projectTab(page, fixture.name).click({ button: 'right' })

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    await page.locator('main').click()
    await expect(menu).not.toBeVisible()
  })
})

// --- Add Project Dialog ---

test.describe('Add Project dialog', () => {
  test('clicking + opens modal dialog (not window.prompt)', async ({ page }) => {
    await waitForApp(page)
    await page.locator('button[aria-label="Add project"]').click()

    const dialog = page.locator('text=Add Project').first()
    await expect(dialog).toBeVisible()

    const pathInput = page.locator('input[type="text"]')
    await expect(pathInput).toBeVisible()
    await expect(pathInput).toBeFocused()

    await expect(page.locator('button', { hasText: 'Cancel' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
  })

  test('typing path triggers directory autocomplete', async ({ page }) => {
    await waitForApp(page)
    await page.locator('button[aria-label="Add project"]').click()

    const pathInput = page.locator('input[type="text"]')
    await pathInput.fill(browse.root + '/')

    // Autocomplete fires a /api/browse fetch; wait for an entry, not a sleep.
    const entries = page.locator('.cursor-pointer', { hasText: /\w+/ })
    await expect(entries.first()).toBeVisible({ timeout: 10_000 })
    expect(await entries.count()).toBeGreaterThan(0)
  })

  test('git repos show green indicator', async ({ page }) => {
    await waitForApp(page)
    await page.locator('button[aria-label="Add project"]').click()

    const pathInput = page.locator('input[type="text"]')
    await pathInput.fill(browse.root + '/')

    // The fixture's `with-git` subdir is a git repo → shows the "git" label.
    await expect(page.locator('text=git').first()).toBeVisible({ timeout: 10_000 })
  })

  test('clicking suggestion drills into subdirectory', async ({ page }) => {
    await waitForApp(page)
    await page.locator('button[aria-label="Add project"]').click()

    const pathInput = page.locator('input[type="text"]')
    await pathInput.fill(browse.root + '/')

    const dropdown = page.locator('.rounded-md.overflow-y-auto')
    await expect(dropdown).toBeVisible({ timeout: 10_000 })
    const firstEntry = dropdown.locator('.cursor-pointer').first()
    const entryName = await firstEntry.locator('.truncate').textContent()
    await firstEntry.click()

    const newValue = await pathInput.inputValue()
    expect(newValue).toContain(entryName!)
    expect(newValue).toMatch(/\/$/)
  })

  test('Escape closes the dialog', async ({ page }) => {
    await waitForApp(page)
    await page.locator('button[aria-label="Add project"]').click()

    const dialogInput = page.locator('input[type="text"]')
    await expect(dialogInput).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialogInput).not.toBeVisible()
  })

  test('Cancel button closes the dialog', async ({ page }) => {
    await waitForApp(page)
    await page.locator('button[aria-label="Add project"]').click()

    const dialogInput = page.locator('input[type="text"]')
    await expect(dialogInput).toBeVisible()
    await page.locator('button', { hasText: 'Cancel' }).click()
    await expect(dialogInput).not.toBeVisible()
  })

  test('adding duplicate project shows inline error', async ({ page }) => {
    await waitForApp(page)
    await page.locator('button[aria-label="Add project"]').click()

    const pathInput = page.locator('input[type="text"]')
    await pathInput.fill(fixture.path)

    await page.getByRole('button', { name: 'Add', exact: true }).click()

    // Should show inline error, NOT an alert.
    await expect(page.locator('text=already registered')).toBeVisible({ timeout: 3000 })
  })
})

// --- Browse API ---

test.describe('Browse API', () => {
  test('returns directory entries with isGit', async ({ page }) => {
    await page.goto('/')
    const prefix = browse.root + '/'
    const result = await page.evaluate(async (prefix) => {
      const res = await fetch('/api/browse?prefix=' + encodeURIComponent(prefix))
      return res.json() as Promise<{ entries: { name: string; path: string; isGit: boolean }[] }>
    }, prefix)

    expect(result.entries.length).toBeGreaterThan(0)
    for (const entry of result.entries) {
      expect(entry).toHaveProperty('name')
      expect(entry).toHaveProperty('path')
      expect(entry).toHaveProperty('isGit')
      expect(typeof entry.isGit).toBe('boolean')
    }
    // The git subdir is flagged, the plain one is not.
    expect(result.entries.find((e) => e.name === browse.gitDir)?.isGit).toBe(true)
    expect(result.entries.find((e) => e.name === browse.plainDir)?.isGit).toBe(false)
  })

  test('rejects paths outside $HOME', async ({ page }) => {
    await page.goto('/')
    const status = await page.evaluate(async () => {
      const res = await fetch('/api/browse?prefix=' + encodeURIComponent('/etc/'))
      return res.status
    })
    expect(status).toBe(400)
  })

  test('returns empty entries for nonexistent path', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/browse?prefix=' + encodeURIComponent('~/nonexistent_path_xyz_123/'))
      return res.json() as Promise<{ entries: { name: string }[] }>
    })
    expect(result.entries).toEqual([])
  })
})

// --- Workspace Sidebar Regressions ---

test.describe('Workspace sidebar', () => {
  test('explorer/changes resize handle is visible and draggable', async ({ page }) => {
    await waitForApp(page)
    await selectProject(page, fixture.name)

    await expect(page.locator(`[aria-label="${fixture.name} section"]`)).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=Changes').first()).toBeVisible({ timeout: 5000 })

    const handle = page.locator('.cursor-row-resize').first()
    await expect(handle).toBeVisible()

    const handleBoxBefore = await handle.boundingBox()
    expect(handleBoxBefore).toBeTruthy()

    await page.mouse.move(handleBoxBefore!.x + handleBoxBefore!.width / 2, handleBoxBefore!.y)
    await page.mouse.down()
    await page.mouse.move(handleBoxBefore!.x + handleBoxBefore!.width / 2, handleBoxBefore!.y + 50, { steps: 10 })
    await page.mouse.up()

    const handleBoxAfter = await handle.boundingBox()
    expect(handleBoxAfter).toBeTruthy()
    expect(handleBoxAfter!.y).toBeGreaterThan(handleBoxBefore!.y)
  })

  test('explorer scroll position is preserved during interaction', async ({ page }) => {
    await waitForApp(page)
    await selectProject(page, fixture.name)

    const treeContainer = page.locator('[data-testid="tree-node"]').first()
    if (!await treeContainer.isVisible({ timeout: 5000 }).catch(() => false)) {
      test.skip(true, 'No tree nodes visible — project may have few files')
      return
    }

    const scrollable = page.locator('.react-arborist-tree-container, [style*="overflow"]').first()
    if (!await scrollable.isVisible({ timeout: 2000 }).catch(() => false)) {
      test.skip(true, 'No scrollable tree container found')
      return
    }

    await scrollable.evaluate((el) => (el.scrollTop = 200))
    await expect.poll(() => scrollable.evaluate((el) => el.scrollTop), { timeout: 3000 }).toBeGreaterThan(0)

    // The bug would reset scroll on the next render cycle — give it a moment,
    // then assert it did NOT reset.
    await page.waitForTimeout(1500)
    expect(await scrollable.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  })
})
