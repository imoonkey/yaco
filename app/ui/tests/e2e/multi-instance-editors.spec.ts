import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  provisionWorkspace,
  createTestFile,
  deleteTestFile,
  openFileViaSearch,
  openPinnedFile,
  waitForSSERefresh,
  uniqueFileName,
  sectionHeader,
  group,
  type FixtureProject,
} from './helpers/workspace'

// Multi-instance editor flows under the VSCode tab-group model (design: vt-bodies
// shared buffer, vt-keyboard split, reset). Pins the user-visible acceptance:
//   - Cmd+\ splits the focused editor's group into a side-by-side group SEEDED with
//     a duplicate of the active file (FIX 2): two editor tabs on one path that SHARE
//     one buffer (an edit in one shows in the other; the dirty dot lands on both);
//   - Reset layout collapses the extra group, but the dirty buffer survives as
//     data (reopening the file shows the unsaved edit).

test.use({ viewport: { width: 1280, height: 800 } })

let provisioned: FixtureProject[] = []

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

async function ws(page: Page, request: APIRequestContext): Promise<FixtureProject> {
  const project = await provisionWorkspace(page, request)
  provisioned.push(project)
  return project
}

// The ACTIVE editor body of a group (only the active tab has a body wrapper).
const editorBody = (page: Page, groupId: string) => group(page, groupId).locator('[data-panel-leaf="editor"]')
const tabInGroup = (page: Page, groupId: string, title: string) =>
  group(page, groupId).locator(`[data-testid="group-tab"][title="${title}"]`)

/** Focus the group:1 editor body, then Cmd+\ to split its group into a
 *  side-by-side sibling (group:2). With an editor active, the split SEEDS group:2
 *  with a duplicate of the file (FIX 2). */
async function splitFocusedEditor(page: Page): Promise<void> {
  await editorBody(page, 'group:1').locator('.cm-content').click()
  await expect(editorBody(page, 'group:1')).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('Meta+\\')
  await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
}

/** Open a framed dock panel's header menu and click an item (waits for it to close). */
async function runPanelMenu(page: Page, panelTitle: string, item: string): Promise<void> {
  await sectionHeader(page, panelTitle).getByRole('button', { name: 'Panel menu' }).click()
  await page.getByRole('menuitem', { name: item }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
}

test.describe('Multi-instance editors (split / shared buffer / reset)', () => {
  test('Cmd+\\ splits the editor group side-by-side; the same file in both groups shares one buffer', async ({ page, request }) => {
    const project = await ws(page, request)
    const file = uniqueFileName('shared.ts')
    await createTestFile(page, project.name, file, 'export const v = 1\n')
    await waitForSSERefresh(page, 3000)

    // Pin the file in group:1, then Cmd+\ → group:2 SEEDED with a duplicate of it.
    await openPinnedFile(page, file)
    await expect(tabInGroup(page, 'group:1', file)).toBeVisible({ timeout: 10_000 })
    await splitFocusedEditor(page)

    // The split DUPLICATED the active file into the focused new group (FIX 2): two
    // editor tabs on one path, one per group, sharing the per-path buffer.
    await expect(tabInGroup(page, 'group:2', file)).toBeVisible({ timeout: 10_000 })
    await expect(tabInGroup(page, 'group:1', file)).toBeVisible()

    // Type in the group:1 editor → the edit propagates to the group:2 editor showing
    // the same path (one shared per-path buffer).
    await editorBody(page, 'group:1').locator('.cm-content').click()
    await page.keyboard.type('SHAREDEDIT ')
    await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('SHAREDEDIT', { timeout: 10_000 })
    await expect(editorBody(page, 'group:2').locator('.cm-content')).toContainText('SHAREDEDIT', { timeout: 10_000 })

    // The dirty dot is by path, so it shows on the file's tab in BOTH groups.
    await expect(tabInGroup(page, 'group:1', file).locator('.rounded-full')).toBeVisible()
    await expect(tabInGroup(page, 'group:2', file).locator('.rounded-full')).toBeVisible()

    await deleteTestFile(page, project.name, file)
  })

  test('Reset layout collapses the extra group but the dirty buffer survives', async ({ page, request }) => {
    const project = await ws(page, request)
    const file = uniqueFileName('reset_dirty.ts')
    await createTestFile(page, project.name, file, 'export const r = 1\n')
    await waitForSSERefresh(page, 3000)

    await openPinnedFile(page, file)
    await splitFocusedEditor(page)
    await expect(page.locator('[data-group-id]')).toHaveCount(2) // two groups now

    // Dirty the shared buffer (typed in the group:1 editor; dirty is by path).
    await editorBody(page, 'group:1').locator('.cm-content').click()
    await page.keyboard.type('DIRTYRESET ')
    await expect(tabInGroup(page, 'group:1', file).locator('.rounded-full')).toBeVisible()

    // Reset layout via a dock panel's kebab (the editor body has no Reset).
    await runPanelMenu(page, 'Sessions', 'Reset layout')

    // The extra group is discarded → back to a single working group...
    await expect(group(page, 'group:2')).toHaveCount(0)
    await expect(page.locator('[data-group-id]')).toHaveCount(1)

    // ...but the unsaved edit survived as a buffer: reopening the file shows it,
    // still dirty (recoverable, not lost).
    await openFileViaSearch(page, file)
    await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('DIRTYRESET', { timeout: 10_000 })
    await expect(tabInGroup(page, 'group:1', file).locator('.rounded-full')).toBeVisible()

    await deleteTestFile(page, project.name, file)
  })
})
