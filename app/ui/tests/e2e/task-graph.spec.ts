import { test, expect, type Page } from '@playwright/test'

// V1 task workspace: a single stacked graph workspace. No Board/List/Archive
// panels, no milestone columns, no horizontal pan/zoom canvas — roots stack
// vertically, workset is a filter, and only real `depends` edges render.

type Project = { name: string; path: string }

/** Open the single Tasks workspace (overlay) for the first project. */
async function openTaskGraph(page: Page): Promise<Project> {
  await page.goto('/')
  const projects = await page.evaluate(async () => {
    const res = await fetch('/api/projects')
    return res.json() as Promise<Project[]>
  })
  expect(projects.length).toBeGreaterThan(0)
  const project = projects[0]

  await page.locator('button', { hasText: project.name }).first().click()
  // Start from default workspace state (active+backlog, nothing collapsed).
  await page.evaluate((name: string) => localStorage.removeItem(`yaco-task-workspace:${name}`), project.name)

  await page.keyboard.press('Meta+Shift+t')
  await expect(page.locator('[data-layer="nodes"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"]').first()).toBeVisible({ timeout: 15_000 })
  return project
}

const taskNodes = (page: Page) => page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"]')

/** Background-rect geometry for every visible task node. */
async function nodeRects(page: Page) {
  return page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"] > rect:nth-of-type(1)')
    .evaluateAll(els => els.map(el => ({
      x: parseFloat(el.getAttribute('x') || '0'),
      y: parseFloat(el.getAttribute('y') || '0'),
      width: parseFloat(el.getAttribute('width') || '0'),
    })))
}

