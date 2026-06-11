import { test, expect, type Page } from '@playwright/test'
import { provisionWorkspace, createTestFile, openFileViaSearch, uniqueFileName, type FixtureProject } from './helpers/workspace'

const LONG_CODE_LINE = 'const veryLongVariableName = "' + 'abcdefghij'.repeat(30) + '";'
const MD_CONTENT = `# Test

Some text.

\`\`\`ts
${LONG_CODE_LINE}
const short = 1;
\`\`\`

More text after.
`

async function openMarkdownPreview(page: Page, fileName: string) {
  await openFileViaSearch(page, fileName)
  await page.keyboard.press('Meta+Shift+v')
  await expect(page.locator('.markdown-preview')).toBeVisible({ timeout: 5000 })
}

test.describe('Code block horizontal scroll in markdown preview', () => {
  let fixture: FixtureProject
  let testFile = ''

  test.beforeEach(async ({ page, request }) => {
    fixture = await provisionWorkspace(page, request)
    testFile = uniqueFileName('codeblock_scroll.md')
    await createTestFile(page, fixture.name, testFile, MD_CONTENT)
  })

  test.afterEach(async () => {
    await fixture.dispose()
  })

  test('scrollLeft persists after set', async ({ page }) => {
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
    }, { projectName: fixture.name, filePath: testFile })
    const modifiedContent = MD_CONTENT.replace('Some text.', 'Some modified text.')
    await page.evaluate(async ({ projectName, filePath, content, revision }) => {
      await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(filePath)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, baseRevision: revision }),
      })
    }, { projectName: fixture.name, filePath: testFile, content: modifiedContent, revision: getRes.revision })

    // Wait for SSE to propagate and re-render — verify modified text appears
    await expect(page.locator('.markdown-preview')).toContainText('Some modified text', { timeout: 10_000 })

    // After content change, scrollLeft should be restored
    const preAfter = page.locator('.markdown-preview pre').first()
    await expect(preAfter).toBeVisible({ timeout: 5000 })
    const scrollLeft = await preAfter.evaluate(el => el.scrollLeft)
    expect(scrollLeft).toBeGreaterThanOrEqual(150)
  })

  test('no DOM churn: innerHTML only set when html changes', async ({ page }) => {
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
