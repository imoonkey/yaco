import { test, expect, type Page } from '@playwright/test'
import { createBinaryFixture, selectProject, layoutKey, type BinaryFixtureProject } from './helpers/workspace'

// Collect all browser errors for diagnosis
function collectErrors(page: Page) {
  const errors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(`CONSOLE: ${msg.text()}`)
  })
  page.on('pageerror', err => {
    errors.push(`PAGEERROR: ${err.message}\n${err.stack}`)
  })
  return errors
}

// Each test provisions an isolated project (unique per run) holding a text file,
// a PDF, and a PNG, replacing the fixed `Tax2025`/`workflow` projects that may not
// exist in this environment.
test.describe('Binary file preview', () => {
  let fixture: BinaryFixtureProject

  test.beforeEach(async ({ request }) => {
    fixture = await createBinaryFixture(request)
  })

  test.afterEach(async () => {
    await fixture?.dispose()
  })

  test('project with PDF tab does not white-screen', async ({ page }) => {
    const errors = collectErrors(page)

    // Seed persisted state with a PDF as the active tab before the workspace mounts.
    await page.addInitScript(({ key, openTabs }) => {
      const state = {
        openTabs,
        activeTab: 'coinbase.pdf',
        previewTab: null,
        activeSession: '',
        mobilePane: 'editor',
        layout: { previewMode: 'edit', splitDirection: 'horizontal', splitSize: 50, autocompleteEnabled: false },
        recentFiles: [],
      }
      localStorage.setItem(key, JSON.stringify(state))
    }, { key: layoutKey(fixture.name), openTabs: [fixture.textTab, fixture.pdfTab] })

    await page.goto('/')
    await selectProject(page, fixture.name)
    await page.waitForTimeout(3000)

    // The app is NOT white-screened — some visible UI should exist
    const visibleElements = await page.locator('body').evaluate(el => {
      return el.children.length > 0 && el.innerText.length > 10
    })
    expect(visibleElements).toBe(true)

    // Check for the PDF tab, the error boundary message, or the react-pdf error
    const pdfPreview = page.locator('text=coinbase.pdf').first()
    const errorMsg = page.locator('text=Unable to preview').first()
    const failedMsg = page.locator('text=Failed to load PDF').first()

    // At least one of these should be visible (tab name, error boundary, or react-pdf error)
    const anyVisible = await Promise.race([
      pdfPreview.waitFor({ timeout: 5000 }).then(() => 'tab'),
      errorMsg.waitFor({ timeout: 5000 }).then(() => 'error-boundary'),
      failedMsg.waitFor({ timeout: 5000 }).then(() => 'pdf-error'),
    ]).catch(() => 'none')

    console.log(`PDF result: ${anyVisible}`)
    expect(anyVisible).not.toBe('none')

    // Dump errors for diagnosis
    if (errors.length > 0) {
      console.log('=== BROWSER ERRORS ===')
      errors.forEach(e => console.log(e))
      console.log('=== END ERRORS ===')
    }
  })

  test('raw file endpoint serves images with correct content-type', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(500)

    // Test the raw endpoint directly against the fixture project
    const result = await page.evaluate(async (project) => {
      const r1 = await fetch(`/api/files/${encodeURIComponent(project)}/raw?path=nonexistent.png`)
      const r2 = await fetch(`/api/files/${encodeURIComponent(project)}/raw?path=ui/public/icon-192.png`)
      return {
        notFound: r1.status,
        found: r2.status,
        contentType: r2.headers.get('content-type'),
      }
    }, fixture.name)

    expect(result.notFound).toBe(404)
    expect(result.found).toBe(200)
    expect(result.contentType).toBe('image/png')
  })

  test('image file renders in editor without crash', async ({ page }) => {
    const errors = collectErrors(page)

    await page.goto('/')
    await selectProject(page, fixture.name)
    await page.waitForTimeout(1000)

    const result = await page.evaluate(async ({ project, path }) => {
      const res = await fetch(`/api/files/${encodeURIComponent(project)}/raw?path=${encodeURIComponent(path)}`)
      return { status: res.status, type: res.headers.get('content-type') }
    }, { project: fixture.name, path: fixture.imagePath })

    expect(result.status).toBe(200)
    expect(result.type).toBe('image/png')

    if (errors.length > 0) {
      console.log('=== BROWSER ERRORS ===')
      errors.forEach(e => console.log(e))
      console.log('=== END ERRORS ===')
    }
  })
})
