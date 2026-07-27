import { test, expect } from '@playwright/test'
import {
  provisionWorkspace,
  createTestFile,
  openFileViaSearch,
  uniqueFileName,
} from './helpers/workspace'

test.describe('Markdown preview', () => {
  // The panel tree sets `select-none` for its pane drags and that inherits into
  // every panel, so a reading surface has to opt back in or its text cannot be
  // selected or copied at all.
  test('rendered text can be selected for copying', async ({ page, request }) => {
    const project = await provisionWorkspace(page, request)
    const fileName = uniqueFileName('selectable_preview.md')

    try {
      await createTestFile(page, project.name, fileName, '# Heading\n\nSELECTABLE_PARAGRAPH_TEXT here.\n')
      await openFileViaSearch(page, fileName)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()

      const paragraph = page.locator('.markdown-preview p', { hasText: 'SELECTABLE_PARAGRAPH_TEXT' })
      await paragraph.waitFor()
      const box = (await paragraph.boundingBox())!

      await page.mouse.move(box.x + 3, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 10 })
      await page.mouse.up()

      const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
      expect(selected).toContain('SELECTABLE_PARAGRAPH_TEXT')
    } finally {
      await project.dispose()
    }
  })
})
