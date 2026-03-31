import { test, expect, type Page } from '@playwright/test'

async function loadProjects(page: Page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<{ name: string; path: string }[]>
  })
}

async function openWorkspace(page: Page) {
  await page.goto('/')
  await expect(page.locator('header')).toBeVisible({ timeout: 10_000 })
  const projects = await loadProjects(page)
  expect(projects.length).toBeGreaterThan(0)
  await page.locator('button', { hasText: 'Workspace' }).click()
  await page.locator('button', { hasText: projects[0].name }).click()
  return projects
}

async function createTestFile(page: Page, projectName: string, path: string, content: string) {
  await page.evaluate(async ({ projectName, path, content }) => {
    await fetch(`/api/files/${encodeURIComponent(projectName)}/create-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })

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

test.describe('Workspace Tasks tab', () => {
  test('Tasks doorway opens the task graph in the editor area', async ({ page }) => {
    await openWorkspace(page)

    await page.getByRole('button', { name: 'Open task graph', exact: true }).click()

    await expect(page.locator('[data-testid="tab"][title="Tasks"]')).toBeVisible()
    await expect(page.locator('input[placeholder="Search tasks..."]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=Unable to load file')).not.toBeVisible()
  })

  test('Cmd+Shift+T opens, focuses, and closes a single Tasks tab', async ({ page }) => {
    const projects = await openWorkspace(page)
    const project = projects[0]
    const fileName = '__e2e_tasks_toggle.txt'

    await createTestFile(page, project.name, fileName, 'tasks toggle test\n')
    await page.waitForTimeout(3000)

    await page.keyboard.press('Meta+Shift+t')
    await expect(page.locator('[data-testid="tab"][title="Tasks"]')).toHaveCount(1)
    await expect(page.locator('input[placeholder="Search tasks..."]')).toBeVisible({ timeout: 10_000 })

    await openFileViaSearch(page, fileName)
    await expect(page.locator(`[data-testid="tab"][title="${fileName}"]`)).toBeVisible()

    await page.keyboard.press('Meta+Shift+t')
    await expect(page.locator('[data-testid="tab"][title="Tasks"]')).toHaveCount(1)
    await expect(page.locator('input[placeholder="Search tasks..."]')).toBeVisible({ timeout: 10_000 })

    await page.keyboard.press('Meta+Shift+t')
    await expect(page.locator('[data-testid="tab"][title="Tasks"]')).toHaveCount(0)
    await expect(page.locator(`[data-testid="tab"][title="${fileName}"]`)).toBeVisible()

    await deleteTestFile(page, project.name, fileName)
  })

  test('switching projects preserves whether the Tasks tab was open', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('header')).toBeVisible({ timeout: 10_000 })

    const projects = await loadProjects(page)
    if (projects.length < 2) {
      test.skip()
      return
    }

    const [projectA, projectB] = projects

    await page.evaluate((names: string[]) => {
      for (const name of names) {
        localStorage.removeItem(`workflow-workspace:${name}`)
      }
    }, [projectA.name, projectB.name])

    await page.reload()
    await expect(page.locator('header')).toBeVisible({ timeout: 10_000 })
    await page.locator('button', { hasText: 'Workspace' }).click()

    await page.locator('button', { hasText: projectA.name }).click()
    await page.keyboard.press('Meta+Shift+t')
    await expect(page.locator('[data-testid="tab"][title="Tasks"]')).toBeVisible()

    await page.locator('button', { hasText: projectB.name }).click()
    await expect(page.locator('[data-testid="tab"][title="Tasks"]')).toHaveCount(0)

    await page.locator('button', { hasText: projectA.name }).click()
    await expect(page.locator('[data-testid="tab"][title="Tasks"]')).toBeVisible()
  })
})
