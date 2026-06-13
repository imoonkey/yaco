import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test'
import {
  provisionWorkspace, selectProject, waitForAppReady, waitForSSERefresh,
  openPinnedFile, uniqueFileName, runTag,
  group, allGroups, activityPanel, type FixtureProject,
} from './helpers/workspace'
import {
  dragBegin, dragOver, dragDrop, paneDragDrop,
  groupBodySel, groupBgSel, tabSel, dockGrabSel, sidebarDropSel, edgeStripSel,
} from './helpers/dnd'

// combined-e2e — panel DnD + kind-routing, driven through the REAL affordances a
// user operates (a tab, a tab-bar background, a dock grab handle, a body edge, a
// sidebar/edge drop target, the "Separate editors and terminals" menu item) and
// asserted on USER-OBSERVABLE outcomes (the resulting split AXIS as on-screen
// geometry, a merge, which group a session/file lands in), never selector
// existence alone. HTML5 drag is dispatched as genuine drag events on the real
// elements (see helpers/dnd.ts — headless Chromium won't start a native drag
// from synthetic mouse moves).

test.use({ viewport: { width: 1280, height: 800 } })

let fixture: FixtureProject | null = null
const openedSessions: string[] = []

test.afterEach(async ({ request }) => {
  for (const name of openedSessions.splice(0)) {
    await request.post(`/api/sessions/${encodeURIComponent(name)}/close`).catch(() => undefined)
  }
  if (fixture) { await fixture.dispose(); fixture = null }
})

// --- Observable-state probes -------------------------------------------------

