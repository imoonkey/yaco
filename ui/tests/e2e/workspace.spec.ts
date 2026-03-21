import { test, expect, type Page } from '@playwright/test'

// --- Helpers ---

/** Wait for the app to load and switch to workspace view with a project selected */
async function openWorkspace(page: Page) {
  await page.goto('/')
  // Wait for the app shell to render
  await expect(page.locator('header')).toBeVisible({ timeout: 10_000 })

  // Get first project from API
  const projects = await page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<{ name: string; path: string }[]>
  })
  expect(projects.length).toBeGreaterThan(0)
  const project = projects[0]

  // Click Workspace nav
  await page.locator('button', { hasText: 'Workspace' }).click()
  // Click the project tab
  await page.locator('button', { hasText: project.name }).click()

  return project
}

/** Open a file in the editor by clicking it in the explorer */
async function openFileInExplorer(page: Page, fileName: string) {
  // Find and click the file in the explorer tree
  const fileNode = page.locator(`[data-testid="tree-node"]`, { hasText: fileName }).first()
  if (await fileNode.isVisible()) {
    await fileNode.dblclick()
    return
  }
  // Fallback: use file search (Cmd+P)
  await page.keyboard.press('Meta+p')
  await page.locator('input[placeholder="Search files..."]').fill(fileName)
  await page.keyboard.press('Enter')
}

/** Wait for SSE refresh to propagate (SSE watcher fires events, UI refetches) */
async function waitForSSERefresh(page: Page, timeoutMs = 8000) {
  // Wait for network activity to settle after SSE event
  await page.waitForTimeout(timeoutMs)
}

/** Write content to a file via the API */
async function writeFileViaAPI(page: Page, projectName: string, filePath: string, content: string) {
  // First get current revision
  const getRes = await page.evaluate(async ({ projectName, filePath }) => {
    const res = await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`)
    return res.json() as Promise<{ content: string; revision: number }>
  }, { projectName, filePath })

  // Write with revision
  await page.evaluate(async ({ projectName, filePath, content, revision }) => {
    await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseRevision: revision }),
    })
  }, { projectName, filePath, content, revision: getRes.revision })
}

/** Get file content from API */
async function getFileContent(page: Page, projectName: string, filePath: string) {
  return page.evaluate(async ({ projectName, filePath }) => {
    const res = await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`)
    return res.json() as Promise<{ content: string; revision: number }>
  }, { projectName, filePath })
}

// --- Tests ---

