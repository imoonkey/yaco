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

// --- Pseudo-Gantt helpers ----------------------------------------------------

const layoutModeGroup = (page: Page) => page.locator('[role="group"][aria-label="Layout mode"]')
const ganttBars = (page: Page) => page.locator('[data-layer="bars"] g[data-task-id]')
// The single scroll container owned by TaskGraphScreen (vertical scroll + the
// Gantt's one approved horizontal carve-out).
const ganttScroll = (page: Page) => page.locator('.overflow-y-scroll.overflow-x-auto').first()

/** Switch the workspace into Pseudo-Gantt mode and wait for bars to render. */
async function switchToGantt(page: Page) {
  await layoutModeGroup(page).getByRole('button', { name: 'Gantt' }).click()
  await expect(page.locator('[data-layer="bars"]')).toBeVisible({ timeout: 10_000 })
  await expect(ganttBars(page).first()).toBeVisible({ timeout: 10_000 })
}

/** Re-open the task workspace for `project` after a fresh navigation WITHOUT
 *  clearing persisted workspace state, so layout/workset/collapse restore. The
 *  tasks view normally auto-restores from the persisted layout; only toggle it
 *  open if it did not come back on its own. */
async function reopenWorkspace(page: Page, project: Project) {
  await page.goto('/')
  await page.locator('button', { hasText: project.name }).first().click()
  const nodes = page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"]').first()
  const restored = await nodes.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true).catch(() => false)
  if (!restored) await page.keyboard.press('Meta+Shift+t')
  await expect(nodes).toBeVisible({ timeout: 15_000 })
}

/** Zoom in `n` steps (+0.25 each) via the toolbar to force scroll overflow. */
async function zoomInSteps(page: Page, n: number) {
  const btn = page.locator('button[title="Zoom in"]')
  for (let i = 0; i < n; i++) await btn.click()
}

