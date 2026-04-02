import { test, expect, type Page } from '@playwright/test'

// --- Helpers ---

async function openWorkspace(page: Page) {
  await page.goto('/')
  await expect(page.locator('main')).toBeVisible({ timeout: 10_000 })
  const projects = await page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<{ name: string; path: string }[]>
  })
  expect(projects.length).toBeGreaterThan(0)
  const project = projects[0]
  await page.locator('button', { hasText: project.name }).click()
  return project
}

async function deleteFileIfExists(page: Page, projectName: string, path: string) {
  await page.evaluate(async ({ projectName, path }) => {
    await fetch(`/api/files/${encodeURIComponent(projectName)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  }, { projectName, path })
}

async function fileExistsOnServer(page: Page, projectName: string, path: string): Promise<boolean> {
  return page.evaluate(async ({ projectName, path }) => {
    const res = await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(path)}`)
    return res.ok
  }, { projectName, path })
}

async function dirExistsOnServer(page: Page, projectName: string, path: string): Promise<boolean> {
  return page.evaluate(async ({ projectName, path }) => {
    const res = await fetch(`/api/files/${encodeURIComponent(projectName)}/children?dir=${encodeURIComponent(path)}`)
    return res.ok
  }, { projectName, path })
}

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
  let projectName: string

  test.afterEach(async ({ page }) => {
    if (!projectName) return
    // Clean up all test files/dirs
    for (const path of [
      '__e2e_create_root.txt',
      'doc/__e2e_create_subdir.txt',
      '__e2e_create_rootdir',
      'doc/__e2e_create_subdir_folder',
    ]) {
      await deleteFileIfExists(page, projectName, path)
    }
  })

  test('create file at root via header button', async ({ page }) => {
    const project = await openWorkspace(page)
    projectName = project.name

    await page.waitForTimeout(3000)

    // Click the "New File" header button
    await page.locator('button[title="New File"]').click()

    // Inline edit should appear
    const input = page.locator('input.bg-transparent')
    await expect(input).toBeVisible({ timeout: 3000 })

    // Type and submit
    await input.type('__e2e_create_root.txt')
    await input.press('Enter')

    // File should exist on server
    await page.waitForTimeout(2000)
    expect(await fileExistsOnServer(page, project.name, '__e2e_create_root.txt')).toBe(true)

    // File should appear in the tree after SSE refresh
    expect(await waitForTreeItem(page, '__e2e_create_root')).toBe(true)
  })

  test('create file inside directory via context menu', async ({ page }) => {
    const project = await openWorkspace(page)
    projectName = project.name

    await page.waitForTimeout(3000)

    // Right-click on the "doc" folder
    const docFolder = page.locator('[role="treeitem"]', { hasText: 'doc' }).first()
    await expect(docFolder).toBeVisible({ timeout: 5000 })
    await docFolder.click({ button: 'right' })

    // Click "New File"
    await page.getByText('New File', { exact: true }).click()

    // Inline edit
    const input = page.locator('input.bg-transparent')
    await expect(input).toBeVisible({ timeout: 3000 })
    await input.type('__e2e_create_subdir.txt')
    await input.press('Enter')

    // File should exist on server
    await page.waitForTimeout(2000)
    expect(await fileExistsOnServer(page, project.name, 'doc/__e2e_create_subdir.txt')).toBe(true)

    // File should appear in the tree (regression: previously didn't because
    // parent dir wasn't registered for SSE refresh)
    expect(await waitForTreeItem(page, '__e2e_create_subdir')).toBe(true)
  })

  test('create folder at root via header button', async ({ page }) => {
    const project = await openWorkspace(page)
    projectName = project.name

    await page.waitForTimeout(3000)

    // Click "New Folder" header button
    await page.locator('button[title="New Folder"]').click()

    const input = page.locator('input.bg-transparent')
    await expect(input).toBeVisible({ timeout: 3000 })
    await input.type('__e2e_create_rootdir')
    await input.press('Enter')

    await page.waitForTimeout(2000)
    expect(await dirExistsOnServer(page, project.name, '__e2e_create_rootdir')).toBe(true)
  })

  test('create folder inside directory via context menu', async ({ page }) => {
    const project = await openWorkspace(page)
    projectName = project.name

    await page.waitForTimeout(3000)

    const docFolder = page.locator('[role="treeitem"]', { hasText: 'doc' }).first()
    await expect(docFolder).toBeVisible({ timeout: 5000 })
    await docFolder.click({ button: 'right' })

    await page.getByText('New Folder', { exact: true }).click()

    const input = page.locator('input.bg-transparent')
    await expect(input).toBeVisible({ timeout: 3000 })
    await input.type('__e2e_create_subdir_folder')
    await input.press('Enter')

    await page.waitForTimeout(2000)
    expect(await dirExistsOnServer(page, project.name, 'doc/__e2e_create_subdir_folder')).toBe(true)

    // Folder should appear in tree (same regression as file case)
    expect(await waitForTreeItem(page, '__e2e_create_subdir_folder')).toBe(true)
  })
})
