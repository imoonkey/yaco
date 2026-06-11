import { test, expect, type Page } from '@playwright/test'
import { provisionWorkspace, createTestFile, uniqueFileName, type FixtureProject } from './helpers/workspace'

/** Install a spy on navigator.clipboard.writeText that captures the last written value */
async function installClipboardSpy(page: Page) {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__clipboardSpy = null
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard)
    navigator.clipboard.writeText = async (text: string) => {
      (window as unknown as Record<string, unknown>).__clipboardSpy = text
      return orig(text)
    }
  })
}

function getClipboardSpy(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as Record<string, string | null>).__clipboardSpy)
}

test.describe('Cmd+C copy path in explorer', () => {
  let fixture: FixtureProject
  let testDir: string
  let testFile: string

  test.beforeEach(async ({ page, request }) => {
    fixture = await provisionWorkspace(page, request)
    testDir = uniqueFileName('copy_path_dir')
    testFile = `${testDir}/sample.txt`
    await createTestFile(page, fixture.name, testFile, 'hello\n')
    await installClipboardSpy(page)
  })

  test.afterEach(async () => {
    await fixture.dispose()
  })

  test('copies file path when file is focused', async ({ page }) => {
    // Expand the folder (its tree row appears once the SSE refresh lands).
    const folderNode = page.locator(`[role="treeitem"]:has-text("${testDir}")`).first()
    await expect(folderNode).toBeVisible({ timeout: 10_000 })
    await folderNode.click()

    const fileNode = page.locator(`[role="treeitem"]:has-text("sample.txt")`).first()
    await expect(fileNode).toBeVisible({ timeout: 10_000 })
    await fileNode.click()

    await page.keyboard.press('Meta+c')
    await expect.poll(() => getClipboardSpy(page), { timeout: 5_000 }).toBe(testFile)
  })

  test('copies folder path when folder is focused', async ({ page }) => {
    const folderNode = page.locator(`[role="treeitem"]:has-text("${testDir}")`).first()
    await expect(folderNode).toBeVisible({ timeout: 10_000 })
    await folderNode.click()

    await page.keyboard.press('Meta+c')
    await expect.poll(() => getClipboardSpy(page), { timeout: 5_000 }).toBe(testDir)
  })
})