test.describe('Task workspace (Pseudo-Gantt mode)', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('layout switch toggles Stacked↔Gantt, persists across reload, and a stale layout falls back to Stacked', async ({ page }) => {
    const project = await openTaskGraph(page)
    const group = layoutModeGroup(page)

    // Default: Stacked selected, no Gantt bars in the DOM.
    await expect(group.getByRole('button', { name: 'Stacked' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-layer="bars"]')).toHaveCount(0)

    // Switch to Gantt → bars render and Gantt is pressed.
    await switchToGantt(page)
    await expect(group.getByRole('button', { name: 'Gantt' })).toHaveAttribute('aria-pressed', 'true')
    expect(await ganttBars(page).count()).toBeGreaterThan(0)

    // Switch back to Stacked → bars gone, stacked rows present.
    await group.getByRole('button', { name: 'Stacked' }).click()
    await expect(page.locator('[data-layer="bars"]')).toHaveCount(0)
    await expect(taskNodes(page).first()).toBeVisible()

    // Persistence: re-enter Gantt, re-open the workspace from a fresh load → still Gantt.
    await switchToGantt(page)
    await reopenWorkspace(page, project)
    await expect(layoutModeGroup(page).getByRole('button', { name: 'Gantt' })).toHaveAttribute('aria-pressed', 'true')
    await expect(ganttBars(page).first()).toBeVisible({ timeout: 10_000 })

    // A stale/unknown persisted layout value resolves back to Stacked.
    await page.evaluate((name: string) => {
      const key = `yaco-task-workspace:${name}`
      const cur = JSON.parse(localStorage.getItem(key) || '{}')
      localStorage.setItem(key, JSON.stringify({ ...cur, layout: 'timeline-x9' }))
    }, project.name)
    await reopenWorkspace(page, project)
    await expect(layoutModeGroup(page).getByRole('button', { name: 'Stacked' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-layer="bars"]')).toHaveCount(0)
  })

  test('the frozen left task column does not move during horizontal scroll', async ({ page }) => {
    await openTaskGraph(page)
    await switchToGantt(page)
    await zoomInSteps(page, 4) // 2.0x — guarantees the time pane overflows horizontally

    const scroller = ganttScroll(page)
    const overflow = await scroller.evaluate(el => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeGreaterThan(0)

    const node = taskNodes(page).first()
    const bar = ganttBars(page).first()
    const nodeBefore = await node.boundingBox()
    const barBefore = await bar.boundingBox()
    expect(nodeBefore).toBeTruthy()
    expect(barBefore).toBeTruthy()

    await scroller.evaluate(el => { el.scrollLeft = Math.floor((el.scrollWidth - el.clientWidth) / 2) })
    await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0)

    const nodeAfter = await node.boundingBox()
    const barAfter = await bar.boundingBox()
    // Sticky-left column: the left-pane node's viewport x must not move with the scroll.
    expect(Math.abs(nodeAfter!.x - nodeBefore!.x)).toBeLessThan(1.5)
    // The time pane DID scroll — a bar moved left by (roughly) the scroll amount.
    expect(barAfter!.x).toBeLessThan(barBefore!.x - 50)
  })

  test('the frozen ruler does not move during vertical scroll', async ({ page }) => {
    await openTaskGraph(page)
    await switchToGantt(page)
    await zoomInSteps(page, 4) // 2.0x — guarantees vertical overflow

    const scroller = ganttScroll(page)
    const overflow = await scroller.evaluate(el => el.scrollHeight - el.clientHeight)
    expect(overflow).toBeGreaterThan(0)

    const ruler = page.locator('[data-testid="gantt-ruler"]')
    await expect(ruler).toBeVisible()
    const rulerBefore = await ruler.boundingBox()
    const barBefore = await ganttBars(page).first().boundingBox()

    await scroller.evaluate(el => { el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2) })
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(0)

    const rulerAfter = await ruler.boundingBox()
    const barAfter = await ganttBars(page).first().boundingBox()
    // Sticky-top ruler: its viewport y must not move with the vertical scroll.
    expect(Math.abs(rulerAfter!.y - rulerBefore!.y)).toBeLessThan(1.5)
    // The content DID scroll under it — a bar moved up.
    expect(barAfter!.y).toBeLessThan(barBefore!.y - 50)
  })

  test('zoom keeps left-pane rows aligned with their time-pane bars (no drift)', async ({ page }) => {
    await openTaskGraph(page)
    await switchToGantt(page)
    const scroller = ganttScroll(page)
    await scroller.evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0 })

    // A task that has both a left-pane row and a time-pane bar.
    const id = await ganttBars(page).first().getAttribute('data-task-id')
    expect(id).toBeTruthy()
    const nodeRect = page.locator(`[data-layer="nodes"] g[data-task-id="${id}"] > rect`).first()
    const barRect = page.locator(`[data-layer="bars"] g[data-task-id="${id}"] rect`).first()

    const centerY = async (loc: ReturnType<Page['locator']>) => {
      const b = await loc.boundingBox()
      expect(b).toBeTruthy()
      return b!.y + b!.height / 2
    }
    const rowHeight = async () => (await nodeRect.boundingBox())!.height

    // Aligned at 100% — left card and bar share the row's vertical center.
    expect(Math.abs(await centerY(nodeRect) - await centerY(barRect))).toBeLessThan(2)
    const h1 = await rowHeight()

    // Zoom in and re-check from the same scroll origin: rows must still line up.
    await zoomInSteps(page, 4)
    await scroller.evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0 })
    expect(Math.abs(await centerY(nodeRect) - await centerY(barRect))).toBeLessThan(3)
    // The scale actually changed (the row grew), so the alignment held across zoom.
    expect(await rowHeight()).toBeGreaterThan(h1 * 1.5)
  })

  test('a task with a missing estimate renders the assumed-estimate hatch', async ({ page }) => {
    const project = await openTaskGraph(page)
    // A default-visible leaf (non-archive, no archived ancestor) with no estimate.
    const id = await page.evaluate(async (name: string) => {
      const res = await fetch(`/api/tasks/${encodeURIComponent(name)}`)
      const { tasks } = await res.json() as {
        tasks: Record<string, { parent: string | null; workset?: string; estimate?: string | null }>
      }
      const childOf = new Set<string>()
      for (const t of Object.values(tasks)) if (t.parent) childOf.add(t.parent)
      const ws = (tid: string) => tasks[tid]?.workset ?? 'active'
      const archived = (tid: string) => {
        let cur: string | null = tid
        const seen = new Set<string>()
        while (cur && !seen.has(cur)) { seen.add(cur); if (ws(cur) === 'archive') return true; cur = tasks[cur]?.parent ?? null }
        return false
      }
      for (const [tid, t] of Object.entries(tasks)) {
        if (!childOf.has(tid) && !archived(tid) && !t.estimate) return tid
      }
      return null
    }, project.name)
    expect(id, 'a default-visible leaf with a missing estimate').toBeTruthy()

    await switchToGantt(page)
    const bar = page.locator(`[data-layer="bars"] g[data-task-id="${id}"]`)
    await expect(bar).toHaveCount(1)
    await expect(bar).toHaveAttribute('data-assumed', 'true')
    // The assumed flag is backed by the diagonal hatch overlay rect.
    await expect(bar.locator('rect[fill="url(#gantt-assumed-hatch)"]')).toHaveCount(1)
  })

  test('renders only real depends edges — never CPM effective-predecessor edges', async ({ page }) => {
    const project = await openTaskGraph(page)
    // Distinct real-`depends` anchor pairs among the default-visible tasks.
    const expectedPairs = await page.evaluate(async (name: string) => {
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
    expect(expectedPairs).toBeGreaterThan(0)

    await switchToGantt(page)
    const edgeCount = await page.locator('[data-layer="edges"] > g > path').count()
    // Gantt draws ONLY real `depends` (finish-to-start), resolved to visible anchors
    // and minus right-to-left back-edges. Leaking the CPM effective-predecessor graph
    // (group deps expanded to per-leaf edges) would inflate the count well past the
    // real-depends pairs — assert it is non-empty and never exceeds them.
    expect(edgeCount).toBeGreaterThan(0)
    expect(edgeCount).toBeLessThanOrEqual(expectedPairs)
  })

  test('workset filter drops and restores rows in Gantt mode', async ({ page }) => {
    await openTaskGraph(page)
    await switchToGantt(page)
    const before = await taskNodes(page).count()
    const barsBefore = await ganttBars(page).count()
    expect(before).toBeGreaterThan(0)

    await page.locator('button[aria-label="Workset: active"]').click()
    await expect(page.locator('button[aria-label="Workset: active"]')).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => taskNodes(page).count()).toBeLessThan(before)
    await expect.poll(() => ganttBars(page).count()).toBeLessThanOrEqual(barsBefore)

    await page.locator('button[aria-label="Workset: active"]').click()
    await expect.poll(() => taskNodes(page).count()).toBe(before)
  })

  test('collapse/expand all responds in Gantt mode', async ({ page }) => {
    await openTaskGraph(page)
    await switchToGantt(page)
    const expanded = await taskNodes(page).count()

    await page.locator('button[title="Collapse all groups"]').click()
    await expect.poll(() => taskNodes(page).count()).toBeLessThan(expanded)

    await page.locator('button[title="Expand all groups"]').click()
    await expect.poll(() => taskNodes(page).count()).toBe(expanded)
  })

  test('selecting a leaf bar highlights its row in Gantt mode', async ({ page }) => {
    await openTaskGraph(page)
    await switchToGantt(page)

    const leafBar = page.locator('[data-layer="bars"] g[data-task-id][data-summary="false"]').first()
    const id = await leafBar.getAttribute('data-task-id')
    expect(id).toBeTruthy()
    const node = page.locator(`[data-layer="nodes"] g[data-task-id="${id}"]`)

    await expect(node).toHaveAttribute('data-selected', 'false')
    await leafBar.click()
    await expect(node).toHaveAttribute('data-selected', 'true')
  })

  test('search highlights matches and Enter selects in Gantt mode', async ({ page }) => {
    const project = await openTaskGraph(page)
    await switchToGantt(page)

    const search = page.locator('input[placeholder="Search tasks..."]')
    await expect(search).toBeVisible()
    const term = await page.evaluate(async (name: string) => {
      const res = await fetch(`/api/tasks/${encodeURIComponent(name)}`)
      const { tasks } = await res.json() as { tasks: Record<string, unknown> }
      const id = Object.keys(tasks)[0] ?? ''
      return id.split('-')[0] || id
    }, project.name)
    expect(term.length).toBeGreaterThan(0)

    await search.fill(term)
    await expect(page.locator('span', { hasText: /[1-9]\d* match/ })).toBeVisible({ timeout: 3_000 })

    await search.press('Enter')
    await expect(page.locator('[data-layer="nodes"] g[data-selected="true"]')).toHaveCount(1, { timeout: 3_000 })
    await expect(page.getByRole('complementary', { name: 'Task details' })).toHaveCount(0)
  })

  test('the left column renders the same workset section dividers as stacked', async ({ page }) => {
    await openTaskGraph(page)
    // Show every workset so non-active section dividers (Backlog/Archive) exist.
    await page.locator('button[aria-label="Workset: archive"]').click()

    const sections = page.locator('[data-layer="sections"] text')
    await expect.poll(() => sections.count()).toBeGreaterThan(0) // stacked draws dividers
    const stackedLabels = await sections.allTextContents()

    // Gantt reuses the same TaskGraphRows path → identical section dividers.
    await switchToGantt(page)
    await expect.poll(() => sections.count()).toBe(stackedLabels.length)
    expect(await sections.allTextContents()).toEqual(stackedLabels)
  })

  test('the divider resizes the left column and the width persists', async ({ page }) => {
    const project = await openTaskGraph(page)
    await switchToGantt(page)

    const divider = page.locator('[data-testid="gantt-divider"]')
    await expect(divider).toBeVisible()
    const leftCol = page.locator('[data-layer="nodes"]').first()
    const startWidth = (await leftCol.boundingBox())!.width

    // Drag the divider handle right by ~160px → the left column widens by ~that much.
    const box = (await divider.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + 200, { steps: 4 })
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + 200, { steps: 4 })
    await page.mouse.up()

    await expect.poll(async () => (await leftCol.boundingBox())!.width).toBeGreaterThan(startWidth + 40)
    const widened = (await leftCol.boundingBox())!.width

    // The override persists and is re-applied on a fresh load.
    const persisted = await page.evaluate((name: string) =>
      JSON.parse(localStorage.getItem(`yaco-task-workspace:${name}`) || '{}').ganttLeftWidth, project.name)
    expect(persisted).toBeGreaterThan(startWidth + 40)

    await reopenWorkspace(page, project)
    await switchToGantt(page)
    await expect.poll(async () => (await page.locator('[data-layer="nodes"]').first().boundingBox())!.width).toBeGreaterThan(widened - 5)
  })
})

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

    // Layout is Stacked (selected); Pseudo-Gantt is the enabled second mode (desktop).
    const layout = page.locator('[role="group"][aria-label="Layout mode"]')
    await expect(layout.getByRole('button', { name: 'Stacked' })).toHaveAttribute('aria-pressed', 'true')
    await expect(layout.getByRole('button', { name: 'Gantt' })).toBeEnabled()
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
