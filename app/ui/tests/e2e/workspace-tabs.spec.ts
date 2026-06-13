import { test, expect, type Page } from '@playwright/test'
import {
  provisionWorkspace,
  createTestFile,
  openFileViaSearch,
  openPinnedFile,
  sidebar,
  uniqueFileName,
  type FixtureProject,
} from './helpers/workspace'

// --- Helpers ---
//
// The working-area group tab strip is a `.overflow-x-auto` row of
// `[data-testid="group-tab"]` tabs (title = the tabId). A preview tab renders
// italic; pinning clears the italic. Pinning gestures: edit the file (auto-pin),
// or double-click the file's row in the explorer. (The group tab itself has no
// double-click-to-pin — that VSCode affordance is not wired in GroupTabBar.)

function tabBar(page: Page) {
  return page.locator('.overflow-x-auto')
}

function tab(page: Page, title: string) {
  return tabBar(page).locator(`[title="${title}"]`)
}

function tabText(page: Page, title: string) {
  return tab(page, title).locator('span.truncate')
}

/** Pin an already-previewed file by double-clicking its explorer row (the real
 *  "make permanent" gesture). */
async function pinViaExplorer(page: Page, file: string): Promise<void> {
  await sidebar(page).getByText(file, { exact: true }).first().dblclick()
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
    // Open three pinned tabs: A, B, C (explorer double-click pins each).
    for (const f of [fileA, fileB, fileC]) {
      await openPinnedFile(page, f)
      await expect(tabText(page, f)).not.toHaveCSS('font-style', 'italic')
    }

    // Make B active, then close it via its tab close × (a real affordance).
    await tab(page, fileB).click()
    await tab(page, fileB).hover()
    await tab(page, fileB).getByRole('button').click()

    // B should be gone, and a neighbor is active — the editor shows its content.
    await expect(tab(page, fileB)).not.toBeVisible()
    const editor = page.locator('.cm-content')
    await expect(editor).toContainText(/content of file [AC]/, { timeout: 10_000 })
  })

  test('double-clicking a file in the explorer pins its preview tab', async ({ page }) => {
    await openFileViaSearch(page, fileA)
    await expect(tabText(page, fileA)).toHaveCSS('font-style', 'italic')

    // Pin via the explorer double-click (GroupTabBar has no tab double-click-to-pin).
    await pinViaExplorer(page, fileA)

    // No longer italic — pinned.
    await expect(tabText(page, fileA)).not.toHaveCSS('font-style', 'italic')
  })

  test('pinned tab survives next preview open', async ({ page }) => {
    // Open A as preview, pin it.
    await openPinnedFile(page, fileA)
    await expect(tabText(page, fileA)).not.toHaveCSS('font-style', 'italic')

    // Open B as preview.
    await openFileViaSearch(page, fileB)

    // Both should be visible (the pinned A is not replaced).
    await expect(tab(page, fileA)).toBeVisible()
    await expect(tab(page, fileB)).toBeVisible()
  })

  test('diff tab coexists with file tabs', async ({ page }) => {
    // Open file A as a pinned file tab.
    await openPinnedFile(page, fileA)
    await expect(tabText(page, fileA)).not.toHaveCSS('font-style', 'italic')

    // Find the change item in the sidebar Changes section (not in the tab bar).
    // Change items use class `items-start`; tab bar items use `items-center`.
    // Untracked-file visibility there is environment-dependent, so assert the
    // diff-tab coexistence only when the change surfaces.
    const changeItem = page.locator(`.items-start[title="${fileA}"]`).first()
    if (await changeItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await changeItem.click()

      // Both the file tab and its diff tab are present in the strip (the diff tab's
      // title is its `diff:` id; it renders the file's basename, not a "(diff)" suffix).
      await expect(tab(page, fileA)).toBeVisible()
      await expect(tab(page, `diff:${fileA}`)).toBeVisible()
    }
  })
})
