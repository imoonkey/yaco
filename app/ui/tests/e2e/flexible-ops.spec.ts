import { test, expect, type Page, type Locator, type APIRequestContext } from '@playwright/test'
import {
  provisionWorkspace,
  waitForAppReady,
  getWorkspaceState,
  sectionHeader,
  activityPanel,
  expectApproxSize,
  type FixtureProject,
} from './helpers/workspace'

// T8 flexible-operations: the framed-panel header menu surfaces the panel-layout
// commands (move / split-beside / return-to-default / reset). This pins the
// headline acceptance — moving Sessions left/right relocates it AND persists
// across reload — plus reset-position and reset-layout, all through the real
// `PanelMenu` over the desktop tree (the sole renderer since the T8 deletion).

test.use({ viewport: { width: 1280, height: 800 } })

const DOCK = 220

let provisioned: FixtureProject[] = []

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

async function treeWorkspace(page: Page, request: APIRequestContext): Promise<FixtureProject> {
  const project = await provisionWorkspace(page, request)
  provisioned.push(project)
  return project
}

const sessionsLeaf = (page: Page): Locator => page.locator('[data-panel-leaf="sessions"]')
const dock = (page: Page): Locator => page.locator('[data-node-id="dock"]')

/** Is the Sessions leaf rendered horizontally inside the left dock column? True
 *  once it has been moved into the dock; false in the default tree where it lives
 *  in the right activity column. Mode-independent (does not assume an open editor),
 *  so it is stable whether the activity column is docked or absorbing free width. */
async function sessionsInsideDock(page: Page): Promise<boolean> {
  const s = await sessionsLeaf(page).boundingBox()
  const d = await dock(page).boundingBox()
  if (!s || !d) return false
  return s.x >= d.x - 2 && s.x + s.width <= d.x + d.width + 2
}

/** Open a framed panel's header menu and click one of its items, then wait for
 *  the menu to fully close (its exit animation + unmount) so a chained action
 *  opens a clean menu instead of racing the previous one's teardown. */
async function runPanelMenu(page: Page, panelTitle: string, item: string): Promise<void> {
  await sectionHeader(page, panelTitle).getByRole('button', { name: 'Panel menu' }).click()
  await page.getByRole('menuitem', { name: item }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

test.describe('Flexible layout operations (panel header menu)', () => {
  test('moving Sessions left relocates it into the dock and persists across reload', async ({ page, request }) => {
    const project = await treeWorkspace(page, request)

    // Default: Sessions lives in the right activity column — NOT inside the dock.
    await expect(sessionsLeaf(page)).toBeVisible()
    expect(await sessionsInsideDock(page)).toBe(false)

    // Move it left via the header menu (splitPanel beside the leftmost leaf).
    await runPanelMenu(page, 'Sessions', 'Move left')

    // It now renders inside the left dock column.
    await expect.poll(() => sessionsInsideDock(page)).toBe(true)
    // Committed to the panel-layout tree (version 1), so a reload restores it.
    expect((await getWorkspaceState(page, project.name))?.panelLayout?.version).toBe(1)

    // Reload — Sessions stays in the dock (the move persisted).
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1500)
    await expect(sessionsLeaf(page)).toBeVisible()
    expect(await sessionsInsideDock(page)).toBe(true)
  })

  test('moving Sessions right relocates it out of the dock and persists across reload', async ({ page, request }) => {
    const project = await treeWorkspace(page, request)

    // Park Sessions in the dock first (so a rightward move is observable), then
    // move it right via the header menu (splitPanel beside the rightmost leaf).
    await runPanelMenu(page, 'Sessions', 'Move left')
    await expect.poll(() => sessionsInsideDock(page)).toBe(true)

    await runPanelMenu(page, 'Sessions', 'Move right')
    // It leaves the dock and renders in the right region again.
    await expect.poll(() => sessionsInsideDock(page)).toBe(false)
    expect((await getWorkspaceState(page, project.name))?.panelLayout?.version).toBe(1)

    // Reload — Sessions stays out of the dock (the rightward move persisted).
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1500)
    await expect(sessionsLeaf(page)).toBeVisible()
    expect(await sessionsInsideDock(page)).toBe(false)
  })

  test('Reset position returns a moved Sessions panel to its default placement', async ({ page, request }) => {
    await treeWorkspace(page, request)

    await runPanelMenu(page, 'Sessions', 'Move left')
    await expect.poll(() => sessionsInsideDock(page)).toBe(true)

    await runPanelMenu(page, 'Sessions', 'Reset position')
    // Back out of the dock — in the right activity column again.
    await expect.poll(() => sessionsInsideDock(page)).toBe(false)
    // The canonical activity column is rebuilt: the "Activity panel" landmark
    // (keyed on the 'activity' node id) is present and hosts Sessions again. This
    // guards H1 — return-to-default must restore the activity node, not a generic
    // split that drops the landmark.
    await expect(activityPanel(page)).toBeVisible()
    await expect(activityPanel(page).locator('[data-panel-leaf="sessions"]')).toBeVisible()
  })

  test('Reset layout restores the whole default arrangement', async ({ page, request }) => {
    await treeWorkspace(page, request)

    // Perturb the layout: move Sessions out of the activity column into the dock.
    await runPanelMenu(page, 'Sessions', 'Move left')
    await expect.poll(() => sessionsInsideDock(page)).toBe(true)

    await runPanelMenu(page, 'Sessions', 'Reset layout')
    // Default arrangement: Sessions back in the activity column, dock default width.
    await expect.poll(() => sessionsInsideDock(page)).toBe(false)
    await expect(dock(page)).toBeVisible()
    expectApproxSize((await dock(page).boundingBox())?.width, DOCK)
  })
})
