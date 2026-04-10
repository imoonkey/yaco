import { test, expect, type Page } from '@playwright/test'

async function openWorkspace(page: Page) {
  await page.goto('/')
  // App auto-selects first project; wait for file tree to render
  await expect(page.locator('[role="tree"]')).toBeVisible({ timeout: 15_000 })
  const projects = await page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<{ name: string; path: string }[]>
  })
  expect(projects.length).toBeGreaterThan(0)
  return projects[0]
}

async function createTestFile(page: Page, projectName: string, filePath: string, content: string) {
  await page.evaluate(async ({ projectName, path }) => {
    await fetch(`/api/files/${encodeURIComponent(projectName)}/create-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  }, { projectName, path: filePath })
  await page.evaluate(async ({ projectName, filePath, content }) => {
    const getRes = await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`)
    const { revision } = await getRes.json() as { revision: number }
    await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseRevision: revision }),
    })
  }, { projectName, filePath, content })
}

async function deleteTestFile(page: Page, projectName: string, filePath: string) {
  await page.evaluate(async ({ projectName, path }) => {
    await fetch(`/api/files/${encodeURIComponent(projectName)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  }, { projectName, path: filePath })
}

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

async function getClipboardSpy(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as Record<string, string | null>).__clipboardSpy)
}

test.describe('Cmd+C copy path in explorer', () => {
  let projectName: string
  const testDir = '__e2e_copy_path_test'
  const testFile = `${testDir}/sample.txt`

  test.beforeEach(async ({ page }) => {
    const project = await openWorkspace(page)
    projectName = project.name
    await createTestFile(page, projectName, testFile, 'hello\n')
    await page.waitForTimeout(3000) // SSE refresh
    await installClipboardSpy(page)
  })

  test.afterEach(async ({ page }) => {
    await deleteTestFile(page, projectName, testFile)
    await deleteTestFile(page, projectName, testDir)
  })

  test('copies file path when file is focused', async ({ page }) => {
    // Expand the folder first to reveal the file
    const folderNode = page.locator(`[role="treeitem"]:has-text("${testDir}")`).first()
    await expect(folderNode).toBeVisible({ timeout: 10_000 })
    await folderNode.click()
    await page.waitForTimeout(500)

    // Click the file in the explorer
    const fileNode = page.locator(`[role="treeitem"]:has-text("sample.txt")`).first()
    await expect(fileNode).toBeVisible({ timeout: 10_000 })
    await fileNode.click()
    await page.waitForTimeout(300)

    // Cmd+C should copy the file path
    await page.keyboard.press('Meta+c')
    await page.waitForTimeout(300)

    const copied = await getClipboardSpy(page)
    expect(copied).toBe(testFile)
  })

  test('copies folder path when folder is focused', async ({ page }) => {
    // Click the folder in the explorer
    const folderNode = page.locator(`[role="treeitem"]:has-text("${testDir}")`).first()
    await expect(folderNode).toBeVisible({ timeout: 10_000 })
    await folderNode.click()
    await page.waitForTimeout(300)

    // Cmd+C should copy the folder path
    await page.keyboard.press('Meta+c')
    await page.waitForTimeout(300)

    const copied = await getClipboardSpy(page)
    expect(copied).toBe(testDir)
  })
})
