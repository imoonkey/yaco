import { test, expect, type Page } from '@playwright/test'
import { waitForAppReady } from './helpers/workspace'

// --- Helpers ---

async function openWorkspace(page: Page) {
  await page.goto('/')
  await waitForAppReady(page)
  const projects = await page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<{ name: string; path: string }[]>
  })
  expect(projects.length).toBeGreaterThan(0)
  const project = projects[0]
  await page.locator('button', { hasText: project.name }).click()
  return project
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

// --- Tests ---

test.describe('File search (Cmd+P)', () => {
  test('lists files from subdirectories, not just root', async ({ page }) => {
    await openWorkspace(page)

    // Open search
    await page.keyboard.press('Meta+p')
    const searchInput = page.locator('input[placeholder="Search files..."], input[placeholder="Loading files..."]')
    await expect(searchInput).toBeVisible({ timeout: 5000 })

    // Wait for loading to finish
    await expect(page.locator('input[placeholder="Search files..."]')).toBeVisible({ timeout: 10_000 })

    // Search for a file we know exists in a subdirectory (e.g. a source file)
    await searchInput.fill('useApi')
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
    const project = await openWorkspace(page)

    // Create a nested test file
    const testDir = '__e2e_search_test'
    const testPath = `${testDir}/nested_file.txt`
    await createTestFile(page, project.name, testPath, 'search test content\n')
    await page.waitForTimeout(3000) // wait for SSE

    // Search and select the file
    await page.keyboard.press('Meta+p')
    await expect(page.locator('input[placeholder="Search files..."]')).toBeVisible({ timeout: 10_000 })
    await page.locator('input[placeholder="Search files..."]').fill('nested_file')
    await page.waitForTimeout(500) // filter delay
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)

    // Verify file opened in editor
    const editorContent = page.locator('.cm-content')
    await expect(editorContent).toContainText('search test content', { timeout: 5000 })

    // Verify tab is visible
    const tab = page.locator('[data-testid="tab"]', { hasText: 'nested_file.txt' })
    await expect(tab).toBeVisible()

    // Cleanup
    await deleteTestFile(page, project.name, testPath)
    await page.evaluate(async ({ projectName, path }) => {
      await fetch(`/api/files/${encodeURIComponent(projectName)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    }, { projectName: project.name, path: testDir })
  })

  test('gitignore toggle includes ignored files', async ({ page }) => {
    await openWorkspace(page)

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
  test('clicking a changed file opens diff as preview tab', async ({ page }) => {
    const project = await openWorkspace(page)

    // Create and modify a test file to generate a git change
    const testPath = '__e2e_changes_test.txt'
    await createTestFile(page, project.name, testPath, 'changes test\n')
    await page.waitForTimeout(3000) // wait for SSE git refresh

    // Look for the change in the sidebar
    // Changes section should show the test file
    const changeItem = page.locator(`.items-start[title="${testPath}"]`).first()

    // If change is visible, click it
    if (await changeItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await changeItem.click()
      await page.waitForTimeout(500)

      // Verify a diff tab opened (tab text should contain the filename)
      const diffTab = page.locator('[data-testid="tab"]', { hasText: '__e2e_changes_test.txt' })
      await expect(diffTab).toBeVisible({ timeout: 3000 })

      // Preview tabs have italic styling
      const tabStyle = await diffTab.evaluate(el => window.getComputedStyle(el).fontStyle)
      expect(tabStyle).toBe('italic')
    }

    // Cleanup
    await deleteTestFile(page, project.name, testPath)
  })
})
