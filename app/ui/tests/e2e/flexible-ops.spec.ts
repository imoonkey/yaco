import { test, expect, type Page, type Locator, type APIRequestContext } from '@playwright/test'
import {
  provisionWorkspace,
  getWorkspaceState,
  activityPanel,
  expectApproxSize,
  type FixtureProject,
} from './helpers/workspace'
import { dragBegin, dragDrop, dragOver, dockGrabSel, sidebarDropSel } from './helpers/dnd'

// Flexible layout recovery: moving docks is covered by panel DnD; the framed-panel
// grip keeps only the recovery menu for Reset layout.

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

async function resetLayoutFromGrip(page: Page, panelTitle: string): Promise<void> {
  await page.locator(dockGrabSel(panelTitle)).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reset layout' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

test.describe('Flexible layout recovery (dock grip context menu)', () => {
  test('Reset layout restores the whole default arrangement', async ({ page, request }) => {
    const project = await treeWorkspace(page, request)

    // Perturb the layout via real dock DnD: move Sessions into the left sidebar.
    await dragBegin(page, dockGrabSel('Sessions'))
    await dragOver(page, sidebarDropSel('left'), { fy: 0.95 })
    await dragDrop(page, sidebarDropSel('left'), { fy: 0.95 })
    await expect.poll(() => sessionsInsideDock(page)).toBe(true)
    await expect
      .poll(async () => (await getWorkspaceState(page, project.name))?.panelLayout?.version)
      .toBe(1)

    await resetLayoutFromGrip(page, 'Sessions')
    // Default arrangement: Sessions back in the activity column, dock default width.
    await expect.poll(() => sessionsInsideDock(page)).toBe(false)
    await expect(activityPanel(page)).toBeVisible()
    await expect(activityPanel(page)).toHaveAttribute('data-panel-leaf', 'sessions')
    await expect(dock(page)).toBeVisible()
    expectApproxSize((await dock(page).boundingBox())?.width, DOCK)
  })
})
