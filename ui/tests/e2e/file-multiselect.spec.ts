import { test, expect, type Page } from '@playwright/test'

async function openWorkspace(page: Page) {
  await page.goto('/')
  await expect(page.locator('main')).toBeVisible({ timeout: 10_000 })
  const projects = await page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<{ name: string; path: string }[]>
  })
  expect(projects.length).toBeGreaterThan(0)
  const project = projects[0]
  await page.locator('button', { hasText: project.name }).click()
  return project
}

async function createFile(page: Page, projectName: string, path: string) {
  await page.evaluate(async ({ projectName, path }) => {
    await fetch(`/api/files/${encodeURIComponent(projectName)}/create-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  }, { projectName, path })
}

async function deleteFileIfExists(page: Page, projectName: string, path: string) {
  await page.evaluate(async ({ projectName, path }) => {
    await fetch(`/api/files/${encodeURIComponent(projectName)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
  }, { projectName, path })
}

async function fileExistsOnServer(page: Page, projectName: string, path: string): Promise<boolean> {
  return page.evaluate(async ({ projectName, path }) => {
    const res = await fetch(`/api/files/${encodeURIComponent(projectName)}/content?path=${encodeURIComponent(path)}`)
    return res.ok
  }, { projectName, path })
}

test.describe('File Explorer: multi-select', () => {
  let projectName: string
  const PATHS = ['__e2e_multi_a.txt', '__e2e_multi_b.txt', '__e2e_multi_c.txt']

  test.afterEach(async ({ page }) => {
    if (!projectName) return
    for (const p of PATHS) await deleteFileIfExists(page, projectName, p)
  })

  test('Ctrl+Click selects multiple files and right-click Delete batch-removes them', async ({ page }) => {
    const project = await openWorkspace(page)
    projectName = project.name

    for (const p of PATHS) await createFile(page, projectName, p)
    await page.waitForTimeout(2500) // SSE refresh

    const items = PATHS.map(p => p.replace(/\.txt$/, ''))
    for (const stem of items) {
      await expect(page.locator('[role="treeitem"]', { hasText: stem }).first()).toBeVisible({ timeout: 5000 })
    }

    // Single-click first, Ctrl+Click the others
    await page.locator('[role="treeitem"]', { hasText: items[0] }).first().click()
    await page.locator('[role="treeitem"]', { hasText: items[1] }).first().click({ modifiers: ['ControlOrMeta'] })
    await page.locator('[role="treeitem"]', { hasText: items[2] }).first().click({ modifiers: ['ControlOrMeta'] })

    // Right-click on one of the selected nodes → context menu → Delete
    await page.locator('[role="treeitem"]', { hasText: items[1] }).first().click({ button: 'right' })
    await page.getByText('Delete', { exact: true }).first().click()

    // Confirm dialog shows batch title
    await expect(page.getByText(/Delete 3 items\?/)).toBeVisible({ timeout: 3000 })
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await page.waitForTimeout(2500)
    for (const p of PATHS) {
      expect(await fileExistsOnServer(page, projectName, p)).toBe(false)
    }
  })

  test('right-click Delete on a non-selected node deletes only that node (regression)', async ({ page }) => {
    const project = await openWorkspace(page)
    projectName = project.name

    for (const p of PATHS) await createFile(page, projectName, p)
    await page.waitForTimeout(2500)

    const items = PATHS.map(p => p.replace(/\.txt$/, ''))
    for (const stem of items) {
      await expect(page.locator('[role="treeitem"]', { hasText: stem }).first()).toBeVisible({ timeout: 5000 })
    }

    // Multi-select a and b, but right-click on c (not in selection)
    await page.locator('[role="treeitem"]', { hasText: items[0] }).first().click()
    await page.locator('[role="treeitem"]', { hasText: items[1] }).first().click({ modifiers: ['ControlOrMeta'] })

    await page.locator('[role="treeitem"]', { hasText: items[2] }).first().click({ button: 'right' })
    await page.getByText('Delete', { exact: true }).first().click()

    // Single-item dialog title (uses original filename in quotes)
    await expect(page.getByText(/Delete "__e2e_multi_c\.txt"\?/)).toBeVisible({ timeout: 3000 })
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await page.waitForTimeout(2500)
    expect(await fileExistsOnServer(page, projectName, PATHS[2])).toBe(false)
    expect(await fileExistsOnServer(page, projectName, PATHS[0])).toBe(true)
    expect(await fileExistsOnServer(page, projectName, PATHS[1])).toBe(true)
  })
})
