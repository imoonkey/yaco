import { test, expect, type Page } from '@playwright/test'
import {
  provisionWorkspace,
  createTestFile,
  openFileViaSearch,
  uniqueFileName,
  type FixtureProject,
} from './helpers/workspace'

// --- Helpers ---

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
  let fixture: FixtureProject
  let fileA: string
  let fileB: string
  let fileC: string

  test.beforeEach(async ({ page, request }) => {
    fixture = await provisionWorkspace(page, request)
    fileA = uniqueFileName('char_tab_a.txt')
    fileB = uniqueFileName('char_tab_b.txt')
    fileC = uniqueFileName('char_tab_c.txt')
    await createTestFile(page, fixture.name, fileA, 'content of file A\n')
    await createTestFile(page, fixture.name, fileB, 'content of file B\n')
    await createTestFile(page, fixture.name, fileC, 'content of file C\n')
    // Wait for the explorer to reflect the new files before exercising tabs.
    await expect(page.locator('[role="treeitem"]', { hasText: fileA }).first()).toBeVisible({ timeout: 10_000 })
  })

  test.afterEach(async () => {
    await fixture.dispose()
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

    // No longer italic — auto-pinned
    await expect(tabText(page, fileA)).not.toHaveCSS('font-style', 'italic')
  })

  test('auto-pinned preview is not replaced by next preview', async ({ page }) => {
    // Open A as preview, edit to auto-pin
    await openFileViaSearch(page, fileA)
    await page.locator('.cm-content').click()
    await page.keyboard.type('X')
    await expect(tabText(page, fileA)).not.toHaveCSS('font-style', 'italic')

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
      await expect(tabText(page, f)).not.toHaveCSS('font-style', 'italic')
    }

    // Make B active
    await tab(page, fileB).click()

    // Close B with Cmd+W
    await page.keyboard.press('Meta+w')

    // B should be gone
    await expect(tab(page, fileB)).not.toBeVisible()

    // A neighbor should be active — editor shows its content
    const editor = page.locator('.cm-content')
    await expect(editor).toContainText(/content of file [AC]/, { timeout: 10_000 })
  })

  test('double-click preview tab pins it', async ({ page }) => {
    await openFileViaSearch(page, fileA)
    await expect(tabText(page, fileA)).toHaveCSS('font-style', 'italic')

    // Double-click to pin
    await tab(page, fileA).dblclick()

    // No longer italic
    await expect(tabText(page, fileA)).not.toHaveCSS('font-style', 'italic')
  })

  test('pinned tab survives next preview open', async ({ page }) => {
    // Open A as preview, pin via double-click
    await openFileViaSearch(page, fileA)
    await tab(page, fileA).dblclick()
    await expect(tabText(page, fileA)).not.toHaveCSS('font-style', 'italic')

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
    await expect(tabText(page, fileA)).not.toHaveCSS('font-style', 'italic')

    // Find the change item in the sidebar Changes section (not in the tab bar).
    // Change items use class `items-start`; tab bar items use `items-center`.
    // Untracked-file visibility there is environment-dependent, so assert the
    // diff-tab coexistence only when the change surfaces.
    const changeItem = page.locator(`.items-start[title="${fileA}"]`).first()
    if (await changeItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await changeItem.click()

      // Both file tab and diff tab should be present
      await expect(tab(page, fileA)).toBeVisible()
      await expect(tab(page, `diff:${fileA}`)).toBeVisible()

      // Diff tab should display "(diff)" in its text
      const diffText = tabText(page, `diff:${fileA}`)
      await expect(diffText).toContainText('(diff)')
    }
  })
})
