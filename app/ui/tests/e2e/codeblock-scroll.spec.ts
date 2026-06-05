import { test, expect, type Page } from '@playwright/test'

const LONG_CODE_LINE = 'const veryLongVariableName = "' + 'abcdefghij'.repeat(30) + '";'
const MD_CONTENT = `# Test

Some text.

\`\`\`ts
${LONG_CODE_LINE}
const short = 1;
\`\`\`

More text after.
`

async function openWorkspace(page: Page) {
  await page.goto('/')
  await expect(page.locator('header')).toBeVisible({ timeout: 10_000 })
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
  const getRes = await page.evaluate(async ({ projectName, filePath }) => {
    const res = await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`)
    return res.json() as Promise<{ content: string; revision: number }>
  }, { projectName, filePath })
  await page.evaluate(async ({ projectName, filePath, content, revision }) => {
    await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseRevision: revision }),
    })
  }, { projectName, filePath, content, revision: getRes.revision })
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

async function openMarkdownPreview(page: Page, testFile: string) {
  await page.keyboard.press('Meta+p')
  await page.locator('input[placeholder="Search files..."]').fill(testFile.replace(/^__e2e_/, ''))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1000)
  await page.keyboard.press('Meta+Shift+v')
  await expect(page.locator('.markdown-preview')).toBeVisible({ timeout: 5000 })
}

test.describe('Code block horizontal scroll in markdown preview', () => {
  const testFile = '__e2e_codeblock_scroll.md'
  let projectName = ''

  test.afterEach(async ({ page }) => {
    if (projectName) await deleteTestFile(page, projectName, testFile).catch(() => {})
  })

  test('scrollLeft persists after set', async ({ page }) => {
    const project = await openWorkspace(page)
    projectName = project.name
    await createTestFile(page, project.name, testFile, MD_CONTENT)
    await page.waitForTimeout(3000)
    await openMarkdownPreview(page, testFile)

    const pre = page.locator('.markdown-preview pre').first()
    await expect(pre).toBeVisible({ timeout: 5000 })

    // Verify overflow exists
    const hasOverflow = await pre.evaluate(el => el.scrollWidth > el.clientWidth)
    expect(hasOverflow).toBe(true)

    // Set scrollLeft and verify it sticks
    await pre.evaluate(el => { el.scrollLeft = 200 })
    await page.waitForTimeout(100)
    expect(await pre.evaluate(el => el.scrollLeft)).toBeGreaterThanOrEqual(150)

    // Wait for potential re-renders to settle
    await page.waitForTimeout(1000)
    expect(await pre.evaluate(el => el.scrollLeft)).toBeGreaterThanOrEqual(150)

    // Verify DOM is NOT being replaced (node identity check)
    await pre.evaluate(el => { (el as Element & { __testTag?: string }).__testTag = 'original' })
    await page.waitForTimeout(500)
    const tagAfter = await pre.evaluate(el => (el as Element & { __testTag?: string }).__testTag)
    expect(tagAfter).toBe('original')
  })

  test('scrollLeft survives content re-render', async ({ page }) => {
    const project = await openWorkspace(page)
    projectName = project.name
    await createTestFile(page, project.name, testFile, MD_CONTENT)
    await page.waitForTimeout(3000)
    await openMarkdownPreview(page, testFile)

    const pre = page.locator('.markdown-preview pre').first()
    await expect(pre).toBeVisible({ timeout: 5000 })

    // Set scrollLeft
    await pre.evaluate(el => { el.scrollLeft = 200 })
    await page.waitForTimeout(200)
    expect(await pre.evaluate(el => el.scrollLeft)).toBeGreaterThanOrEqual(150)

    // Trigger a content change by editing the file externally
    const getRes = await page.evaluate(async ({ projectName, filePath }) => {
      const res = await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`)
      return res.json() as Promise<{ content: string; revision: number }>
    }, { projectName: project.name, filePath: testFile })
    const modifiedContent = MD_CONTENT.replace('Some text.', 'Some modified text.')
    await page.evaluate(async ({ projectName, filePath, content, revision }) => {
      await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, baseRevision: revision }),
      })
    }, { projectName: project.name, filePath: testFile, content: modifiedContent, revision: getRes.revision })

    // Wait for SSE to propagate and re-render — verify modified text appears
    await expect(page.locator('.markdown-preview')).toContainText('Some modified text', { timeout: 10_000 })

    // After content change, scrollLeft should be restored
    const preAfter = page.locator('.markdown-preview pre').first()
    await expect(preAfter).toBeVisible({ timeout: 5000 })
    const scrollLeft = await preAfter.evaluate(el => el.scrollLeft)
    expect(scrollLeft).toBeGreaterThanOrEqual(150)
  })

  test('no DOM churn: innerHTML only set when html changes', async ({ page }) => {
    const project = await openWorkspace(page)
    projectName = project.name
    await createTestFile(page, project.name, testFile, MD_CONTENT)
    await page.waitForTimeout(3000)
    await openMarkdownPreview(page, testFile)

    const pre = page.locator('.markdown-preview pre').first()
    await expect(pre).toBeVisible({ timeout: 5000 })

    // Count innerHTML sets over 2 seconds
    const setCount = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const container = document.querySelector('.markdown-preview') as HTMLElement
        if (!container) { resolve(-1); return }
        let count = 0
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!
        Object.defineProperty(container, 'innerHTML', {
          set(value: string) { count++; desc.set!.call(this, value) },
          get() { return desc.get!.call(this) },
          configurable: true,
        })
        setTimeout(() => {
          Object.defineProperty(container, 'innerHTML', desc)
          resolve(count)
        }, 2000)
      })
    })

    // Should be 0 or at most 1 (no churn)
    expect(setCount).toBeLessThanOrEqual(1)
  })
})
