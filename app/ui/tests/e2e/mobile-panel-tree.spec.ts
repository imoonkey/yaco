import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  provisionWorkspace,
  selectProject,
  createWorktreeFixture,
  waitForAppReady,
  getWorkspaceState,
  createTestFile,
  deleteTestFile,
  openFileViaSearch,
  waitForSSERefresh,
  uniqueFileName,
  type FixtureProject,
} from './helpers/workspace'

// Drives the NEW mobile flexible-panel renderer (engine: 'tree' →
// MobilePanelProjection) and asserts it is behavior-equivalent to the legacy
// mobile branch the portrait "Mobile pane flow" (workspace-persistence.spec.ts)
// and "Landscape mobile pane flow" (landscape-mobile.spec.ts) specs pin. The
// legacy renderer stays the default everywhere else, so these tests opt in by
// seeding the `yaco-panel-tree` flag before the app mounts (same mechanism as
// panel-tree-desktop.spec.ts).
//
// What this pins (design: phase 6 / mobile-panel-projection):
//   - the four panes (browse/editor/tasks/terminal) project through PanelHost +
//     registry mobile docks, portrait PaneSwitch / landscape LandscapeNav,
//   - opening a file switches to the editor pane,
//   - `panelLayout.mobile.activeDock` (the model field the projection reads) AND
//     the legacy `mobilePane` both persist the active pane per project,
//   - the landscape safe-area shell chrome — all under the tree engine.

/** Opt this page into the tree engine before any app script runs. */
async function seedTreeEngine(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('yaco-panel-tree', 'tree') } catch { /* blocked storage */ }
  })
}

let provisioned: FixtureProject[] = []

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

/** Tree-engine isolated workspace (provisioned + selected). */
async function treeWorkspace(page: Page, request: APIRequestContext): Promise<FixtureProject> {
  await seedTreeEngine(page)
  const project = await provisionWorkspace(page, request)
  provisioned.push(project)
  return project
}

/** Tree-engine workspace whose task graph has real nodes, for the Tasks pane. */
async function treeWorkspaceWithTasks(page: Page, request: APIRequestContext): Promise<FixtureProject> {
  await seedTreeEngine(page)
  const project = await createWorktreeFixture(request)
  provisioned.push(project)
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, project.name)
  return project
}

const paneButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

// --- Portrait ---------------------------------------------------------------

