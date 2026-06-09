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

// Characterization of the CURRENT landscape-mobile renderer (WorkspaceLayout's
// `isMobile && isLandscape` branch). Complements the portrait "Mobile pane flow"
// characterization in workspace-persistence.spec.ts. It pins the three things the
// flexible-layout refactor moves into MobilePanelProjection: the LandscapeNav pane
// flow (incl. the Tasks pane), and the landscape safe-area shell chrome.
//
// Viewport: iPhone-SE landscape (667x375) + touch. width <= 768 forces
// `useIsMobile` via its narrow-width branch (no reliance on pointer:coarse
// emulation), and width > height makes `useIsLandscape` true — together they
// select the landscape branch deterministically.
test.use({ viewport: { width: 667, height: 375 }, hasTouch: true })

// Every test provisions its own isolated project (unique per run) and disposes it
// after, so nothing depends on a pre-existing ~/.yaco registry entry.
let provisioned: FixtureProject[] = []

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

/** Provision a minimal isolated workspace and track it for teardown. */
async function ws(page: Page, request: APIRequestContext): Promise<FixtureProject> {
  const project = await provisionWorkspace(page, request)
  provisioned.push(project)
  return project
}

/** Provision an isolated workspace whose task graph has real nodes, for the
 *  Tasks-pane projection test. */
async function wsWithTasks(page: Page, request: APIRequestContext): Promise<FixtureProject> {
  const project = await createWorktreeFixture(request)
  provisioned.push(project)
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, project.name)
  return project
}

// --- LandscapeNav probes ---

/** The collapsed/expanded LandscapeNav toggle (aria-label flips between
 *  "Open navigation" / "Close navigation"). */
const navToggle = (page: Page) => page.getByRole('button', { name: /navigation/i })
/** The expanded horizontal pane nav (only mounted while open). */
const paneNav = (page: Page) => page.getByRole('navigation', { name: 'Pane navigation' })
const paneButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

async function openNav(page: Page): Promise<void> {
  const toggle = navToggle(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(paneNav(page)).toBeVisible()
  await expect(navToggle(page)).toHaveAttribute('aria-expanded', 'true')
}

/** Open the nav, pick a pane, and confirm the nav closes (its close-on-select
 *  behavior). */
async function selectPane(page: Page, name: string): Promise<void> {
  await openNav(page)
  await paneButton(page, name).click()
  await expect(paneNav(page)).toHaveCount(0)
  await expect(navToggle(page)).toHaveAttribute('aria-expanded', 'false')
}

// --- Tests ---

test.describe('Landscape mobile pane flow characterization', () => {
  test('landscape renders the LandscapeNav toggle, not the portrait pane switcher', async ({ page, request }) => {
    await ws(page, request)

    // The collapsed toggle is present and closed.
    await expect(navToggle(page)).toBeVisible()
    await expect(navToggle(page)).toHaveAttribute('aria-expanded', 'false')

    // The portrait segmented PaneSwitch is absent: its Editor/Terminal buttons
    // are only rendered (a) by the portrait switcher, or (b) inside the OPEN
    // landscape nav. With the nav closed and in landscape, neither exists.
    await expect(paneButton(page, 'Editor')).toHaveCount(0)
    await expect(paneButton(page, 'Terminal')).toHaveCount(0)
  })

  test('LandscapeNav opens, lists all four panes, and marks the active pane', async ({ page, request }) => {
    await ws(page, request)

    await openNav(page)

    for (const name of ['Browse', 'Editor', 'Tasks', 'Terminal']) {
      await expect(paneButton(page, name)).toBeVisible()
    }

    // Default pane is Browse (mobilePane: 'files') -> exactly one active item, Browse.
    await expect(paneNav(page).locator('button[aria-current="page"]')).toHaveCount(1)
    await expect(paneButton(page, 'Browse')).toHaveAttribute('aria-current', 'page')
    await expect(paneButton(page, 'Editor')).not.toHaveAttribute('aria-current', 'page')

    // Backdrop click (Escape) collapses the nav without changing panes.
    await page.keyboard.press('Escape')
    await expect(paneNav(page)).toHaveCount(0)
  })

  test('selecting Tasks in LandscapeNav projects the task-graph pane', async ({ page, request }) => {
    await wsWithTasks(page, request)

    await selectPane(page, 'Tasks')

    // The mobile Tasks pane renders the real task graph (nodes layer + at least
    // one task node from the fixture's tasks.json).
    await expect(page.locator('[data-layer="nodes"]')).toBeVisible({ timeout: 15_000 })
    await expect(
      page.locator('[data-layer="nodes"] g[role="button"][aria-label^="Task:"]').first(),
    ).toBeVisible({ timeout: 15_000 })

    // The nav now marks Tasks as the active pane (and only Tasks).
    await openNav(page)
    await expect(paneNav(page).locator('button[aria-current="page"]')).toHaveCount(1)
    await expect(paneButton(page, 'Tasks')).toHaveAttribute('aria-current', 'page')
    await expect(paneButton(page, 'Browse')).not.toHaveAttribute('aria-current', 'page')
  })

  test('opening a file switches to the editor pane and updates the active pane', async ({ page, request }) => {
    const project = await ws(page, request)
    const testFile = uniqueFileName('landscape_open.txt')

    await createTestFile(page, project.name, testFile, 'landscape editor content\n')
    await waitForSSERefresh(page, 3000)

    // Opening a file (quick-open) flips the mobile projection to the editor pane.
    await openFileViaSearch(page, testFile)
    await expect(page.locator('.cm-content')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.cm-content')).toContainText('landscape editor content')

    // LandscapeNav reflects the editor pane as the active pane (and only it).
    await openNav(page)
    await expect(paneNav(page).locator('button[aria-current="page"]')).toHaveCount(1)
    await expect(paneButton(page, 'Editor')).toHaveAttribute('aria-current', 'page')

    await deleteTestFile(page, project.name, testFile)
  })

  test('LandscapeNav pane selection persists per project', async ({ page, request }) => {
    const project = await ws(page, request)

    await selectPane(page, 'Terminal')

    // The terminal pane actually renders its no-session branch (not a blank pane).
    await expect(page.getByText('Select a session to attach terminal', { exact: true })).toBeVisible()
    // ...the browse Sessions section is gone...
    await expect(page.getByText('Sessions', { exact: true }).first()).not.toBeVisible()
    // ...and the selection persists under the current `yaco-workspace:<project>` key.
    await expect
      .poll(() => getWorkspaceState(page, project.name).then((s) => s?.mobilePane))
      .toBe('terminal')
  })

  test('landscape shell applies safe-area insets and right-margin chrome', async ({ page, request }) => {
    await ws(page, request)

    // The landscape container (the LandscapeNav toggle's parent) pads the side
    // margins to at least 36px (the safe-area floor) and 8px top/bottom. If the
    // safe-area padding were dropped these would collapse to 0.
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

    // The theme toggle is placed in the right safe-area margin (landscape chrome
    // placement), not inline inside the padded content. Its center must sit beyond
    // the padded content's right edge. Scope to the landscape container to avoid the
    // app-shell theme toggle.
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
