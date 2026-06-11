import { test, expect } from '@playwright/test'
import {
  provisionWorkspace,
  createTestFile,
  openFileViaSearch,
  uniqueFileName,
} from './helpers/workspace'

test.describe('HTML preview', () => {
  test('fragment links scroll inside srcdoc instead of loading the app shell', async ({ page, request }) => {
    const project = await provisionWorkspace(page, request)
    const fileName = uniqueFileName('html_preview_anchor.html')
    const content = `<!doctype html>
<html>
<head>
  <title>Anchor Preview Test</title>
  <style>
    body { margin: 0; font-family: sans-serif; }
    .spacer { height: 1200px; }
  </style>
</head>
<body>
  <a href="#target">Jump</a>
  <div class="spacer"></div>
  <section id="target">Target content</section>
</body>
</html>`

    try {
      await createTestFile(page, project.name, fileName, content)
      await openFileViaSearch(page, fileName)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()
      await page.waitForSelector('iframe[title="HTML preview"]', { timeout: 10_000 })

      const frame = await (await page.locator('iframe[title="HTML preview"]').elementHandle())?.contentFrame()
      expect(frame).not.toBeNull()
      if (!frame) return

      await frame.waitForSelector('a[href="#target"]', { timeout: 10_000 })
      await frame.click('a[href="#target"]')
      await expect
        .poll(() => frame.evaluate(() => window.scrollY), { timeout: 5_000 })
        .toBeGreaterThan(0)

      const state = await frame.evaluate(() => ({
        href: location.href,
        title: document.title,
        text: document.body.innerText,
      }))

      expect(state.href).toBe('about:srcdoc#target')
      expect(state.title).toBe('Anchor Preview Test')
      expect(state.text).toContain('Target content')
    } finally {
      await project.dispose()
    }
  })
})
