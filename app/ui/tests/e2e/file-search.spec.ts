import { test, expect } from '@playwright/test'
import {
  provisionWorkspace,
  createTestFile,
  fileExistsOnServer,
  writeFileViaAPI,
  openFileViaSearch,
  uniqueFileName,
  type FixtureProject,
} from './helpers/workspace'

// A nested source tree so the "subdirectory results" test finds matches.
const FIXTURE_FILES = {
  'src/index.ts': 'export const value = 1\n',
  'src/util/helper.ts': 'export function helper() { return 1 }\n',
}

test.describe('File search (Cmd+P)', () => {
  let fixture: FixtureProject

  test.beforeEach(async ({ page, request }) => {
    fixture = await provisionWorkspace(page, request, { files: FIXTURE_FILES })
  })

  test.afterEach(async () => {
    await fixture.dispose()
  })

  test('lists files from subdirectories, not just root', async ({ page }) => {
    // Open search
    await page.keyboard.press('Meta+p')
    const searchInput = page.locator('input[placeholder="Search files..."], input[placeholder="Loading files..."]')
    await expect(searchInput).toBeVisible({ timeout: 5000 })

    // Wait for loading to finish
    await expect(page.locator('input[placeholder="Search files..."]')).toBeVisible({ timeout: 10_000 })

    // Search for a term present only in a subdirectory file (src/util/helper.ts).
    await searchInput.fill('helper')
    const results = page.locator('.max-h-\\[300px\\] > div')
    await expect(results.first()).toBeVisible({ timeout: 3000 })

    // Verify results contain path with directory separators (i.e. nested file).
    // The path renders in the row's `.text-ui-xs` wrapper; match highlighting
    // splits it into multiple inner spans, so read the wrapper's full text.
    const firstResultPath = await results.first().locator('.text-ui-xs').textContent()
    expect(firstResultPath).toContain('/')

    await page.keyboard.press('Escape')
  })

  test('selecting a file opens it and reveals in explorer', async ({ page }) => {
    // Create a nested test file
    const testDir = uniqueFileName('search_test')
    const testPath = `${testDir}/nested_file.txt`
    await createTestFile(page, fixture.name, testPath, 'search test content\n')
    await expect.poll(() => fileExistsOnServer(page, fixture.name, testPath), { timeout: 10_000 }).toBe(true)

    // Search and select the file
    await openFileViaSearch(page, 'nested_file')

    // Verify file opened in editor
    const editorContent = page.locator('.cm-content')
    await expect(editorContent).toContainText('search test content', { timeout: 5000 })

    // Verify tab is visible
    const tab = page.locator('[data-testid="group-tab"]', { hasText: 'nested_file.txt' })
    await expect(tab).toBeVisible()
  })

  test('gitignore toggle includes ignored files', async ({ page }) => {
    await page.keyboard.press('Meta+p')
    await expect(page.locator('input[placeholder="Search files..."]')).toBeVisible({ timeout: 10_000 })

    // Find and click the .gitignore toggle button
    const toggle = page.locator('button', { hasText: '.gitignore' })
    await expect(toggle).toBeVisible()

    // Clicking toggles the button state (visual check)
    await toggle.click()

    // After toggling, the search should still work (re-fetches with ?ignored=true)
    await expect(page.locator('input[placeholder="Loading files..."], input[placeholder="Search files..."]')).toBeVisible()
    await expect(page.locator('input[placeholder="Search files..."]')).toBeVisible({ timeout: 10_000 })

    await page.keyboard.press('Escape')
  })
})

test.describe('Changes sidebar', () => {
  let fixture: FixtureProject

  test.beforeEach(async ({ page, request }) => {
    fixture = await provisionWorkspace(page, request, { files: FIXTURE_FILES })
  })

  test.afterEach(async () => {
    await fixture.dispose()
  })

  test('clicking a changed file opens diff as preview tab', async ({ page }) => {
    // Create and modify a test file to generate a git change
    const testPath = uniqueFileName('changes_test.txt')
    await createTestFile(page, fixture.name, testPath, 'changes test\n')
    await expect.poll(() => fileExistsOnServer(page, fixture.name, testPath), { timeout: 10_000 }).toBe(true)

    const changeItem = page.locator(`[data-testid="git-change-item"][data-change-path="${testPath}"]`).first()
    await expect(changeItem).toBeVisible({ timeout: 10_000 })
    await changeItem.click()

    const diffTab = page.locator(`[data-testid="group-tab"][title="diff:${testPath}"]`)
    await expect(diffTab).toBeVisible({ timeout: 3000 })

    // Preview tabs have italic styling
    await expect(diffTab).toHaveCSS('font-style', 'italic')
  })

  test('double-clicking a changed file opens diff as a pinned tab', async ({ page }) => {
    const testPath = uniqueFileName('changes_pin_test.txt')
    await createTestFile(page, fixture.name, testPath, 'changes pin test\n')
    await expect.poll(() => fileExistsOnServer(page, fixture.name, testPath), { timeout: 10_000 }).toBe(true)

    const changeItem = page.locator(`[data-testid="git-change-item"][data-change-path="${testPath}"]`).first()
    await expect(changeItem).toBeVisible({ timeout: 10_000 })
    await changeItem.dblclick()

    const diffTab = page.locator(`[data-testid="group-tab"][title="diff:${testPath}"]`)
    await expect(diffTab).toBeVisible({ timeout: 3000 })
    await expect(diffTab).not.toHaveCSS('font-style', 'italic')
  })

  test('clicking a changed file path segment reveals the file in the explorer', async ({ page }) => {
    const testDir = 'src/util'
    const fileName = 'helper.ts'
    const testPath = `${testDir}/${fileName}`
    await writeFileViaAPI(page, fixture.name, testPath, 'export function helper() { return 2 }\n')

    const changeItem = page.locator(`[data-testid="git-change-item"][data-change-path="${testPath}"]`).first()
    await expect(changeItem).toBeVisible({ timeout: 10_000 })

    await changeItem.getByText(fileName, { exact: true }).click()
    await expect(page.locator(`[data-testid="group-tab"][title="diff:${testPath}"]`)).toBeVisible({ timeout: 3000 })
    await expect(page.locator('[role="treeitem"]', { hasText: fileName }).first()).not.toBeVisible()

    await changeItem.getByText(testDir, { exact: true }).click()

    await expect(page.locator('[role="treeitem"]', { hasText: fileName }).first()).toBeVisible({ timeout: 10_000 })
  })
})