/** The visible tab titles inside a scope (a group, the activity panel, the page). */
async function tabTitles(scope: Page | Locator): Promise<string[]> {
  return scope.locator('[data-testid="group-tab"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''))
}

/** The structural id of the group that holds the tab titled `title`. */
async function groupIdOfTab(page: Page, title: string): Promise<string | null> {
  return page.locator(`[data-group-id]:has([data-testid="group-tab"][title="${title}"])`)
    .first().getAttribute('data-group-id')
}

/** The on-screen box of the group holding the tab titled `title` — the truest
 *  read of a split's AXIS (side-by-side ⇒ row, stacked ⇒ column). */
async function boxOfGroupWithTab(page: Page, title: string) {
  const box = await page.locator(`[data-group-id]:has([data-testid="group-tab"][title="${title}"])`).first().boundingBox()
  if (!box) throw new Error(`no group box for tab ${title}`)
  return box
}

async function startShell(request: APIRequestContext, cwd: string): Promise<string> {
  const name = `dnd-rt-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell: ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as { name: string }
  openedSessions.push(body.name)
  return body.name
}

const sessionRow = (page: Page, name: string) => activityPanel(page).getByText(name, { exact: true }).first()

/** Attach a session as a PINNED terminal tab (two row clicks: open preview, then
 *  pin). Pinning is required wherever a terminal must COEXIST with a later open —
 *  a group holds at most one PREVIEW tab, so a 2nd preview open would evict it. */
async function attachPinned(page: Page, name: string): Promise<void> {
  await sessionRow(page, name).click()
  await expect(page.locator(tabSel(name))).toHaveCount(1, { timeout: 15_000 })
  await sessionRow(page, name).click() // already-shown → focus + pin
}

/** A dock leaf that now lives in the right "Activity panel" — matches whether the
 *  region is a single leaf (role + data-dock-leaf on ONE element) or a column
 *  (the leaf is a descendant of the complementary landmark). */
const complementaryDock = (page: Page, panel: string) =>
  page.locator(`[role="complementary"][data-dock-leaf="${panel}"], [role="complementary"] [data-dock-leaf="${panel}"]`)

/** Provision an isolated project seeded with files, load + select it. */
async function setup(page: Page, request: APIRequestContext, files: Record<string, string>): Promise<void> {
  fixture = await provisionWorkspace(page, request, { files })
  await waitForSSERefresh(page, 2000)
}

/** Provision + start `count` shells, then load + select so the session rows show. */
async function setupWithSessions(
  page: Page, request: APIRequestContext, files: Record<string, string>, count: number,
): Promise<string[]> {
  const project = await provisionWorkspace(page, request, { files })
  fixture = project
  const sessions: string[] = []
  for (let i = 0; i < count; i++) sessions.push(await startShell(request, project.path))
  // Reload so the freshly-started sessions appear in the list.
  await page.reload()
  await waitForAppReady(page)
  await selectProject(page, project.name)
  for (const s of sessions) await expect(sessionRow(page, s)).toBeVisible({ timeout: 15_000 })
  return sessions
}

/** Flip the kind-routing toggle ON through the REAL split-menu checkbox item. */
async function enableSeparateKinds(page: Page): Promise<void> {
  await group(page, 'group:1').getByTestId('split-group').click()
  const item = page.getByRole('menuitemcheckbox', { name: 'Separate editors and terminals' })
  await expect(item).toBeVisible({ timeout: 10_000 })
  await item.click()
  await expect(item).toHaveAttribute('aria-checked', 'true') // the check flips visibly
  await page.keyboard.press('Escape')
  await expect(item).toBeHidden()
}

// =============================================================================
// DnD — driven through the real drag affordances
// =============================================================================

test.describe('Panel DnD (real drag affordances → observable layout)', () => {
  test('a tab split-dropped on the RIGHT body edge makes a side-by-side (row) split and moves the tab', async ({ page, request }) => {
    const a = uniqueFileName('a.ts'), b = uniqueFileName('b.ts')
    await setup(page, request, { [a]: 'export const a=1\n', [b]: 'export const b=2\n' })
    await openPinnedFile(page, a)
    await openPinnedFile(page, b)
    await expect(allGroups(page)).toHaveCount(1)

    // Drag tab `a` onto group:1's body RIGHT edge → a fresh group beside it.
    await paneDragDrop(page, tabSel(a), groupBodySel('group:1'), { fx: 0.9, fy: 0.5 })

    await expect(allGroups(page)).toHaveCount(2)
    // The tab moved OUT of group:1 (which keeps b); a lives in a different group.
    await expect.poll(() => groupIdOfTab(page, a)).not.toBe('group:1')
    expect(await tabTitles(group(page, 'group:1'))).toEqual([b])
    // AXIS, read as geometry: the a-group sits to the RIGHT of the b-group, same row.
    const bBox = await boxOfGroupWithTab(page, b)
    const aBox = await boxOfGroupWithTab(page, a)
    expect(aBox.x).toBeGreaterThan(bBox.x + bBox.width / 2)
    expect(Math.abs(aBox.y - bBox.y)).toBeLessThan(40)
  })

  test('a tab split-dropped on the BOTTOM body edge makes a stacked (column) split', async ({ page, request }) => {
    const a = uniqueFileName('a.ts'), b = uniqueFileName('b.ts')
    await setup(page, request, { [a]: 'export const a=1\n', [b]: 'export const b=2\n' })
    await openPinnedFile(page, a)
    await openPinnedFile(page, b)

    await paneDragDrop(page, tabSel(a), groupBodySel('group:1'), { fx: 0.5, fy: 0.9 })

    await expect(allGroups(page)).toHaveCount(2)
    // AXIS: the a-group sits BELOW the b-group, same column.
    const bBox = await boxOfGroupWithTab(page, b)
    const aBox = await boxOfGroupWithTab(page, a)
    expect(aBox.y).toBeGreaterThan(bBox.y + bBox.height / 2)
    expect(Math.abs(aBox.x - bBox.x)).toBeLessThan(40)
  })

  test('dragging a whole group (its tab-bar background) onto another group MERGES them', async ({ page, request }) => {
    const a = uniqueFileName('a.ts'), b = uniqueFileName('b.ts')
    await setup(page, request, { [a]: 'export const a=1\n', [b]: 'export const b=2\n' })
    await openPinnedFile(page, a)
    await openPinnedFile(page, b) // group:1 = [a, b]

    // Split-DROP tab b to the right body edge → group:1 = [a], group:2 = [b] (a real
    // tab move, no editor-split seeding — so the merge below is clean).
    await paneDragDrop(page, tabSel(b), groupBodySel('group:1'), { fx: 0.9, fy: 0.5 })
    await expect(allGroups(page)).toHaveCount(2)
    expect(await tabTitles(group(page, 'group:1'))).toEqual([a])

    // Drag the WHOLE second group (its tab-bar background) onto group:1's bar → merge.
    const g2 = (await groupIdOfTab(page, b))!
    await paneDragDrop(page, groupBgSel(g2), groupBgSel('group:1'))

    await expect(allGroups(page)).toHaveCount(1)
    expect(await tabTitles(group(page, 'group:1'))).toEqual([a, b])
  })

  test('the RIGHT sidebar caps at one group — a 2nd tab dropped there MERGES, never a 2nd group', async ({ page, request }) => {
    const a = uniqueFileName('a.ts'), b = uniqueFileName('b.ts')
    await setup(page, request, { [a]: 'export const a=1\n', [b]: 'export const b=2\n' })
    await openPinnedFile(page, a)
    await openPinnedFile(page, b) // group:1 = [a, b]
    await expect(activityPanel(page).locator('[data-group-id]')).toHaveCount(0)

    // First tab → CREATES the one right-sidebar group.
    await paneDragDrop(page, tabSel(a), sidebarDropSel('right'))
    await expect(activityPanel(page).locator('[data-group-id]')).toHaveCount(1)

    // Second tab → MERGES into that same group (the cap), still one group on the right.
    await paneDragDrop(page, tabSel(b), sidebarDropSel('right'))
    await expect(activityPanel(page).locator('[data-group-id]')).toHaveCount(1)
    expect((await tabTitles(activityPanel(page))).sort()).toEqual([a, b].sort())
  })

  test('the LEFT sidebar REJECTS a tab drop — no drop zone, tree unchanged', async ({ page, request }) => {
    const a = uniqueFileName('a.ts'), b = uniqueFileName('b.ts')
    await setup(page, request, { [a]: 'export const a=1\n', [b]: 'export const b=2\n' })
    await openPinnedFile(page, a)
    await openPinnedFile(page, b)

    // Hold a live tab drag: the LEFT offers no drop zone (illegal), the RIGHT does.
    await dragBegin(page, tabSel(a))
    await expect(page.locator(sidebarDropSel('left'))).toHaveCount(0)
    await expect(page.locator(sidebarDropSel('right'))).toHaveCount(1)

    // Dropping over a left dock is a no-op: still one group, both tabs intact.
    await dragDrop(page, '[data-dock-leaf="changes"]')
    await expect(allGroups(page)).toHaveCount(1)
    expect(await tabTitles(group(page, 'group:1'))).toEqual([a, b])
  })

  test('a dock drags across sidebars (left → right)', async ({ page, request }) => {
    const a = uniqueFileName('a.ts')
    await setup(page, request, { [a]: 'export const a=1\n' })
    // Changes starts in the LEFT dock column; Sessions on the right.
    await expect(page.locator('[role="navigation"] [data-dock-leaf="changes"]')).toHaveCount(1)
    await expect(complementaryDock(page, 'changes')).toHaveCount(0)

    // Dock drag is legal on BOTH sidebars; move Changes onto the right column.
    await dragBegin(page, dockGrabSel('Changes'))
    await expect(page.locator(sidebarDropSel('right'))).toHaveCount(1)
    await dragOver(page, sidebarDropSel('right'))
    await dragDrop(page, sidebarDropSel('right'))

    await expect(complementaryDock(page, 'changes')).toHaveCount(1)
    await expect(page.locator('[role="navigation"] [data-dock-leaf="changes"]')).toHaveCount(0)
  })

  test('the far edge reveals a sidebar — dropping a dock on the right edge re-creates the right column', async ({ page, request }) => {
    const a = uniqueFileName('a.ts')
    await setup(page, request, { [a]: 'export const a=1\n' })

    // Empty the right column: move its only dock (Sessions) into the left sidebar.
    await dragBegin(page, dockGrabSel('Sessions'))
    await dragOver(page, sidebarDropSel('left'), { fy: 0.95 })
    await dragDrop(page, sidebarDropSel('left'), { fy: 0.95 })
    await expect(activityPanel(page)).toHaveCount(0) // right region gone

    // Drag a dock to the far-RIGHT edge strip (revealed only during a dock drag).
    await dragBegin(page, dockGrabSel('Changes'))
    await expect(page.locator(edgeStripSel('right'))).toHaveCount(1)
    await dragOver(page, edgeStripSel('right'))
    await dragDrop(page, edgeStripSel('right'))

    // A right sidebar re-appears, now holding Changes.
    await expect(activityPanel(page)).toHaveCount(1)
    await expect(complementaryDock(page, 'changes')).toHaveCount(1)
  })
})

// =============================================================================
// Kind-routing — toggled via the real menu item, driven via real session/file opens
// =============================================================================

test.describe('Kind-routing (real "Separate editors and terminals" toggle)', () => {
  test('ON: a file open and a session click land in TWO SEPARATE groups (editor-home vs terminal-home)', async ({ page, request }) => {
    const a = uniqueFileName('a.ts')
    const [s1] = await setupWithSessions(page, request, { [a]: 'export const a=1\n' }, 1)

    await enableSeparateKinds(page)
    await openPinnedFile(page, a)               // editor-home (group:1, was empty)
    await attachPinned(page, s1)                // terminal — no terminal home → new group

    const editorGroup = await groupIdOfTab(page, a)
    const terminalGroup = await groupIdOfTab(page, s1)
    expect(editorGroup).not.toBeNull()
    expect(terminalGroup).not.toBeNull()
    expect(editorGroup).not.toBe(terminalGroup) // separated by kind
    // Each group is single-kind.
    await expect(group(page, editorGroup!).locator('[data-testid="group-tab"][data-tab-kind="terminal"]')).toHaveCount(0)
    await expect(group(page, terminalGroup!).locator('[data-testid="group-tab"][data-tab-kind="editor"]')).toHaveCount(0)
  })

  test('ON: a session click joins the existing RIGHT-sidebar terminal home (no new center group)', async ({ page, request }) => {
    const a = uniqueFileName('a.ts')
    const [s1, s2] = await setupWithSessions(page, request, { [a]: 'export const a=1\n' }, 2)

    await enableSeparateKinds(page)
    await attachPinned(page, s1) // terminal s1 (pinned) → empty group:1

    // Move s1's terminal into the right sidebar → the terminal home now lives there.
    await paneDragDrop(page, tabSel(s1), sidebarDropSel('right'))
    await expect(activityPanel(page).locator('[data-tab-kind="terminal"]')).toHaveCount(1)
    // Focus that right-sidebar terminal group so it is the unambiguous terminal home
    // (an empty focused center group would otherwise accept the next open).
    await activityPanel(page).locator(tabSel(s1)).click()

    // A 2nd session click routes to that right-sidebar terminal home — both share it.
    await sessionRow(page, s2).click()
    await expect(activityPanel(page).locator('[data-tab-kind="terminal"]')).toHaveCount(2)
    expect((await tabTitles(activityPanel(page))).sort()).toEqual([s1, s2].sort())
    // Exactly one group on the right — the cap held.
    await expect(activityPanel(page).locator('[data-group-id]')).toHaveCount(1)
  })

  test('ON: with no editor home, two file opens create EXACTLY ONE new center group (not two)', async ({ page, request }) => {
    const a = uniqueFileName('a.ts'), b = uniqueFileName('b.ts')
    const [s1] = await setupWithSessions(page, request, { [a]: 'export const a=1\n', [b]: 'export const b=2\n' }, 1)

    await sessionRow(page, s1).click() // terminal → group:1 (sep still OFF)
    await expect(page.locator(tabSel(s1))).toHaveCount(1, { timeout: 15_000 })
    await enableSeparateKinds(page)
    await openPinnedFile(page, a) // no editor home → ONE new center group
    await openPinnedFile(page, b) // editor home now exists → joins it (not a 2nd group)

    await expect(allGroups(page)).toHaveCount(2) // terminal group + the single editor group
    expect(await groupIdOfTab(page, a)).toBe(await groupIdOfTab(page, b)) // a + b share one group
    expect(await groupIdOfTab(page, a)).not.toBe(await groupIdOfTab(page, s1))
  })

  test('OFF: a session click and a file open BOTH land in the focused group', async ({ page, request }) => {
    const a = uniqueFileName('a.ts')
    const [s1] = await setupWithSessions(page, request, { [a]: 'export const a=1\n' }, 1)

    // sep OFF (default): opens follow focus, not kind.
    await attachPinned(page, s1)
    await openPinnedFile(page, a)

    await expect(allGroups(page)).toHaveCount(1)
    expect(await groupIdOfTab(page, a)).toBe('group:1')
    expect(await groupIdOfTab(page, s1)).toBe('group:1')
    await expect(group(page, 'group:1').locator('[data-tab-kind="editor"]')).toHaveCount(1)
    await expect(group(page, 'group:1').locator('[data-tab-kind="terminal"]')).toHaveCount(1)
  })
})
