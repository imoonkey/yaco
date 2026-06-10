import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  provisionWorkspace,
  createFixtureProject,
  waitForAppReady,
  getWorkspaceState,
  createTestFile,
  openFileViaSearch,
  waitForSSERefresh,
  uniqueFileName,
  sidebar,
  activityPanel,
  projectsSectionBody,
  expectApproxSize,
  type FixtureProject,
} from './helpers/workspace'

// Characterization: dragging a resize handle in the CURRENT (pre-refactor)
// renderer must update the live geometry, persist the new pixel size, survive a
// reload, and honour the per-axis min clamp. The phase-4 store move re-points the
// localStorage half at the new tree shape; the geometry half here stays the gate.
//
// Every assertion can fail if resize breaks: a no-op drag leaves the size at its
// default (so the "grew by dx" checks fail), and a missing/loose clamp lets the
// min-clamp test read 20px instead of 140px.

let provisioned: FixtureProject[] = []

// This file characterizes the LEGACY flat-layout renderer's pixel sizing +
// flat-field persistence (leftSize/rightSize/projectSize live in `state.layout`,
// and the projects section body carries the size). Since the T6.5 cutover the
// default engine is `tree`, whose sizes live on the panel-tree leaves (different
// node, different field). Pin these characterizations to the legacy engine they
// describe; the tree-engine equivalents (resize → split-child basis, persisted in
// `panelLayout`) are covered by panel-tree-desktop.spec.ts. The whole file +
// legacy renderer are removed together in phase 8.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('yaco-panel-tree', 'legacy') } catch { /* blocked storage */ }
  })
})

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

/** Provision an isolated workspace and track it for teardown. */
async function ws(page: Page, request: Parameters<typeof createFixtureProject>[0]): Promise<FixtureProject> {
  const project = await provisionWorkspace(page, request)
  provisioned.push(project)
  return project
}

// The current renderer's `useResize` listens on document mousemove/mouseup, so a
// real down→move→up pointer gesture is required — a synthetic input event won't
// drive it. `setSize(startSize + totalDelta)`, so the net mouse displacement is
// what changes the size, independent of where on the 3px handle we grab.
async function dragHandle(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  await expect(handle).toBeVisible()
  const box = (await handle.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 6 })
  await page.mouse.move(cx + dx, cy + dy, { steps: 6 })
  await page.mouse.up()
  // Let the resize→updateLayout sync effect run and the 300ms layout-save debounce flush.
  await page.waitForTimeout(700)
}

// Vertical handles (drag horizontally): left of the editor = sidebar width,
// right of the editor = activity width. DOM order is fixed by the renderer:
// sidebar, [left handle], editor, [right handle], activity.
const vHandles = (page: Page) => page.locator('.resize-handle-v')
// Horizontal handles inside the left sidebar: Projects/Explorer then Explorer/Changes.
const sidebarHHandles = (page: Page) => sidebar(page).locator('.resize-handle-h')

const widthOf = (l: Locator) => l.boundingBox().then((b) => b?.width)
const heightOf = (l: Locator) => l.boundingBox().then((b) => b?.height)

