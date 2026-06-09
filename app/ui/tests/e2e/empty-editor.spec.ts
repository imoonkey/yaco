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

// Characterization of the current `shouldShowEditorPane` behavior in
// WorkspaceLayout.tsx:
//
//   shouldShowEditorPane = hasOpenTabs || !showRightPanel
//
// With the activity (right) panel visible and NO open tabs, the editor pane
// (`role="main"`) is not rendered at all and the activity panel takes `flex:1`,
// so it absorbs the width freed by the absent editor. Opening a file flips
// `hasOpenTabs`, which brings the editor pane back and snaps the activity panel
// back to its docked width (`right.size`, default ~420).
//
// The flexible-layout refactor preserves this at the renderer boundary via:
//   mainOccupiesWidth = openTabs.length > 0 || activityChild.hidden
// These boundingBox assertions pin the observable geometry so the new tree
// renderer can be checked against it. Every assertion can fail if the
// empty-editor-yields-space behavior breaks.

const DOCKED_ACTIVITY = 420 // default right.size when the editor pane is present
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

test.describe('Empty editor yields space (geometry)', () => {
  test('no open tabs lets activity fill the freed width; opening/closing a file restores main', async ({ page, request }) => {
    const project = await ws(page, request)
    const viewportWidth = page.viewportSize()!.width

    // --- Empty editor: no open tabs + activity visible ---
    // Wait for positive workspace DOM first, so the editor-absence assertion is
    // meaningful (pre-workspace DOM also has no [role="main"]).
    await expect(activityPanel(page)).toBeVisible()
    await expect(sidebar(page)).toBeVisible()
    // With the workspace rendered, the editor pane is genuinely not in the DOM.
    await expect(mainPane(page)).toHaveCount(0)

    const sidebarWidth = await widthOf(sidebar(page))
    const emptyActivity = await widthOf(activityPanel(page))

    // Activity absorbs everything to the right of the sidebar (one VResizeHandle
    // sits between them; the editor's right handle is absent with no main pane).
    expectApproxSize(emptyActivity, viewportWidth - sidebarWidth - VHANDLE, 12)
    // ...which is far wider than its normal docked width — proves it actually grew.
    expect(emptyActivity).toBeGreaterThan(DOCKED_ACTIVITY + 200)

    // --- Open a file: editor pane reappears, activity snaps back to docked width ---
    const testFile = uniqueFileName('empty_editor.txt')
    await createTestFile(page, project.name, testFile, 'hello editor\n')
    await openFileViaQuickOpen(page, testFile)

    await expect(mainPane(page)).toBeVisible()
    const openMain = await widthOf(mainPane(page))
    const dockedActivity = await widthOf(activityPanel(page))

    expectApproxSize(dockedActivity, DOCKED_ACTIVITY)
    // Opening the file reclaimed width from the activity panel.
    expect(dockedActivity).toBeLessThan(emptyActivity - 200)
    // The editor fills the remainder between sidebar and activity (two handles).
    expect(openMain).toBeGreaterThan(0)
    expectApproxSize(openMain, viewportWidth - sidebarWidth - dockedActivity - 2 * VHANDLE, 14)

    // --- Close the file (Cmd+W): back to empty → activity reclaims the width ---
    await page.keyboard.press('Meta+w')
    await expect(mainPane(page)).toHaveCount(0)
    await expect(activityPanel(page)).toBeVisible()
    const reEmptyActivity = await widthOf(activityPanel(page))
    expectApproxSize(reEmptyActivity, viewportWidth - sidebarWidth - VHANDLE, 12)
    expect(reEmptyActivity).toBeGreaterThan(DOCKED_ACTIVITY + 200)

    // --- Reopen the file: main width is restored again ---
    await openFileViaQuickOpen(page, testFile)
    await expect(mainPane(page)).toBeVisible()
    const reopenMain = await widthOf(mainPane(page))
    expectApproxSize(await widthOf(activityPanel(page)), DOCKED_ACTIVITY)
    expectApproxSize(reopenMain, openMain, 14)

    await deleteTestFile(page, project.name, testFile)
  })
})
