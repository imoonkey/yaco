import { test, expect, type Page } from '@playwright/test'
import {
  provisionWorkspace,
  openFileViaSearch,
  openPinnedFile,
  waitForSSERefresh,
  uniqueFileName,
  group,
} from './helpers/workspace'

// USER-QA for the PER-TAB editor view mode (edit / split / preview). The mode used
// to be GLOBAL, so it was impossible to preview one file while split-editing another.
// These flows drive the SAME segmented control the user clicks (the group tab bar's
// Edit/Split/Preview buttons) and assert USER-OBSERVABLE independence: two tabs hold
// different modes at the same time, and a tab keeps its mode across a switch.

test.use({ viewport: { width: 1360, height: 860 } })

// The per-group toggle buttons live in each group's tab bar (EditorActions). Scope
// by group so the two groups' controls never collide.
const previewBtn = (page: Page, groupId: string) =>
  group(page, groupId).getByRole('button', { name: 'Preview', exact: true })
const splitBtn = (page: Page, groupId: string) =>
  group(page, groupId).getByRole('button', { name: /Split preview/ })
const splitRightGroup = (page: Page, groupId: string) =>
  group(page, groupId).locator('[data-testid="split-group-right"]')
const editorBody = (page: Page, groupId: string) =>
  group(page, groupId).locator('[data-panel-leaf="editor"]')
const tabInGroup = (page: Page, groupId: string, title: string) =>
  group(page, groupId).locator(`[data-testid="group-tab"][title="${title}"]`)

test.describe('USER-QA: per-tab editor view mode', () => {
  test('an HTML tab in preview coexists with a Markdown tab in split — the two modes are independent', async ({ page, request }) => {
    const htmlName = uniqueFileName('per_tab_view.html')
    const mdName = uniqueFileName('per_tab_view.md')
    const html = '<!doctype html><html><head><title>PT</title></head><body><h1 id="hd">PERTAB HTML</h1></body></html>'
    const md = '# PerTab Heading\n\nsome **markdown** body text\n'
    const project = await provisionWorkspace(page, request, { files: { [htmlName]: html, [mdName]: md } })

    try {
      // group:1 shows the HTML file (default: edit — the editor is mounted).
      await openFileViaSearch(page, htmlName)
      await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('PERTAB HTML', { timeout: 10_000 })

      // Split right → group:2 is seeded with a duplicate of the HTML, then focused;
      // opening the Markdown file there makes MD group:2's active tab.
      await splitRightGroup(page, 'group:1').click()
      await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
      await openFileViaSearch(page, mdName)
      await expect(tabInGroup(page, 'group:2', mdName)).toBeVisible({ timeout: 10_000 })

      // Flip group:1's HTML tab to PREVIEW → its body becomes the sandboxed iframe.
      await previewBtn(page, 'group:1').click()
      await expect(group(page, 'group:1').locator('iframe[title="HTML preview"]')).toBeVisible({ timeout: 10_000 })

      // THE PER-TAB PROOF (single snapshot): at the same instant, group:1 shows the
      // HTML PREVIEW (iframe, no editor) while group:2 still shows the Markdown EDITOR.
      // Under the old GLOBAL mode this pairing was impossible — one flip moved both.
      await expect(group(page, 'group:1').locator('iframe[title="HTML preview"]')).toBeVisible()
      await expect(editorBody(page, 'group:2').locator('.cm-content')).toContainText('PerTab Heading')

      // Flip group:2's Markdown tab to SPLIT → it shows editor AND preview together,
      // and group:1's HTML preview is UNCHANGED (the second flip is independent too).
      await splitBtn(page, 'group:2').click()
      await expect(editorBody(page, 'group:2').locator('.cm-content')).toContainText('PerTab Heading', { timeout: 10_000 })
      await expect(editorBody(page, 'group:2').locator('.markdown-preview')).toBeVisible()
      await expect(group(page, 'group:1').locator('iframe[title="HTML preview"]')).toBeVisible()
    } finally {
      await project.dispose()
    }
  })

  test("a tab keeps its own mode when you switch away and back", async ({ page, request }) => {
    const mdA = uniqueFileName('keep_a.md')
    const mdB = uniqueFileName('keep_b.md')
    const project = await provisionWorkspace(page, request, {
      files: { [mdA]: '# Alpha doc\n\nalpha body\n', [mdB]: '# Beta doc\n\nbeta body\n' },
    })

    try {
      // Two Markdown files as two tabs in ONE group.
      await openPinnedFile(page, mdA)
      await openPinnedFile(page, mdB)
      await waitForSSERefresh(page, 1500)
      await expect(tabInGroup(page, 'group:1', mdA)).toBeVisible({ timeout: 10_000 })
      await expect(tabInGroup(page, 'group:1', mdB)).toBeVisible()

      // Put tab A into PREVIEW; leave B at the default (edit).
      await tabInGroup(page, 'group:1', mdA).click()
      await previewBtn(page, 'group:1').click()
      await expect(editorBody(page, 'group:1').locator('.markdown-preview')).toContainText('Alpha doc', { timeout: 10_000 })

      // Switch to B → it is EDIT (its own default), the editor is mounted.
      await tabInGroup(page, 'group:1', mdB).click()
      await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('Beta doc', { timeout: 10_000 })

      // Switch back to A → it is STILL in PREVIEW (mode is the tab's, not the group's).
      await tabInGroup(page, 'group:1', mdA).click()
      await expect(editorBody(page, 'group:1').locator('.markdown-preview')).toContainText('Alpha doc', { timeout: 10_000 })

      // ...and the per-tab mode SURVIVES A RELOAD: A comes back in preview, B in edit.
      await page.reload()
      await expect(tabInGroup(page, 'group:1', mdA)).toBeVisible({ timeout: 15_000 })
      await tabInGroup(page, 'group:1', mdA).click()
      await expect(editorBody(page, 'group:1').locator('.markdown-preview')).toContainText('Alpha doc', { timeout: 10_000 })
      await tabInGroup(page, 'group:1', mdB).click()
      await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('Beta doc', { timeout: 10_000 })
    } finally {
      await project.dispose()
    }
  })
})