test.describe('Workspace regression', () => {
  test('clean tab refresh via SSE', async ({ page }) => {
    const project = await openWorkspace(page)

    // Create a test file via API
    const testPath = '__e2e_test_sse.txt'
    const initialContent = 'initial content\n'
    await page.evaluate(async ({ projectName, path }) => {
      await fetch(`/api/files/${encodeURIComponent(projectName)}/create-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    }, { projectName: project.name, path: testPath })
    await writeFileViaAPI(page, project.name, testPath, initialContent)

    // Wait for file tree to update
    await waitForSSERefresh(page, 3000)

    // Open file in editor via file search
    await page.keyboard.press('Meta+p')
    await page.locator('input[placeholder="Search files..."]').fill('__e2e_test_sse')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)

    // Verify initial content is visible in editor
    // CodeMirror renders content in .cm-content
    const editorContent = page.locator('.cm-content')
    await expect(editorContent).toContainText('initial content')

    // Modify file externally via API
    const updatedContent = 'initial content\nupdated via API\n'
    await writeFileViaAPI(page, project.name, testPath, updatedContent)

    // Wait for SSE refresh to propagate
    await waitForSSERefresh(page)

    // Verify editor shows updated content
    // Note: CodeMirror virtualizes offscreen lines, so we check the content element
    await expect(editorContent).toContainText('updated via API', { timeout: 10_000 })

    // Cleanup: delete test file
    await page.evaluate(async ({ projectName, path }) => {
      await fetch(`/api/files/${encodeURIComponent(projectName)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    }, { projectName: project.name, path: testPath })
  })

  test('conflict detection: dirty tab + external change shows banner', async ({ page }) => {
    const project = await openWorkspace(page)

    // Create a test file
    const testPath = '__e2e_test_conflict.txt'
    const initialContent = 'line one\nline two\nline three\n'
    await page.evaluate(async ({ projectName, path }) => {
      await fetch(`/api/files/${encodeURIComponent(projectName)}/create-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    }, { projectName: project.name, path: testPath })
    await writeFileViaAPI(page, project.name, testPath, initialContent)
    await waitForSSERefresh(page, 3000)

    // Open file
    await page.keyboard.press('Meta+p')
    await page.locator('input[placeholder="Search files..."]').fill('__e2e_test_conflict')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)

    // Type to make it dirty
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('DIRTY EDIT ')

    // Verify dirty indicator appears (dot in tab)
    await page.waitForTimeout(500)

    // Modify file externally to trigger conflict
    const externalContent = 'externally modified content\n'
    await writeFileViaAPI(page, project.name, testPath, externalContent)

    // Wait for SSE to detect conflict
    await waitForSSERefresh(page)

    // Verify conflict banner appears
    const banner = page.locator('text=File changed on disk')
    await expect(banner).toBeVisible({ timeout: 15_000 })

    // Verify both resolution buttons are present
    await expect(page.locator('button', { hasText: 'Accept Disk Version' })).toBeVisible()
    await expect(page.locator('button', { hasText: 'Keep Mine' })).toBeVisible()

    // Click "Accept Disk Version" to resolve
    await page.locator('button', { hasText: 'Accept Disk Version' }).click()

    // Verify banner disappears and content is the external version
    await expect(banner).not.toBeVisible({ timeout: 5000 })
    await expect(editor).toContainText('externally modified content')

    // Cleanup
    await page.evaluate(async ({ projectName, path }) => {
      await fetch(`/api/files/${encodeURIComponent(projectName)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    }, { projectName: project.name, path: testPath })
  })

  test('draft persistence across browser refresh', async ({ page }) => {
    const project = await openWorkspace(page)

    // Create a test file
    const testPath = '__e2e_test_draft.txt'
    const initialContent = 'original content\n'
    await page.evaluate(async ({ projectName, path }) => {
      await fetch(`/api/files/${encodeURIComponent(projectName)}/create-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    }, { projectName: project.name, path: testPath })
    await writeFileViaAPI(page, project.name, testPath, initialContent)
    await waitForSSERefresh(page, 3000)

    // Open file
    await page.keyboard.press('Meta+p')
    await page.locator('input[placeholder="Search files..."]').fill('__e2e_test_draft')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)

    // Type unsaved edits
    const editor = page.locator('.cm-content')
    await editor.click()
    await page.keyboard.type('DRAFT CONTENT ')

    // Wait for draft to be captured
    await page.waitForTimeout(1000)

    // Verify dirty indicator (tab should show dot)
    // The tab with the file should exist — scope to tab bar to avoid matching git changes row
    const tabBar = page.locator('.overflow-x-auto')
    const tab = tabBar.locator('[title="__e2e_test_draft.txt"]')
    await expect(tab).toBeVisible()

    // Refresh the page — localStorage is flushed on beforeunload
    await page.reload()
    await expect(page.locator('header')).toBeVisible({ timeout: 10_000 })

    // Switch to workspace if needed
    await page.locator('button', { hasText: 'Workspace' }).click()
    await page.waitForTimeout(2000)

    // Tab should survive the refresh
    const restoredTabBar = page.locator('.overflow-x-auto')
    const restoredTab = restoredTabBar.locator('[title="__e2e_test_draft.txt"]')
    await expect(restoredTab).toBeVisible({ timeout: 10_000 })

    // Click the tab to make it active
    await restoredTab.click()
    await page.waitForTimeout(1000)

    // Verify draft content was restored
    const restoredEditor = page.locator('.cm-content')
    await expect(restoredEditor).toContainText('DRAFT CONTENT', { timeout: 5000 })

    // Cleanup
    await page.evaluate(async ({ projectName, path }) => {
      await fetch(`/api/files/${encodeURIComponent(projectName)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    }, { projectName: project.name, path: testPath })
  })
})
