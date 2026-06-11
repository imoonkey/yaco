import { test, expect } from '@playwright/test'
import {
  provisionWorkspace,
  createTestFile,
  fileExistsOnServer,
  uniqueFileName,
  type FixtureProject,
} from './helpers/workspace'

test.describe('File Explorer: multi-select', () => {
  let fixture: FixtureProject
  let pathA: string
  let pathB: string
  let pathC: string

  test.beforeEach(async ({ page, request }) => {
    fixture = await provisionWorkspace(page, request)
    pathA = uniqueFileName('multi_a.txt')
    pathB = uniqueFileName('multi_b.txt')
    pathC = uniqueFileName('multi_c.txt')
  })

  test.afterEach(async () => {
    await fixture.dispose()
  })

  test('Ctrl+Click selects multiple files and right-click Delete batch-removes them', async ({ page }) => {
    const paths = [pathA, pathB, pathC]
    for (const p of paths) await createTestFile(page, fixture.name, p, '')

    const items = paths.map(p => p.replace(/\.txt$/, ''))
    for (const stem of items) {
      await expect(page.locator('[role="treeitem"]', { hasText: stem }).first()).toBeVisible({ timeout: 10_000 })
    }

    // Single-click first, Ctrl+Click the others
    await page.locator('[role="treeitem"]', { hasText: items[0] }).first().click()
    await page.locator('[role="treeitem"]', { hasText: items[1] }).first().click({ modifiers: ['ControlOrMeta'] })
    await page.locator('[role="treeitem"]', { hasText: items[2] }).first().click({ modifiers: ['ControlOrMeta'] })

    // Right-click on one of the selected nodes → context menu → Delete
    await page.locator('[role="treeitem"]', { hasText: items[1] }).first().click({ button: 'right' })
    await page.getByText('Delete', { exact: true }).first().click()

    // Confirm dialog shows batch title
    await expect(page.getByText(/Delete 3 items\?/)).toBeVisible({ timeout: 3000 })
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    for (const p of paths) {
      await expect.poll(() => fileExistsOnServer(page, fixture.name, p), { timeout: 10_000 }).toBe(false)
    }
  })

  test('right-click Delete on a non-selected node deletes only that node (regression)', async ({ page }) => {
    const paths = [pathA, pathB, pathC]
    for (const p of paths) await createTestFile(page, fixture.name, p, '')

    const items = paths.map(p => p.replace(/\.txt$/, ''))
    for (const stem of items) {
      await expect(page.locator('[role="treeitem"]', { hasText: stem }).first()).toBeVisible({ timeout: 10_000 })
    }

    // Multi-select a and b, but right-click on c (not in selection)
    await page.locator('[role="treeitem"]', { hasText: items[0] }).first().click()
    await page.locator('[role="treeitem"]', { hasText: items[1] }).first().click({ modifiers: ['ControlOrMeta'] })

    await page.locator('[role="treeitem"]', { hasText: items[2] }).first().click({ button: 'right' })
    await page.getByText('Delete', { exact: true }).first().click()

    // Single-item dialog title (uses original filename in quotes)
    await expect(page.getByText(new RegExp(`Delete "${pathC.replace(/[.]/g, '\\.')}"\\?`))).toBeVisible({ timeout: 3000 })
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect.poll(() => fileExistsOnServer(page, fixture.name, pathC), { timeout: 10_000 }).toBe(false)
    expect(await fileExistsOnServer(page, fixture.name, pathA)).toBe(true)
    expect(await fileExistsOnServer(page, fixture.name, pathB)).toBe(true)
  })
})
