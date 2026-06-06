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

const nodeByTitle = (page: Page, title: string) =>
  page.locator(`g[role="button"][aria-label^="Task: ${title}, status:"]`)

/**
 * Discover a root task in each of the active + archive worksets, with a unique,
 * selector-safe title, so the test can assert node presence/absence by title.
 */
async function discoverWorksetRoots(page: Page, project: string) {
  return page.evaluate(async (name: string) => {
    const res = await fetch(`/api/tasks/${encodeURIComponent(name)}`)
    const { tasks } = await res.json() as {
      tasks: Record<string, { title: string; parent: string | null; workset?: string }>
    }
    const entries = Object.values(tasks)
    const titleCount = new Map<string, number>()
    for (const t of entries) titleCount.set(t.title, (titleCount.get(t.title) ?? 0) + 1)
    const safe = (t: { title: string }) => !/["\\]/.test(t.title) && titleCount.get(t.title) === 1
    const pick = (ws: string) => entries.find(t =>
      (t.workset ?? 'active') === ws && t.parent === null && safe(t))
    const archive = pick('archive')
    const active = pick('active')
    return { archiveTitle: archive?.title ?? null, activeTitle: active?.title ?? null }
  }, project)
}

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

  test('node click selects first, then toggles the detail panel for the selected task', async ({ page }) => {
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
    const panel = page.getByRole('complementary', { name: 'Task details' })
    const clickVisibleNodeEdge = () => node.click({ position: { x: 24, y: 18 } })

    await clickVisibleNodeEdge()
    await expect(node).toHaveAttribute('data-selected', 'true')
    await expect(panel).toHaveCount(0)

    await clickVisibleNodeEdge()
    await expect(panel).toBeVisible({ timeout: 3_000 })
    await expect(panel.getByText(longest, { exact: true }).first()).toBeVisible()

    await clickVisibleNodeEdge()
    await expect(panel).toHaveCount(0)
    await expect(node).toHaveAttribute('data-selected', 'true')

    await clickVisibleNodeEdge()
    await expect(panel).toBeVisible({ timeout: 3_000 })

    await panel.getByRole('button', { name: 'Close task details' }).click()
    await expect(panel).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(node).toHaveAttribute('data-selected', 'false')

    await node.dblclick({ position: { x: 24, y: 18 } })
    await expect(panel).toBeVisible({ timeout: 3_000 })
  })

  test('detail panel overlays the graph and resizes from its left border', async ({ page }) => {
    await openTaskGraph(page)

    const svg = page.locator('svg').first()
    const node = taskNodes(page).first()
    const beforeSvg = await svg.boundingBox()
    expect(beforeSvg).toBeTruthy()

    await node.dblclick()
    const panel = page.getByRole('complementary', { name: 'Task details' })
    await expect(panel).toBeVisible({ timeout: 3_000 })

    const openSvg = await svg.boundingBox()
    expect(openSvg).toBeTruthy()
    expect(Math.abs(openSvg!.width - beforeSvg!.width)).toBeLessThan(8)

    const beforePanel = await panel.boundingBox()
    const handle = page.getByRole('separator', { name: 'Resize task details' })
    const handleBox = await handle.boundingBox()
    expect(beforePanel).toBeTruthy()
    expect(handleBox).toBeTruthy()

    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox!.x - 120, handleBox!.y + handleBox!.height / 2, { steps: 6 })
    await page.mouse.up()

    const afterPanel = await panel.boundingBox()
    const resizedSvg = await svg.boundingBox()
    expect(afterPanel).toBeTruthy()
    expect(resizedSvg).toBeTruthy()
    expect(afterPanel!.width).toBeGreaterThan(beforePanel!.width + 80)
    expect(Math.abs(resizedSvg!.width - beforeSvg!.width)).toBeLessThan(8)
  })

  test('search highlights matches and Enter selects without opening the detail panel', async ({ page }) => {
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
    await expect(page.locator('[data-layer="nodes"] g[data-selected="true"]')).toHaveCount(1, { timeout: 3_000 })
    await expect(page.getByRole('complementary', { name: 'Task details' })).toHaveCount(0)
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

  test('archive workset: an archived task NODE is hidden by default and rendered when enabled', async ({ page }) => {
    const project = await openTaskGraph(page)
    const { archiveTitle, activeTitle } = await discoverWorksetRoots(page, project.name)
    // There ARE archived tasks in this repo's data; fail loudly (not silent skip) if not.
    expect(archiveTitle, 'an archived root task with a unique title').toBeTruthy()
    expect(activeTitle, 'an active root task with a unique title').toBeTruthy()

    const archiveNode = nodeByTitle(page, archiveTitle!)
    const activeNode = nodeByTitle(page, activeTitle!)

    // Default (active+backlog): the archived node is NOT rendered; the active one is.
    await expect(activeNode).toHaveCount(1)
    await expect(archiveNode).toHaveCount(0)
    const defaultCount = await taskNodes(page).count()

    // Enable the archive workset → the archived node renders; the active one stays.
    await page.locator('button[aria-label="Workset: archive"]').click()
    await expect(page.locator('button[aria-label="Workset: archive"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(archiveNode).toHaveCount(1)
    await expect(activeNode).toHaveCount(1)
    expect(await taskNodes(page).count()).toBeGreaterThan(defaultCount)

    // Disabling it again hides the archived node; the active one remains.
    await page.locator('button[aria-label="Workset: archive"]').click()
    await expect(archiveNode).toHaveCount(0)
    await expect(activeNode).toHaveCount(1)
  })
})
