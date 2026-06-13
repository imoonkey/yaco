import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  provisionWorkspace,
  createTestFile,
  deleteTestFile,
  openFileViaSearch,
  openPinnedFile,
  waitForSSERefresh,
  uniqueFileName,
  group,
  type FixtureProject,
} from './helpers/workspace'

// USER-QA for the VSCode tab-group editor flows. Drives the SAME affordances a
// user touches — the group tab bar's visible Split button and its right-click menu
// (NOT keyboard shortcuts) — and asserts USER-OBSERVABLE outcomes: a second group
// appears side-by-side (axis row) or stacked (axis col), the original group keeps
// its file tab, the Split menu STAYS OPEN until a choice is made (the Bug 2
// regression), and two files become two sibling editor tabs in one strip.
//
// Outcome (FIX 2): Split SEEDS the new group from the source group's ACTIVE tab —
// an editor tab is DUPLICATED into the new group (a fresh instance sharing the
// per-path buffer), so the original keeps its file AND the new group shows it too.

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

// --- Working-area group affordances (the real DOM contract vt-render shipped) ---

// A group's visible Split button (opens the dismiss-safe Split menu via
// `openFromTrigger`) and its right-clickable empty area (opens the SAME menu via
// `menu.bind()`). Both routes survive the document-click dismiss (Bug 2 fix).
const splitButton = (page: Page, groupId: string) =>
  group(page, groupId).locator('[data-testid="split-group"]')
const emptyArea = (page: Page, groupId: string) =>
  group(page, groupId).locator('[data-testid="group-empty-area"]')
// A group's ACTIVE editor tab body (only the active tab has a body wrapper).
const editorBody = (page: Page, groupId: string) =>
  group(page, groupId).locator('[data-panel-leaf="editor"]')
// A group-tab in a specific group, addressed by its title (an editor tab's title
// is its tabId / file path).
const tabInGroup = (page: Page, groupId: string, title: string) =>
  group(page, groupId).locator(`[data-testid="group-tab"][title="${title}"]`)
// Every working-area group (data-group-id) currently in the tree.
const groupIds = (page: Page) =>
  page.locator('[data-group-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')))

/** The axis of the lowest split node that contains BOTH working groups: 'row' =
 *  side-by-side (left/right split), 'col' = stacked (up/down). Read off the
 *  nearest common split ancestor of the two `[data-group-id]` containers. */
async function groupSplitAxis(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('[data-group-id]'))
    if (groups.length < 2) return null
    let node: HTMLElement | null = groups[0] as HTMLElement
    while (node) {
      const split = node.closest('[data-split-axis]') as HTMLElement | null
      if (!split) return null
      const contained = groups.filter((g) => split.contains(g)).length
      if (contained >= 2) return split.getAttribute('data-split-axis')
      node = split.parentElement
    }
    return null
  })
}

/** Assert two groups split ~50-50 along `axis` ('row' = widths, 'col' = heights):
 *  each within `tol` px of half their combined extent. The pre-fix bug seeded the
 *  new group at a fixed ~240px strip while the source kept the rest, so this fails
 *  unless the split STARTS even (VSCode-like). */
async function expectEvenSplit(
  page: Page, idA: string, idB: string, axis: 'row' | 'col', tol = 28,
): Promise<void> {
  const a = await group(page, idA).boundingBox()
  const b = await group(page, idB).boundingBox()
  expect(a && b, 'both group boxes present').toBeTruthy()
  const sizeA = axis === 'row' ? a!.width : a!.height
  const sizeB = axis === 'row' ? b!.width : b!.height
  const half = (sizeA + sizeB) / 2
  expect(Math.abs(sizeA - half), `group ${idA} ≈ 50% (got ${Math.round(sizeA)} of ${Math.round(sizeA + sizeB)})`).toBeLessThanOrEqual(tol)
  expect(Math.abs(sizeB - half), `group ${idB} ≈ 50% (got ${Math.round(sizeB)} of ${Math.round(sizeA + sizeB)})`).toBeLessThanOrEqual(tol)
}

