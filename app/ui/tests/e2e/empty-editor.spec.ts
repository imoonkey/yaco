import { test, expect, type Page } from '@playwright/test'
import {
  provisionWorkspace,
  createFixtureProject,
  createTestFile,
  deleteTestFile,
  uniqueFileName,
  sidebar,
  activityPanel,
  expectApproxSize,
  type FixtureProject,
} from './helpers/workspace'

// The working area is a GROUP grid now. A group sizes uniformly (no special
// empty-editor rule): the working group (`role="main"`) is ALWAYS present — even
// with zero tabs — and the activity column stays at its docked width regardless of
// whether a file is open. These boundingBox assertions pin that uniform geometry.

const DOCKED_ACTIVITY = 280 // default activity split basis (with the working group present)
const VHANDLE = 3 // VResizeHandle width (workspace/ResizeHandle.tsx)

let provisioned: FixtureProject[] = []

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

const mainPane = (page: Page) => page.locator('[role="main"]')

async function widthOf(locator: ReturnType<Page['locator']>): Promise<number> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no bounding box')
  return box.width
}

/** Open a file through Cmd+P quick-open, waiting deterministically for its
 *  result row before selecting it — no blind sleeps, no blind Enter. The quick-
 *  open index is fetched fresh from disk on first open, so a file created before
 *  this call appears in the results; a slow/missing refresh fails the row wait. */
async function openFileViaQuickOpen(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Meta+p')
  const input = page.locator('.quick-search-box input')
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill(query)
  const row = page.locator('[data-search-result-idx]', { hasText: query }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()
  await expect(input).toBeHidden({ timeout: 10_000 }) // dialog closes on select
}

test.describe('Working group sizing (geometry)', () => {
  test('the working group is always present and the columns stay docked whether a file is open', async ({ page, request }) => {
    const project = await ws(page, request)
    const viewportWidth = page.viewportSize()!.width

    // --- No open tabs: the working group is STILL present (uniform sizing) ---
    await expect(activityPanel(page)).toBeVisible()
    await expect(sidebar(page)).toBeVisible()
    await expect(mainPane(page)).toBeVisible()

    const sidebarWidth = await widthOf(sidebar(page))
    const emptyActivity = await widthOf(activityPanel(page))
    const emptyMain = await widthOf(mainPane(page))

    // The activity column holds its docked width (no empty-editor-yields-space), and
    // the working group fills the middle between sidebar and activity (two handles).
    expectApproxSize(emptyActivity, DOCKED_ACTIVITY)
    expectApproxSize(emptyMain, viewportWidth - sidebarWidth - emptyActivity - 2 * VHANDLE, 14)
    // No working-area tabs yet.
    await expect(mainPane(page).locator('[data-testid="group-tab"]')).toHaveCount(0)

    // --- Open a file: it fills the SAME group; the columns do NOT reflow ---
    const testFile = uniqueFileName('empty_editor.txt')
    await createTestFile(page, project.name, testFile, 'hello editor\n')
    await openFileViaQuickOpen(page, testFile)

    await expect(mainPane(page).locator('.cm-content')).toBeVisible({ timeout: 10_000 })
    expectApproxSize(await widthOf(activityPanel(page)), DOCKED_ACTIVITY)
    expectApproxSize(await widthOf(mainPane(page)), emptyMain, 14)

    // --- Close the file via its tab's close × (a real affordance): the group stays
    // present (empty), columns unchanged ---
    const tab = mainPane(page).locator('[data-testid="group-tab"]').first()
    await tab.hover()
    await tab.getByRole('button').click()
    await expect(mainPane(page).locator('[data-testid="group-tab"]')).toHaveCount(0)
    await expect(mainPane(page)).toBeVisible()
    expectApproxSize(await widthOf(activityPanel(page)), DOCKED_ACTIVITY)
    expectApproxSize(await widthOf(mainPane(page)), emptyMain, 14)

    await deleteTestFile(page, project.name, testFile)
  })
})
