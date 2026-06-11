import { test, expect, type Page } from '@playwright/test'
import {
  provisionWorkspace,
  fileExistsOnServer,
  dirExistsOnServer,
  uniqueFileName,
  type FixtureProject,
} from './helpers/workspace'

/** Wait for a tree item with given text to appear */
async function waitForTreeItem(page: Page, text: string, timeoutMs = 8000): Promise<boolean> {
  try {
    await page.locator('[role="treeitem"]', { hasText: text }).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

// --- Tests ---

test.describe('File Explorer: create file and folder', () => {
  let fixture: FixtureProject

  test.beforeEach(async ({ page, request }) => {
    // A `doc/` folder must exist on disk: several tests right-click its tree node.
    fixture = await provisionWorkspace(page, request, { files: { 'doc/.gitkeep': '' } })
  })

  test.afterEach(async () => {
    await fixture.dispose()
  })

  test('create file at root via header button', async ({ page }) => {
    const fileBase = uniqueFileName('create_root')
    const fileName = `${fileBase}.txt`

    // Wait for the explorer to render before using its header button.
    await expect(page.locator('[role="treeitem"]', { hasText: 'doc' }).first()).toBeVisible({ timeout: 10_000 })

    // Click the "New File" header button
    await page.locator('button[title="New File"]').click()

    // Inline edit should appear
    const input = page.locator('input.bg-transparent')
    await expect(input).toBeVisible({ timeout: 3000 })

    // Type and submit
    await input.type(fileName)
    await input.press('Enter')

    // File should exist on server
    await expect.poll(() => fileExistsOnServer(page, fixture.name, fileName), { timeout: 10_000 }).toBe(true)

    // File should appear in the tree after SSE refresh
    expect(await waitForTreeItem(page, fileBase)).toBe(true)
  })

  test('create file inside directory via context menu', async ({ page }) => {
    const fileBase = uniqueFileName('create_subdir')
    const fileName = `${fileBase}.txt`

    // Right-click on the "doc" folder
    const docFolder = page.locator('[role="treeitem"]', { hasText: 'doc' }).first()
    await expect(docFolder).toBeVisible({ timeout: 5000 })
    await docFolder.click({ button: 'right' })

    // Click "New File"
    await page.getByText('New File', { exact: true }).click()

    // Inline edit
    const input = page.locator('input.bg-transparent')
    await expect(input).toBeVisible({ timeout: 3000 })
    await input.type(fileName)
    await input.press('Enter')

    // File should exist on server
    await expect.poll(() => fileExistsOnServer(page, fixture.name, `doc/${fileName}`), { timeout: 10_000 }).toBe(true)

    // File should appear in the tree (regression: previously didn't because
    // parent dir wasn't registered for SSE refresh)
    expect(await waitForTreeItem(page, fileBase)).toBe(true)
  })

  test('create folder at root via header button', async ({ page }) => {
    const dirName = uniqueFileName('create_rootdir')

    // Wait for the explorer to render before using its header button.
    await expect(page.locator('[role="treeitem"]', { hasText: 'doc' }).first()).toBeVisible({ timeout: 10_000 })

    // Click "New Folder" header button
    await page.locator('button[title="New Folder"]').click()

    const input = page.locator('input.bg-transparent')
    await expect(input).toBeVisible({ timeout: 3000 })
    await input.type(dirName)
    await input.press('Enter')

    await expect.poll(() => dirExistsOnServer(page, fixture.name, dirName), { timeout: 10_000 }).toBe(true)
  })

  test('create file via header button while a subdirectory is selected', async ({ page }) => {
    const fileBase = uniqueFileName('create_with_selection')
    const fileName = `${fileBase}.txt`

    // Select the "doc" folder first so contextFolder becomes "doc"
    const docFolder = page.locator('[role="treeitem"]', { hasText: 'doc' }).first()
    await expect(docFolder).toBeVisible({ timeout: 5000 })
    await docFolder.click()

    // Now click the header "New File" button — should create inside "doc"
    await page.locator('button[title="New File"]').click()

    const input = page.locator('input.bg-transparent')
    await expect(input).toBeVisible({ timeout: 3000 })
    await input.type(fileName)
    await input.press('Enter')

    await expect.poll(() => fileExistsOnServer(page, fixture.name, `doc/${fileName}`), { timeout: 10_000 }).toBe(true)
    expect(await waitForTreeItem(page, fileBase)).toBe(true)
  })

  test('create folder inside directory via context menu', async ({ page }) => {
    const dirName = uniqueFileName('create_subdir_folder')

    const docFolder = page.locator('[role="treeitem"]', { hasText: 'doc' }).first()
    await expect(docFolder).toBeVisible({ timeout: 5000 })
    await docFolder.click({ button: 'right' })

    await page.getByText('New Folder', { exact: true }).click()

    const input = page.locator('input.bg-transparent')
    await expect(input).toBeVisible({ timeout: 3000 })
    await input.type(dirName)
    await input.press('Enter')

    await expect.poll(() => dirExistsOnServer(page, fixture.name, `doc/${dirName}`), { timeout: 10_000 }).toBe(true)

    // Folder should appear in tree (same regression as file case)
    expect(await waitForTreeItem(page, dirName)).toBe(true)
  })
})
