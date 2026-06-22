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

  test('a >1 MB HTML file shows the too-large notice in the editor but still previews via /raw', async ({ page, request }) => {
    // Over the 1 MB content cap: /content returns 413, so the editor can't load it.
    // Padded past the limit with a comment; the <h1> marker proves the raw bytes rendered.
    const fileName = uniqueFileName('html_preview_big.html')
    const bigHtml = `<!doctype html><html><head><title>Big</title></head><body>`
      + `<h1>OVERSIZE PREVIEW OK</h1><!--${'x'.repeat(1_100_000)}--></body></html>`
    const project = await provisionWorkspace(page, request, { files: { [fileName]: bigHtml } })

    try {
      await openFileViaSearch(page, fileName)

      // Edit mode (default): the editor pane shows the too-large notice, not a spinner.
      await expect(page.getByText(/too large to open in the editor/i)).toBeVisible({ timeout: 10_000 })

      // Preview mode: the page renders from the higher-limit /raw endpoint.
      const [rawResponse] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/raw?path=') && r.url().includes('html_preview_big') && r.status() === 200),
        page.getByRole('button', { name: 'Preview', exact: true }).click(),
      ])
      expect(rawResponse.ok()).toBe(true)

      await page.waitForSelector('iframe[title="HTML preview"]', { timeout: 10_000 })
      const frame = await (await page.locator('iframe[title="HTML preview"]').elementHandle())?.contentFrame()
      expect(frame).not.toBeNull()
      if (!frame) return

      await expect
        .poll(() => frame.evaluate(() => document.body.innerText), { timeout: 10_000 })
        .toContain('OVERSIZE PREVIEW OK')
    } finally {
      await project.dispose()
    }
  })
})