test.describe('Mobile panel projection (tree engine) — portrait', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('projects all four panes through the portrait switcher', async ({ page, request }) => {
    await treeWorkspace(page, request)
    for (const name of ['Browse', 'Editor', 'Tasks', 'Terminal']) {
      await expect(paneButton(page, name)).toBeVisible()
    }
  })

  test('opening a file switches to the editor pane', async ({ page, request }) => {
    const project = await treeWorkspace(page, request)
    const testFile = uniqueFileName('mobile_tree_open.txt')

    await createTestFile(page, project.name, testFile, 'mobile tree content\n')
    await waitForSSERefresh(page, 3000)

    // Browse pane first — Sessions section visible.
    await expect(page.getByText('Sessions', { exact: true }).first()).toBeVisible({ timeout: 5000 })

    await openFileViaSearch(page, testFile)
    await expect(page.locator('.cm-content')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.cm-content')).toContainText('mobile tree content')

    // Browse Sessions section is gone (we left the browse pane).
    await expect(page.getByText('Sessions', { exact: true }).first()).not.toBeVisible()

    await deleteTestFile(page, project.name, testFile)
  })

  test('browse pane projects Explorer, Changes, and Sessions sections', async ({ page, request }) => {
    await treeWorkspace(page, request)

    await paneButton(page, 'Browse').click()
    await expect(page.getByText('Changes', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Sessions', { exact: true }).first()).toBeVisible()
  })

  test('active pane persists to both mobile.activeDock and the legacy mobilePane', async ({ page, request }) => {
    const project = await treeWorkspace(page, request)

    await paneButton(page, 'Terminal').click()

    // The terminal pane renders its no-session branch (not a blank pane).
    await expect(page.getByText('Select a session to attach terminal', { exact: true })).toBeVisible()
    await expect(page.getByText('Sessions', { exact: true }).first()).not.toBeVisible()

    // The model field the projection reads AND the legacy field both track it.
    await expect
      .poll(() => getWorkspaceState(page, project.name).then((s) => s?.panelLayout?.mobile?.activeDock))
      .toBe('terminal')
    await expect
      .poll(() => getWorkspaceState(page, project.name).then((s) => s?.mobilePane))
      .toBe('terminal')
  })
})

// --- Landscape --------------------------------------------------------------

test.describe('Mobile panel projection (tree engine) — landscape', () => {
  // iPhone-SE landscape: width <= 768 forces mobile, width > height forces landscape.
  test.use({ viewport: { width: 667, height: 375 }, hasTouch: true })

  const navToggle = (page: Page) => page.getByRole('button', { name: /navigation/i })
  const paneNav = (page: Page) => page.getByRole('navigation', { name: 'Pane navigation' })

  async function openNav(page: Page): Promise<void> {
    await expect(navToggle(page)).toHaveAttribute('aria-expanded', 'false')
    await navToggle(page).click()
    await expect(paneNav(page)).toBeVisible()
  }

  test('renders the LandscapeNav, lists four panes, and marks the active pane', async ({ page, request }) => {
    await treeWorkspace(page, request)

    // Landscape shows the nav toggle, not the portrait switcher.
    await expect(navToggle(page)).toBeVisible()
    await expect(paneButton(page, 'Editor')).toHaveCount(0)

    await openNav(page)
    for (const name of ['Browse', 'Editor', 'Tasks', 'Terminal']) {
      await expect(paneButton(page, name)).toBeVisible()
    }
    await expect(paneNav(page).locator('button[aria-current="page"]')).toHaveCount(1)
    await expect(paneButton(page, 'Browse')).toHaveAttribute('aria-current', 'page')
  })

  test('selecting Tasks projects the task-graph pane', async ({ page, request }) => {
    await treeWorkspaceWithTasks(page, request)

    await openNav(page)
    await paneButton(page, 'Tasks').click()
    await expect(paneNav(page)).toHaveCount(0)

    await expect(page.locator('[data-layer="nodes"]')).toBeVisible({ timeout: 15_000 })
    await expect(
      page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"]').first(),
    ).toBeVisible({ timeout: 15_000 })

    await openNav(page)
    await expect(paneButton(page, 'Tasks')).toHaveAttribute('aria-current', 'page')
  })

  test('applies safe-area insets and right-margin theme chrome', async ({ page, request }) => {
    await treeWorkspace(page, request)

    const container = navToggle(page).locator('xpath=..')
    const pad = await container.evaluate((el) => {
      const s = getComputedStyle(el)
      return {
        left: parseFloat(s.paddingLeft),
        right: parseFloat(s.paddingRight),
        top: parseFloat(s.paddingTop),
        bottom: parseFloat(s.paddingBottom),
      }
    })
    expect(pad.left).toBeGreaterThanOrEqual(36)
    expect(pad.right).toBeGreaterThanOrEqual(36)
    expect(pad.top).toBe(8)
    expect(pad.bottom).toBe(8)

    // Theme toggle sits in the right safe-area margin, beyond the padded content.
    const containerBox = await container.boundingBox()
    expect(containerBox).not.toBeNull()
    const theme = container.getByRole('button', { name: 'Toggle theme' })
    await expect(theme).toBeVisible()
    const box = await theme.boundingBox()
    expect(box).not.toBeNull()
    const contentRightEdge = containerBox!.x + containerBox!.width - pad.right
    expect(box!.x + box!.width / 2).toBeGreaterThan(contentRightEdge)
  })
})
