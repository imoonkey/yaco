import { test, expect, type Page } from '@playwright/test'

// --- Helpers ---

/** Navigate to the Task Graph view for the first project */
async function openTaskGraph(page: Page) {
  await page.goto('/')
  await expect(page.locator('header')).toBeVisible({ timeout: 10_000 })

  // Get first project from API
  const projects = await page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<{ name: string; path: string }[]>
  })
  expect(projects.length).toBeGreaterThan(0)
  const project = projects[0]

  // Switch to Tasks view
  await page.locator('button', { hasText: 'Tasks' }).click()
  // Select the project tab
  await page.locator('button', { hasText: project.name }).click()

  // Wait for graph to render (SVG nodes layer visible)
  await expect(page.locator('[data-layer="nodes"]')).toBeVisible({ timeout: 15_000 })

  // Clear any persisted collapse state so tests start clean
  await page.evaluate((name: string) => {
    localStorage.removeItem(`workflow-taskgraph:${name}`)
  }, project.name)

  return project
}

/** Get the SVG transform string from the root <g> inside the canvas SVG */
async function getTransform(page: Page): Promise<string> {
  return page.locator('svg.absolute > g').first().getAttribute('transform') as Promise<string>
}

// --- Tests ---

test.describe('Task Graph', () => {
  test('renders with milestone columns and task nodes', async ({ page }) => {
    await openTaskGraph(page)

    // Milestones layer should contain milestone groups
    const milestones = page.locator('[data-layer="milestones"] g[role="button"][aria-label^="Milestone:"]')
    await expect(milestones.first()).toBeVisible({ timeout: 5_000 })
    expect(await milestones.count()).toBeGreaterThan(0)

    // Nodes layer should contain task nodes
    const taskNodes = page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"]')
    await expect(taskNodes.first()).toBeVisible()
    expect(await taskNodes.count()).toBeGreaterThan(0)
  })

  test('clicking a task node selects it and opens detail panel', async ({ page }) => {
    await openTaskGraph(page)

    // Ensure detail panel is NOT visible initially (close button title="Close")
    await expect(page.locator('button[title="Close"]')).not.toBeVisible()

    // Find and click the first task node
    const taskNode = page.locator('g[role="button"][aria-label^="Task:"]').first()
    await expect(taskNode).toBeVisible()
    const ariaLabel = await taskNode.getAttribute('aria-label')
    const taskTitle = ariaLabel!.match(/^Task: (.+), status:/)?.[1] ?? ''
    expect(taskTitle).toBeTruthy()

    await taskNode.click()

    // Detail panel should open — the task title should appear in the panel
    // The panel renders the title in a font-semibold span
    const detailPanel = page.locator('div.shrink-0.overflow-y-auto')
    await expect(detailPanel).toBeVisible({ timeout: 3_000 })
    await expect(detailPanel.locator('span.font-semibold')).toContainText(taskTitle)

    // Close button should be visible
    await expect(page.locator('button[title="Close"]')).toBeVisible()
  })

  test('clicking chevron collapses a milestone', async ({ page }) => {
    const project = await openTaskGraph(page)

    // Clear collapse state again after navigation
    await page.evaluate((name: string) => {
      localStorage.removeItem(`workflow-taskgraph:${name}`)
    }, project.name)
    // Reload to ensure clean state
    await page.reload()
    await expect(page.locator('[data-layer="nodes"]')).toBeVisible({ timeout: 15_000 })

    // Count task nodes before collapse
    const nodesBefore = await page.locator('g[role="button"][aria-label^="Task:"]').count()
    expect(nodesBefore).toBeGreaterThan(0)

    // Find a collapse chevron and click it
    const collapseChevron = page.locator('g[role="button"][aria-label="Collapse milestone"]').first()
    await expect(collapseChevron).toBeVisible()
    await collapseChevron.click()

    // After collapse: an "Expand milestone" chevron should appear
    await expect(page.locator('g[role="button"][aria-label="Expand milestone"]').first()).toBeVisible({ timeout: 3_000 })

    // Fewer task nodes should be visible (collapsed milestone hides its children)
    const nodesAfter = await page.locator('g[role="button"][aria-label^="Task:"]').count()
    expect(nodesAfter).toBeLessThan(nodesBefore)
  })

  test('hovering without clicking does NOT pan the graph', async ({ page }) => {
    await openTaskGraph(page)

    const initialTransform = await getTransform(page)

    // Get SVG bounding box
    const svg = page.locator('svg.absolute')
    const box = await svg.boundingBox()
    expect(box).toBeTruthy()

    // Hover across the canvas without pressing
    await page.mouse.move(box!.x + 50, box!.y + 50)
    await page.waitForTimeout(50)
    await page.mouse.move(box!.x + 200, box!.y + 150)
    await page.waitForTimeout(50)
    await page.mouse.move(box!.x + 350, box!.y + 250)
    await page.waitForTimeout(50)

    // Transform must NOT have changed
    const afterTransform = await getTransform(page)
    expect(afterTransform).toBe(initialTransform)
  })

  test('dragging pans the graph', async ({ page }) => {
    await openTaskGraph(page)

    const initialTransform = await getTransform(page)

    const svg = page.locator('svg.absolute')
    const box = await svg.boundingBox()
    expect(box).toBeTruthy()

    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2

    // Drag: press, move beyond threshold (>3px), release
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 80, cy + 60, { steps: 10 })
    await page.mouse.up()

    // Transform should have changed (panning happened)
    const afterTransform = await getTransform(page)
    expect(afterTransform).not.toBe(initialTransform)
  })

  test('search input matches and highlights tasks, Enter navigates', async ({ page }) => {
    await openTaskGraph(page)

    const searchInput = page.locator('input[placeholder="Search tasks..."]')
    await expect(searchInput).toBeVisible()

    // Get a known task title to search for — read from a visible node
    const firstNode = page.locator('g[role="button"][aria-label^="Task:"]').first()
    const ariaLabel = await firstNode.getAttribute('aria-label')
    const fullTitle = ariaLabel!.match(/^Task: (.+), status:/)?.[1] ?? ''
    // Use first word as search term (more likely to get matches)
    const searchTerm = fullTitle.split(' ')[0]
    expect(searchTerm.length).toBeGreaterThan(0)

    // Type into search
    await searchInput.fill(searchTerm)

    // Match count indicator should appear (e.g. "3 matches" or "1 match")
    const matchIndicator = page.locator('span', { hasText: /\d+ match/ })
    await expect(matchIndicator).toBeVisible({ timeout: 3_000 })

    // The count should be at least 1
    const text = await matchIndicator.textContent()
    const count = parseInt(text!.match(/(\d+)/)?.[1] ?? '0', 10)
    expect(count).toBeGreaterThanOrEqual(1)

    // Press Enter to navigate to first match — detail panel should open
    await searchInput.press('Enter')
    const detailPanel = page.locator('div.shrink-0.overflow-y-auto')
    await expect(detailPanel).toBeVisible({ timeout: 3_000 })
  })
})