test.describe('Task workspace (V1 stacked graph)', () => {
  test('renders task nodes — no milestone columns, no Board/List/Archive surfaces', async ({ page }) => {
    await openTaskGraph(page)

    // Task nodes render.
    expect(await taskNodes(page).count()).toBeGreaterThan(0)

    // The retired milestone-column layer is gone.
    expect(await page.locator('[data-layer="milestones"]').count()).toBe(0)

    // No Board/List/Archive surface switchers anywhere in the workspace.
    for (const surface of ['Board', 'List', 'Archive']) {
      expect(await page.getByRole('button', { name: surface, exact: true }).count()).toBe(0)
      expect(await page.getByRole('tab', { name: surface, exact: true }).count()).toBe(0)
    }

    // Layout is Stacked (selected) with DAG present-but-disabled (phase 2).
    const layout = page.locator('[role="group"][aria-label="Layout mode"]')
    await expect(layout.getByRole('button', { name: 'Stacked' })).toHaveAttribute('aria-pressed', 'true')
    await expect(layout.getByRole('button', { name: 'DAG' })).toBeDisabled()
  })

  test('root sections stack vertically and share one left edge (full-width rows)', async ({ page }) => {
    await openTaskGraph(page)
    const rects = await nodeRects(page)
    expect(rects.length).toBeGreaterThan(1)

    const xs = rects.map(r => r.x)
    const ys = rects.map(r => r.y)
    const minX = Math.min(...xs)

    // Multiple top-level rows share the leftmost edge (a vertical stack, not a
    // side-by-side root lane layout).
    const atLeftEdge = rects.filter(r => Math.abs(r.x - minX) < 0.5)
    expect(atLeftEdge.length).toBeGreaterThan(1)
    // Those left-edge rows sit at distinct, increasing y values.
    const leftYs = [...new Set(atLeftEdge.map(r => r.y))].sort((a, b) => a - b)
    expect(leftYs.length).toBe(atLeftEdge.length)

    // The layout is far taller than it is wide (vertical scroll, not horizontal).
    const ySpan = Math.max(...ys) - Math.min(...ys)
    const xSpan = Math.max(...xs) - minX
    expect(ySpan).toBeGreaterThan(xSpan)

    // Rows share a right edge, so every left-edge (root) row has the same width,
    // at least the minimum card-width floor (280). Exact width-fill is proven
    // precisely in the taskGraphModel unit test.
    const leftWidths = new Set(atLeftEdge.map(r => Math.round(r.width)))
    expect(leftWidths.size).toBe(1)
    expect(atLeftEdge[0].width).toBeGreaterThanOrEqual(280)
  })

  test('only real dependency edges render (count matches the depends graph)', async ({ page }) => {
    const project = await openTaskGraph(page)

    // Expected: distinct dependency anchor-pairs among the visible (default
    // active+backlog, all expanded) tasks — nothing structural.
    const expectedEdgePairs = await page.evaluate(async (name: string) => {
      const res = await fetch(`/api/tasks/${encodeURIComponent(name)}`)
      const { tasks } = await res.json() as { tasks: Record<string, { depends?: string[]; workset?: string }> }
      const visible = new Set(Object.entries(tasks)
        .filter(([, t]) => (t.workset ?? 'active') !== 'archive')
        .map(([id]) => id))
      const pairs = new Set<string>()
      for (const id of visible) {
        for (const dep of tasks[id].depends ?? []) {
          if (visible.has(dep) && dep !== id) pairs.add(`${dep}->${id}`)
        }
      }
      return pairs.size
    }, project.name)

    const edgePaths = page.locator('[data-layer="edges"] > g > path')
    expect(expectedEdgePairs).toBeGreaterThan(0)
    expect(await edgePaths.count()).toBe(expectedEdgePairs)
  })

  test('clicking a node opens the detail panel and shows the full title', async ({ page }) => {
    await openTaskGraph(page)

    // Pick the node with the longest title to exercise full-title access.
    const labels = await taskNodes(page).evaluateAll(els =>
      els.map(el => el.getAttribute('aria-label') || ''))
    const longest = labels
      .map(l => l.match(/^Task: (.+), status:/)?.[1] ?? '')
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0]
    expect(longest.length).toBeGreaterThan(0)

    // The node carries the full, untruncated title in its accessible name.
    const node = page.locator(`g[role="button"][aria-label^="Task: ${longest}, status:"]`).first()
    await node.click()

    const panel = page.getByRole('complementary', { name: 'Task details' })
    await expect(panel).toBeVisible({ timeout: 3_000 })
    await expect(panel.getByText(longest, { exact: true }).first()).toBeVisible()
  })

  test('search highlights matches and Enter navigates to the detail panel', async ({ page }) => {
    const project = await openTaskGraph(page)

    const search = page.locator('input[placeholder="Search tasks..."]')
    await expect(search).toBeVisible()

    // Derive a term guaranteed to match: the leading segment of a real task id
    // (searchTasks matches substrings of title or id).
    const term = await page.evaluate(async (name: string) => {
      const res = await fetch(`/api/tasks/${encodeURIComponent(name)}`)
      const { tasks } = await res.json() as { tasks: Record<string, unknown> }
      const id = Object.keys(tasks)[0] ?? ''
      return id.split('-')[0] || id
    }, project.name)
    expect(term.length).toBeGreaterThan(0)

    await search.fill(term)
    const matches = page.locator('span', { hasText: /[1-9]\d* match/ })
    await expect(matches).toBeVisible({ timeout: 3_000 })

    await search.press('Enter')
    await expect(page.getByRole('complementary', { name: 'Task details' })).toBeVisible({ timeout: 3_000 })
  })

  test('workset filter: defaults to active+backlog with archive off, and filters the graph', async ({ page }) => {
    await openTaskGraph(page)

    const worksetGroup = page.locator('[role="group"][aria-label="Workset filter"]')
    await expect(worksetGroup).toBeVisible()

    // Default workset state: active + backlog enabled, archive hidden.
    await expect(page.locator('button[aria-label="Workset: active"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('button[aria-label="Workset: backlog"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('button[aria-label="Workset: archive"]')).toHaveAttribute('aria-pressed', 'false')

    // Workset is a real filter: disabling the active workset drops active nodes.
    const before = await taskNodes(page).count()
    expect(before).toBeGreaterThan(0)
    await page.locator('button[aria-label="Workset: active"]').click()
    await expect(page.locator('button[aria-label="Workset: active"]')).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => taskNodes(page).count()).toBeLessThan(before)

    // Re-enabling restores them.
    await page.locator('button[aria-label="Workset: active"]').click()
    await expect.poll(() => taskNodes(page).count()).toBe(before)
  })
})
