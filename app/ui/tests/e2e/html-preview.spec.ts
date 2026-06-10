import { test, expect, type Page } from '@playwright/test'
import { waitForAppReady } from './helpers/workspace'

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

async function openFileViaSearch(page: Page, fileName: string) {
  await page.keyboard.press('Meta+p')
  await expect(page.locator('input[placeholder="Search files..."]')).toBeVisible({ timeout: 10_000 })
  await page.locator('input[placeholder="Search files..."]').fill(fileName)
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1000)
}

test.describe('HTML preview', () => {
  test('fragment links scroll inside srcdoc instead of loading the app shell', async ({ page }) => {
    const project = await openWorkspace(page)
    const fileName = '__e2e_html_preview_anchor.html'
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

    await createTestFile(page, project.name, fileName, content)
    await page.waitForTimeout(3000)

    try {
      await openFileViaSearch(page, fileName)
      await page.getByRole('button', { name: 'Preview', exact: true }).click()
      await page.waitForSelector('iframe[title="HTML preview"]', { timeout: 10_000 })

      const frame = await (await page.locator('iframe[title="HTML preview"]').elementHandle())?.contentFrame()
      expect(frame).not.toBeNull()
      if (!frame) return

      await frame.waitForSelector('a[href="#target"]', { timeout: 10_000 })
      await frame.click('a[href="#target"]')
      await page.waitForTimeout(500)

      const state = await frame.evaluate(() => ({
        href: location.href,
        title: document.title,
        text: document.body.innerText,
        scrollY,
      }))

      expect(state.href).toBe('about:srcdoc#target')
      expect(state.title).toBe('Anchor Preview Test')
      expect(state.text).toContain('Target content')
      expect(state.scrollY).toBeGreaterThan(0)
    } finally {
      await deleteTestFile(page, project.name, fileName)
    }
  })
})
