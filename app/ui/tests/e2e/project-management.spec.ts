import { test, expect, type Page } from '@playwright/test'
import { waitForAppReady } from './helpers/workspace'

// --- Helpers ---

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

    // Get first project from API
    const projects = await page.evaluate(async () => {
      const res = await fetch('/api/projects')
      return res.json() as Promise<{ name: string; path: string }[]>
    })
    expect(projects.length).toBeGreaterThan(0)
    const project = projects[0]

    // Right-click the project tab
    await projectTab(page, project.name).click({ button: 'right' })

    // Context menu should appear with both items
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('text=Copy Path')).toBeVisible()
    await expect(menu.locator('text=Remove')).toBeVisible()
  })

  test('context menu opens ABOVE the cursor (not clipped by bottom edge)', async ({ page }) => {
    await waitForApp(page)

    const projects = await page.evaluate(async () => {
      const res = await fetch('/api/projects')
      return res.json() as Promise<{ name: string; path: string }[]>
    })
    const project = projects[0]

    await projectTab(page, project.name).click({ button: 'right' })

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    // Menu should be fully visible (bottom edge above viewport bottom)
    const menuBox = await menu.boundingBox()
    const viewport = page.viewportSize()!
    expect(menuBox).toBeTruthy()
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport.height)
  })

  test('Escape closes context menu', async ({ page }) => {
    await waitForApp(page)

    const projects = await page.evaluate(async () => {
      const res = await fetch('/api/projects')
      return res.json() as Promise<{ name: string; path: string }[]>
    })
    await projectTab(page, projects[0].name).click({ button: 'right' })

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('clicking outside closes context menu', async ({ page }) => {
    await waitForApp(page)

    const projects = await page.evaluate(async () => {
      const res = await fetch('/api/projects')
      return res.json() as Promise<{ name: string; path: string }[]>
    })
    await projectTab(page, projects[0].name).click({ button: 'right' })

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    // Click on the main content area
    await page.locator('main').click()
    await expect(menu).not.toBeVisible()
  })
})

// --- Add Project Dialog ---

