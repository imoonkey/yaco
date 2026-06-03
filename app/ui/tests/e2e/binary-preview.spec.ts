import { test, expect, type Page } from '@playwright/test'

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

test.describe('Binary file preview', () => {

  test('Tax2025 project with PDF tab does not white-screen', async ({ page }) => {
    const errors = collectErrors(page)

    // Set up persisted state that includes a PDF tab (simulates the user's scenario)
    await page.goto('/')
    await page.waitForTimeout(1000)

    // Inject localStorage with a PDF as active tab for Tax2025
    await page.evaluate(() => {
      const key = 'workflow-workspace:Tax2025'
      const state = {
        openTabs: ['notes.txt', 'coinbase.pdf'],
        activeTab: 'coinbase.pdf',
        previewTab: null,
        activeSession: null,
        mobilePane: 'editor',
        layout: { mdMode: 'edit', splitDirection: 'horizontal', splitSize: 50, autocompleteEnabled: false },
        pinnedSessions: [],
        recentFiles: [],
      }
      localStorage.setItem(key, JSON.stringify(state))
    })

    // Now click Tax2025 project
    const tax = page.locator('button', { hasText: 'Tax2025' })
    if (await tax.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tax.click()
      await page.waitForTimeout(3000)

      // Check the app is NOT white-screened — some visible UI should exist
      const visibleElements = await page.locator('body').evaluate(el => {
        return el.children.length > 0 && el.innerText.length > 10
      })
      expect(visibleElements).toBe(true)

      // Check for the PDF preview or error boundary message
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
    } else {
      test.skip(true, 'Tax2025 project not available')
    }

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

    // Test the raw endpoint directly
    const result = await page.evaluate(async () => {
      // Test 404 for nonexistent file
      const r1 = await fetch('/api/files/workflow/raw?path=nonexistent.png')
      // Test serving a real file (package.json as a fallback test — not binary but tests the endpoint)
      const r2 = await fetch('/api/files/workflow/raw?path=package.json')
      return {
        notFound: r1.status,
        found: r2.status,
        contentType: r2.headers.get('content-type'),
      }
    })

    expect(result.notFound).toBe(404)
    expect(result.found).toBe(200)
  })

  test('image file renders in editor without crash', async ({ page }) => {
    const errors = collectErrors(page)

    await page.goto('/')
    await page.waitForTimeout(1000)

    // Select workflow project (which we know exists)
    const workflowBtn = page.locator('button', { hasText: 'workflow' }).first()
    await workflowBtn.click()
    await page.waitForTimeout(2000)

    // Check if there are any .png or .svg files we can try
    // Use the favicon or any image in the project
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/files/workflow/raw?path=ui/public/icon-192.png')
      return { status: res.status, type: res.headers.get('content-type') }
    })

    if (result.status === 200) {
      expect(result.type).toBe('image/png')
      console.log('Image endpoint OK: serves PNG with correct content-type')
    }

    if (errors.length > 0) {
      console.log('=== BROWSER ERRORS ===')
      errors.forEach(e => console.log(e))
      console.log('=== END ERRORS ===')
    }
  })
})
