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

async function createTestFile(page: Page, projectName: string, path: string, content: string) {
  await page.evaluate(async ({ projectName, path }) => {
    await fetch(`/api/files/${encodeURIComponent(projectName)}/create-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  }, { projectName, path })
  await page.evaluate(async ({ projectName, path, content }) => {
    const res = await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(path)}`)
    const { revision } = await res.json() as { revision: number }
    await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseRevision: revision }),
    })
  }, { projectName, path, content })
}

async function deleteTestFile(page: Page, projectName: string, path: string) {
  await page.evaluate(async ({ projectName, path }) => {
    await fetch(`/api/files/${encodeURIComponent(projectName)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  }, { projectName, path })
}

/** Open a file as preview via file search (Cmd+P) */
async function openFileViaSearch(page: Page, fileName: string) {
  await page.keyboard.press('Meta+p')
  const input = page.locator('input[placeholder="Search files..."]')
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill(fileName)
  await page.waitForTimeout(500)
  // Click the top result rather than pressing Enter: after a CodeMirror edit the
  // editor swallows the search input's Enter keydown, so selection never fires.
  await page.locator('[data-search-result-idx="0"]').click()
  await page.waitForTimeout(1000)
}

function tabBar(page: Page) {
  return page.locator('.overflow-x-auto')
}

function tab(page: Page, title: string) {
  return tabBar(page).locator(`[title="${title}"]`)
}

function tabText(page: Page, title: string) {
  return tab(page, title).locator('span.truncate')
}

// --- Tests ---

test.describe('Tab lifecycle characterization', () => {
  const fileA = '__e2e_char_tab_a.txt'
  const fileB = '__e2e_char_tab_b.txt'
  const fileC = '__e2e_char_tab_c.txt'
  let project: { name: string; path: string }

  test.beforeEach(async ({ page }) => {
    project = await openWorkspace(page)
    await createTestFile(page, project.name, fileA, 'content of file A\n')
    await createTestFile(page, project.name, fileB, 'content of file B\n')
    await createTestFile(page, project.name, fileC, 'content of file C\n')
    await page.waitForTimeout(3000) // SSE propagation
  })

  test.afterEach(async ({ page }) => {
    for (const f of [fileA, fileB, fileC]) {
      await deleteTestFile(page, project.name, f)
    }
  })

  test('preview tab has italic text', async ({ page }) => {
    await openFileViaSearch(page, fileA)
    const text = tabText(page, fileA)
    await expect(text).toBeVisible()
    await expect(text).toHaveCSS('font-style', 'italic')
  })

  test('opening a second preview replaces the first', async ({ page }) => {
    await openFileViaSearch(page, fileA)
    await expect(tab(page, fileA)).toBeVisible()

    await openFileViaSearch(page, fileB)
    await expect(tab(page, fileB)).toBeVisible()
    // First preview should be gone
    await expect(tab(page, fileA)).not.toBeVisible()
  })

  test('editing a preview auto-pins it (removes italic)', async ({ page }) => {
    await openFileViaSearch(page, fileA)
    await expect(tabText(page, fileA)).toHaveCSS('font-style', 'italic')

    // Type to trigger auto-pin via updateFileDraft
    await page.locator('.cm-content').click()
    await page.keyboard.type('X')
    await page.waitForTimeout(500)

    // No longer italic — auto-pinned
    await expect(tabText(page, fileA)).not.toHaveCSS('font-style', 'italic')
  })

  test('auto-pinned preview is not replaced by next preview', async ({ page }) => {
    // Open A as preview, edit to auto-pin
    await openFileViaSearch(page, fileA)
    await page.locator('.cm-content').click()
    await page.keyboard.type('X')
    await page.waitForTimeout(500)

    // Open B as preview — A should survive since it was auto-pinned
    await openFileViaSearch(page, fileB)
    await expect(tab(page, fileA)).toBeVisible()
    await expect(tab(page, fileB)).toBeVisible()
  })

  test('dirty tab shows dot indicator and hides close button', async ({ page }) => {
    await openFileViaSearch(page, fileA)

    // Edit to make dirty
    await page.locator('.cm-content').click()
    await page.keyboard.type('DIRTY')
    await page.waitForTimeout(500)

    const t = tab(page, fileA)
    // Dot indicator visible
    await expect(t.locator('.rounded-full')).toBeVisible()
    // Close button (x) should not be visible even on hover
    await t.hover()
    await expect(t.locator('button:has-text("×")')).not.toBeVisible()
  })

  test('closing active tab selects a neighbor', async ({ page }) => {
    // Open three pinned tabs: A, B, C
    for (const f of [fileA, fileB, fileC]) {
      await openFileViaSearch(page, f)
      await tab(page, f).dblclick() // pin via double-click
      await page.waitForTimeout(300)
    }

    // Make B active
    await tab(page, fileB).click()
    await page.waitForTimeout(200)

    // Close B with Cmd+W
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(500)

    // B should be gone
    await expect(tab(page, fileB)).not.toBeVisible()

    // A neighbor should be active — editor shows its content
    const editor = page.locator('.cm-content')
    const text = await editor.textContent()
    const isNeighbor = text?.includes('content of file A') || text?.includes('content of file C')
    expect(isNeighbor).toBe(true)
  })

  test('double-click preview tab pins it', async ({ page }) => {
    await openFileViaSearch(page, fileA)
    await expect(tabText(page, fileA)).toHaveCSS('font-style', 'italic')

    // Double-click to pin
    await tab(page, fileA).dblclick()
    await page.waitForTimeout(300)

    // No longer italic
    await expect(tabText(page, fileA)).not.toHaveCSS('font-style', 'italic')
  })

  test('pinned tab survives next preview open', async ({ page }) => {
    // Open A as preview, pin via double-click
    await openFileViaSearch(page, fileA)
    await tab(page, fileA).dblclick()
    await page.waitForTimeout(300)

    // Open B as preview
    await openFileViaSearch(page, fileB)

    // Both should be visible
    await expect(tab(page, fileA)).toBeVisible()
    await expect(tab(page, fileB)).toBeVisible()
  })

  test('diff tab coexists with file tabs', async ({ page }) => {
    // Open file A as a pinned file tab
    await openFileViaSearch(page, fileA)
    await tab(page, fileA).dblclick()
    await page.waitForTimeout(300)

    // Find the change item in the sidebar Changes section (not in the tab bar).
    // Change items use class `items-start`; tab bar items use `items-center`.
    const changeItem = page.locator(`.items-start[title="${fileA}"]`).first()
    const hasChange = await changeItem.isVisible({ timeout: 5000 }).catch(() => false)

    if (hasChange) {
      // Click the change to open a diff preview tab
      await changeItem.click()
      await page.waitForTimeout(500)

      // Both file tab and diff tab should be present
      await expect(tab(page, fileA)).toBeVisible()
      await expect(tab(page, `diff:${fileA}`)).toBeVisible()

      // Diff tab should display "(diff)" in its text
      const diffText = tabText(page, `diff:${fileA}`)
      await expect(diffText).toContainText('(diff)')
    }
  })
})