test.describe('Add Project dialog', () => {
  test('clicking + opens modal dialog (not window.prompt)', async ({ page }) => {
    await waitForApp(page)

    // Click the + button
    await page.locator('button[aria-label="Add project"]').click()

    // Modal should appear with title, input, and buttons
    const dialog = page.locator('text=Add Project').first()
    await expect(dialog).toBeVisible()

    const pathInput = page.locator('input[type="text"]')
    await expect(pathInput).toBeVisible()
    await expect(pathInput).toBeFocused()

    // Cancel and Add buttons
    await expect(page.locator('button', { hasText: 'Cancel' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
  })

  test('typing path triggers directory autocomplete', async ({ page }) => {
    await waitForApp(page)
    await page.locator('button[aria-label="Add project"]').click()

    const pathInput = page.locator('input[type="text"]')
    await pathInput.fill('~/workspace/')

    // Wait for autocomplete dropdown
    await page.waitForTimeout(500)

    // Should show directory entries
    const entries = page.locator('.cursor-pointer', { hasText: /\w+/ })
    const count = await entries.count()
    expect(count).toBeGreaterThan(0)
  })

  test('git repos show green indicator', async ({ page }) => {
    await waitForApp(page)
    await page.locator('button[aria-label="Add project"]').click()

    const pathInput = page.locator('input[type="text"]')
    await pathInput.fill('~/workspace/')
    await page.waitForTimeout(500)

    // At least one entry should have "git" label (workflow, agent-config, etc.)
    await expect(page.locator('text=git').first()).toBeVisible()
  })

  test('clicking suggestion drills into subdirectory', async ({ page }) => {
    await waitForApp(page)
    await page.locator('button[aria-label="Add project"]').click()

    const pathInput = page.locator('input[type="text"]')
    await pathInput.fill('~/workspace/')
    await page.waitForTimeout(500)

    // The autocomplete dropdown is inside the dialog, entries have truncate class
    const dropdown = page.locator('.rounded-md.overflow-y-auto')
    await expect(dropdown).toBeVisible()
    const firstEntry = dropdown.locator('.cursor-pointer').first()
    const entryName = await firstEntry.locator('.truncate').textContent()
    await firstEntry.click()

    // Path input should now contain the selected directory with trailing /
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

    // Get existing project path
    const projects = await page.evaluate(async () => {
      const res = await fetch('/api/projects')
      return res.json() as Promise<{ name: string; path: string }[]>
    })
    const existing = projects[0]

    await page.locator('button[aria-label="Add project"]').click()

    const pathInput = page.locator('input[type="text"]')
    await pathInput.fill(existing.path)

    await page.getByRole('button', { name: 'Add', exact: true }).click()

    // Should show inline error, NOT an alert
    await expect(page.locator('text=already registered')).toBeVisible({ timeout: 3000 })
  })
})

// --- Browse API ---

test.describe('Browse API', () => {
  test('returns directory entries with isGit', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/browse?prefix=' + encodeURIComponent('~/workspace/'))
      return res.json() as Promise<{ entries: { name: string; path: string; isGit: boolean }[] }>
    })

    expect(result.entries.length).toBeGreaterThan(0)
    // Every entry should have the required fields
    for (const entry of result.entries) {
      expect(entry).toHaveProperty('name')
      expect(entry).toHaveProperty('path')
      expect(entry).toHaveProperty('isGit')
      expect(typeof entry.isGit).toBe('boolean')
    }
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
  async function openWorkspace(page: Page) {
    await waitForApp(page)
    const projects = await page.evaluate(async () => {
      const res = await fetch('/api/projects')
      return res.json() as Promise<{ name: string; path: string }[]>
    })
    expect(projects.length).toBeGreaterThan(0)

    await page.locator('button', { hasText: projects[0].name }).click()
    return projects[0]
  }

  test('explorer/changes resize handle is visible and draggable', async ({ page }) => {
    const project = await openWorkspace(page)

    // Both the Explorer (its header is titled by the project name) and Changes
    // sections should be visible — the resize handle lives between them.
    await expect(page.locator(`[aria-label="${project.name} section"]`)).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=Changes').first()).toBeVisible({ timeout: 5000 })

    // The horizontal resize handle between them (cursor-row-resize)
    const handle = page.locator('.cursor-row-resize').first()
    await expect(handle).toBeVisible()

    // Get the handle position before drag
    const handleBoxBefore = await handle.boundingBox()
    expect(handleBoxBefore).toBeTruthy()

    // Drag the handle downward by 50px
    await page.mouse.move(handleBoxBefore!.x + handleBoxBefore!.width / 2, handleBoxBefore!.y)
    await page.mouse.down()
    await page.mouse.move(handleBoxBefore!.x + handleBoxBefore!.width / 2, handleBoxBefore!.y + 50, { steps: 10 })
    await page.mouse.up()

    // Handle should have moved down
    const handleBoxAfter = await handle.boundingBox()
    expect(handleBoxAfter).toBeTruthy()
    expect(handleBoxAfter!.y).toBeGreaterThan(handleBoxBefore!.y)
  })

  test('explorer scroll position is preserved during interaction', async ({ page }) => {
    await openWorkspace(page)

    // Wait for file tree to load
    await page.waitForTimeout(2000)

    // Find the tree container (react-arborist renders inside a div with role=tree or similar)
    const treeContainer = page.locator('[data-testid="tree-node"]').first()
    if (!await treeContainer.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'No tree nodes visible — project may have few files')
      return
    }

    // Find the scrollable container (the virtual list wrapper)
    const scrollable = page.locator('.react-arborist-tree-container, [style*="overflow"]').first()
    if (!await scrollable.isVisible({ timeout: 2000 }).catch(() => false)) {
      test.skip(true, 'No scrollable tree container found')
      return
    }

    // Scroll down
    await scrollable.evaluate(el => el.scrollTop = 200)
    await page.waitForTimeout(300)

    const scrollAfterSet = await scrollable.evaluate(el => el.scrollTop)
    expect(scrollAfterSet).toBeGreaterThan(0)

    // Wait a bit — the bug would reset scroll on next render cycle
    await page.waitForTimeout(2000)

    const scrollAfterWait = await scrollable.evaluate(el => el.scrollTop)
    // Scroll should NOT have reset to 0
    expect(scrollAfterWait).toBeGreaterThan(0)
  })
})