test.describe('Drag-resize then reload persistence', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('sidebar handle resizes left width and persists across reload', async ({ page, request }) => {
    const project = await ws(page, request)

    await expect(sidebar(page)).toBeVisible()
    const startW = (await sidebar(page).boundingBox())!.width
    expectApproxSize(startW, 220) // DEFAULT_LAYOUT.leftSize

    // With no open editor tab the right handle is absent, so the only vertical
    // handle is the sidebar one.
    await expect(vHandles(page)).toHaveCount(1)
    const dx = 90 // direction 'left': dragging right grows the sidebar
    await dragHandle(page, vHandles(page).first(), dx, 0)

    // Applied live AND persisted.
    await expect.poll(() => widthOf(sidebar(page))).toBeGreaterThan(startW + dx - 12)
    expectApproxSize(await widthOf(sidebar(page)), startW + dx)
    let state = await getWorkspaceState(page, project.name)
    expectApproxSize(state?.layout?.leftSize, startW + dx)

    // Reload — width and persisted size survive.
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1500)
    expectApproxSize(await widthOf(sidebar(page)), startW + dx)
    state = await getWorkspaceState(page, project.name)
    expectApproxSize(state?.layout?.leftSize, startW + dx)
  })

  test('right handle resizes activity width and persists across reload', async ({ page, request }) => {
    const project = await ws(page, request)
    const file = uniqueFileName('resize_right.txt')
    await createTestFile(page, project.name, file, 'resize the activity column\n')
    await waitForSSERefresh(page, 3000)

    // An open tab makes the activity column width-bound (≈420) and brings up the
    // right vertical handle between the editor and the activity column.
    await openFileViaSearch(page, file)
    await expect(activityPanel(page)).toBeVisible()
    const startW = (await activityPanel(page).boundingBox())!.width
    expectApproxSize(startW, 420) // DEFAULT_LAYOUT.rightSize
    await expect(vHandles(page)).toHaveCount(2)

    const dx = -80 // direction 'right': dragging the handle left grows the activity column
    await dragHandle(page, vHandles(page).nth(1), dx, 0)

    await expect.poll(() => widthOf(activityPanel(page))).toBeGreaterThan(startW - dx - 12)
    expectApproxSize(await widthOf(activityPanel(page)), startW - dx)
    let state = await getWorkspaceState(page, project.name)
    expectApproxSize(state?.layout?.rightSize, startW - dx)

    // Reload — the file tab restores (so the column stays width-bound) and the size holds.
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1500)
    await expect(activityPanel(page)).toBeVisible()
    expectApproxSize(await widthOf(activityPanel(page)), startW - dx)
    state = await getWorkspaceState(page, project.name)
    expectApproxSize(state?.layout?.rightSize, startW - dx)
  })

  test('section handle resizes the projects section and persists across reload', async ({ page, request }) => {
    const project = await ws(page, request)

    // Projects + Explorer both expanded by default → the Projects/Explorer handle
    // is the first horizontal handle in the sidebar.
    await expect(projectsSectionBody(page)).toBeVisible()
    const startH = (await projectsSectionBody(page).boundingBox())!.height
    expectApproxSize(startH, 120) // DEFAULT_LAYOUT.projectSize

    const dy = 60 // direction 'down': dragging down grows the projects section
    await dragHandle(page, sidebarHHandles(page).first(), 0, dy)

    await expect.poll(() => heightOf(projectsSectionBody(page))).toBeGreaterThan(startH + dy - 12)
    expectApproxSize(await heightOf(projectsSectionBody(page)), startH + dy)
    let state = await getWorkspaceState(page, project.name)
    expectApproxSize(state?.layout?.projectSize, startH + dy)

    // Reload — the section height and persisted size survive.
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1500)
    expectApproxSize(await heightOf(projectsSectionBody(page)), startH + dy)
    state = await getWorkspaceState(page, project.name)
    expectApproxSize(state?.layout?.projectSize, startH + dy)
  })

  test('sidebar min-width clamp holds while dragging and persists', async ({ page, request }) => {
    const project = await ws(page, request)

    await expect(sidebar(page)).toBeVisible()
    expectApproxSize(await widthOf(sidebar(page)), 220)

    // Drag the sidebar handle far past its 140px minimum (220 - 200 = 20).
    await dragHandle(page, vHandles(page).first(), -200, 0)

    // Clamped exactly at the 140px minimum, not 20px.
    expectApproxSize(await widthOf(sidebar(page)), 140)
    let state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.leftSize).toBe(140)

    // Reload — the clamped size persists.
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1500)
    expectApproxSize(await widthOf(sidebar(page)), 140)
    state = await getWorkspaceState(page, project.name)
    expect(state?.layout?.leftSize).toBe(140)
  })
})