test.describe('USER-QA: editor group split (button + right-click) → seeded adjacent group', () => {
  test('flow 1: the Split button DUPLICATES the active file into a side-by-side group; the original keeps its file', async ({ page, request }) => {
    const project = await ws(page, request)
    const fileA = uniqueFileName('split_a.ts')
    const fileB = uniqueFileName('split_b.ts')
    await createTestFile(page, project.name, fileA, 'export const ORIGINAL = 1\n')
    await createTestFile(page, project.name, fileB, 'export const SIBLING = 2\n')
    await waitForSSERefresh(page, 3000)

    // Precondition: one group (group:1) showing fileA, no second group yet.
    await openFileViaSearch(page, fileA)
    await expect(tabInGroup(page, 'group:1', fileA)).toBeVisible({ timeout: 10_000 })
    await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('ORIGINAL')
    expect(await groupIds(page)).toEqual(['group:1'])

    // The real user gesture: click the group's visible Split button → its menu →
    // Split Right (a left/right split is a side-by-side, axis 'row').
    await splitButton(page, 'group:1').click()
    await page.getByRole('menuitem', { name: 'Split Right' }).click()

    // OUTCOME (FIX 2): a SECOND group appears side-by-side — group:1 was NOT closed,
    // and the new group is SEEDED with a DUPLICATE of fileA (same buffer, fresh tab),
    // not left empty.
    await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
    expect(await groupIds(page)).toEqual(['group:1', 'group:2'])
    await expect(tabInGroup(page, 'group:1', fileA)).toBeVisible() // original keeps its file
    await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('ORIGINAL')
    await expect(tabInGroup(page, 'group:2', fileA)).toBeVisible() // the duplicate
    await expect(editorBody(page, 'group:2').locator('.cm-content')).toContainText('ORIGINAL')

    // OUTCOME: the two groups tile SIDE-BY-SIDE (split axis 'row'), not stacked.
    expect(await groupSplitAxis(page), 'Split Right tiles the groups side-by-side (row)').toBe('row')

    // OUTCOME (sizing fix): the split STARTS ~50-50 — the new group is half the
    // source's width, not a fixed ~240px strip with the source keeping the rest.
    await expectEvenSplit(page, 'group:1', 'group:2', 'row')

    // The split focused the new group, so opening another file lands THERE → fileB
    // joins group:2's strip; group:1 still shows the original.
    await openFileViaSearch(page, fileB)
    await expect(tabInGroup(page, 'group:2', fileB)).toBeVisible({ timeout: 10_000 })
    await expect(editorBody(page, 'group:2').locator('.cm-content')).toContainText('SIBLING')
    await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('ORIGINAL')

    await page.screenshot({ path: 'test-results/mi-qa-editor-split-flow1.png' })
    await deleteTestFile(page, project.name, fileA)
    await deleteTestFile(page, project.name, fileB)
  })

  test('flow 2: the Split menu STAYS OPEN until a choice; Split Down stacks the groups (col)', async ({ page, request }) => {
    const project = await ws(page, request)
    const file = uniqueFileName('caret.ts')
    await createTestFile(page, project.name, file, 'export const c = 1\n')
    await waitForSSERefresh(page, 3000)

    await openFileViaSearch(page, file)
    await expect(splitButton(page, 'group:1')).toBeVisible()

    // Open the Split menu via the visible button (routed through the dismiss-safe
    // `openFromTrigger` — NOT the deleted left-click `menu.open` antipattern).
    await splitButton(page, 'group:1').click()

    // OUTCOME (Bug 2 fix): the menu + its options are VISIBLE and STAY open — the
    // same document-click that opened it must NOT immediately dismiss it.
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('menuitem', { name: 'Split Right' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Split Down' })).toBeVisible()

    // It must remain open a beat later (the reported bug closed it immediately).
    await page.waitForTimeout(600)
    await expect(menu, 'the Split menu should remain open until the user chooses').toBeVisible()

    await page.screenshot({ path: 'test-results/mi-qa-editor-split-flow2.png' })

    // Choosing "Split Down" → a group SEEDED with the duplicated file, STACKED
    // below (an up/down split is axis 'col').
    await page.getByRole('menuitem', { name: 'Split Down' }).click()
    await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
    await expect(tabInGroup(page, 'group:2', file)).toBeVisible()
    expect(await groupSplitAxis(page), 'Split Down stacks the groups (col)').toBe('col')

    // The vertical split also STARTS ~50-50 — each group is half the source height.
    await expectEvenSplit(page, 'group:1', 'group:2', 'col')

    await deleteTestFile(page, project.name, file)
  })

  test('flow 2b: a RIGHT-CLICK on the tab bar opens the same Split menu (stays open) and spawns a seeded group', async ({ page, request }) => {
    const project = await ws(page, request)
    const file = uniqueFileName('rclick.ts')
    await createTestFile(page, project.name, file, 'export const r = 1\n')
    await waitForSSERefresh(page, 3000)

    await openFileViaSearch(page, file)
    await expect(tabInGroup(page, 'group:1', file)).toBeVisible({ timeout: 10_000 })

    // The OTHER real route: right-click the tab bar's empty area (menu.bind's
    // onContextMenu) — it opens the SAME Split menu, and it stays open.
    await emptyArea(page, 'group:1').click({ button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible({ timeout: 5_000 })
    await page.waitForTimeout(400)
    await expect(menu, 'the right-click Split menu also stays open until a choice').toBeVisible()

    // Split Right → a group seeded with the duplicated file beside (row); the
    // original keeps its file.
    await page.getByRole('menuitem', { name: 'Split Right' }).click()
    await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
    await expect(tabInGroup(page, 'group:2', file)).toBeVisible()
    await expect(tabInGroup(page, 'group:1', file)).toBeVisible()
    expect(await groupSplitAxis(page)).toBe('row')

    await deleteTestFile(page, project.name, file)
  })

  test('new: two files open as TWO editor tabs in ONE strip (flat), both selectable', async ({ page, request }) => {
    const project = await ws(page, request)
    const fileA = uniqueFileName('flat_a.ts')
    const fileB = uniqueFileName('flat_b.ts')
    await createTestFile(page, project.name, fileA, 'export const A = 1\n')
    await createTestFile(page, project.name, fileB, 'export const B = 2\n')
    await waitForSSERefresh(page, 3000)

    // Pin both files into the SAME group (no split). FLAT model: each file is its
    // own editor tab in one strip — opening the second does NOT stack it behind the
    // first; both tabs coexist.
    await openPinnedFile(page, fileA)
    await openPinnedFile(page, fileB)

    await expect(tabInGroup(page, 'group:1', fileA)).toBeVisible({ timeout: 10_000 })
    await expect(tabInGroup(page, 'group:1', fileB)).toBeVisible()
    await expect(group(page, 'group:1').locator('[data-testid="group-tab"][data-tab-kind="editor"]')).toHaveCount(2)
    // Still a single group — the two files are siblings in one strip.
    expect(await groupIds(page)).toEqual(['group:1'])

    // Selecting each tab swaps the visible body to that file.
    await tabInGroup(page, 'group:1', fileA).click()
    await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('export const A')
    await tabInGroup(page, 'group:1', fileB).click()
    await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('export const B')

    await deleteTestFile(page, project.name, fileA)
    await deleteTestFile(page, project.name, fileB)
  })

  test('new: the SAME file open in two groups stays in sync via the shared per-path buffer', async ({ page, request }) => {
    const project = await ws(page, request)
    const file = uniqueFileName('shared.ts')
    await createTestFile(page, project.name, file, 'export const v = 1\n')
    await waitForSSERefresh(page, 3000)

    // group:1 shows the file; the Split DUPLICATES it into group:2 (two editor tabs,
    // two instances, one per group) sharing one per-path buffer (FIX 2 seeding).
    await openFileViaSearch(page, file)
    await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('export const v')
    await splitButton(page, 'group:1').click()
    await page.getByRole('menuitem', { name: 'Split Right' }).click()
    await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
    await expect(tabInGroup(page, 'group:2', file)).toBeVisible({ timeout: 10_000 })

    // Type into group:1's editor → the edit mirrors into group:2's editor showing
    // the same path (one shared buffer per file path).
    await editorBody(page, 'group:1').locator('.cm-content').click()
    await page.keyboard.type('SHAREDEDIT ')
    await expect(editorBody(page, 'group:1').locator('.cm-content')).toContainText('SHAREDEDIT', { timeout: 10_000 })
    await expect(editorBody(page, 'group:2').locator('.cm-content')).toContainText('SHAREDEDIT', { timeout: 10_000 })

    await deleteTestFile(page, project.name, file)
  })

  test('new: a within-group drag reorders the tab strip', async ({ page, request }) => {
    const project = await ws(page, request)
    const fileA = uniqueFileName('order_a.ts')
    const fileB = uniqueFileName('order_b.ts')
    await createTestFile(page, project.name, fileA, 'export const A = 1\n')
    await createTestFile(page, project.name, fileB, 'export const B = 2\n')
    await waitForSSERefresh(page, 3000)

    await openPinnedFile(page, fileA)
    await openPinnedFile(page, fileB)
    const order = () =>
      group(page, 'group:1').locator('[data-testid="group-tab"][data-tab-kind="editor"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('title')))
    expect(await order()).toEqual([fileA, fileB])

    // Drag the second tab before the first → the strip order swaps. The strip uses
    // HTML5 drag-and-drop (the tab's onDragStart sets the dragged id, onDrop fires
    // REORDER_GROUP_TAB), so dispatch the native drag events with a shared
    // DataTransfer — a mouse-only drag never fires dragstart/drop.
    const dt = await page.evaluateHandle(() => new DataTransfer())
    await tabInGroup(page, 'group:1', fileB).dispatchEvent('dragstart', { dataTransfer: dt })
    await tabInGroup(page, 'group:1', fileA).dispatchEvent('dragover', { dataTransfer: dt })
    await tabInGroup(page, 'group:1', fileA).dispatchEvent('drop', { dataTransfer: dt })
    await tabInGroup(page, 'group:1', fileB).dispatchEvent('dragend', { dataTransfer: dt })
    await expect.poll(order).toEqual([fileB, fileA])

    await deleteTestFile(page, project.name, fileA)
    await deleteTestFile(page, project.name, fileB)
  })

  test('new: an EMPTY split group is closable (Close Group menu + Cmd+W)', async ({ page, request }) => {
    await ws(page, request)
    // Fresh workspace: group:1 is empty. Splitting an empty source yields an empty
    // group:2 (nothing to seed) — both groups empty.
    await expect(group(page, 'group:1').getByText('No files open')).toBeVisible({ timeout: 10_000 })
    await splitButton(page, 'group:1').click()
    await page.getByRole('menuitem', { name: 'Split Right' }).click()
    await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
    expect(await groupIds(page)).toEqual(['group:1', 'group:2'])

    // Close the empty group:2 via its tab-bar "Close Group" item → back to one group.
    await splitButton(page, 'group:2').click()
    await page.getByRole('menuitem', { name: 'Close Group' }).click()
    await expect(group(page, 'group:2')).toHaveCount(0, { timeout: 10_000 })
    expect(await groupIds(page)).toEqual(['group:1'])

    // Split again; the new empty group is the active target → Cmd+W closes it.
    await splitButton(page, 'group:1').click()
    await page.getByRole('menuitem', { name: 'Split Right' }).click()
    await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Meta+w')
    await expect(group(page, 'group:2')).toHaveCount(0, { timeout: 10_000 })
    expect(await groupIds(page)).toEqual(['group:1'])
  })
})
