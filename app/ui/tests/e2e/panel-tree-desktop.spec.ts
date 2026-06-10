import { test, expect, type Page, type Locator, type APIRequestContext } from '@playwright/test'
import {
  provisionWorkspace,
  createFixtureProject,
  createWorktreeFixture,
  selectProject,
  waitForAppReady,
  getWorkspaceState,
  openFileViaSearch,
  sectionHeader,
  expectApproxSize,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// Drives the desktop flexible-tree renderer — the sole desktop renderer since the
// T8 legacy-deletion (the `engine` flag and the flat skeleton are gone). Asserts
// its geometry + behavior.
//
// What this pins (design: phase 5 / desktop-tree-renderer):
//   - geometry: dock ≈ 220, activity ≈ 420 (tab open), projects ≈ 120, editor
//     fills the remainder, and empty-editor yields the freed width to activity.
//   - behavior: Cmd+B / Cmd+Shift+B hide-restore the dock / activity column,
//     section collapse drives the framed SectionHeader, resize persists, and an
//     attached terminal does NOT remount on an unrelated re-render.
//   - persistence + hidden-subtree restore migrated here from the deleted
//     legacy-pinned specs (resize-persist / hidden-dock / the legacy halves of
//     workspace-persistence): section size + collapse survive reload, and a
//     Cmd+B hide/restore preserves a resized dock basis + a collapsed section.
//   - tasks-active keeps the activity column docked (migrated from the legacy
//     close-surface case).

const VHANDLE = 3 // ResizeHandle.tsx width
const DOCK = 220 // default dock split basis
const ACTIVITY = 420 // default activity split basis
const PROJECTS = 120 // default projects leaf basis

test.use({ viewport: { width: 1280, height: 800 } })

let provisioned: FixtureProject[] = []

test.afterEach(async () => {
  const all = provisioned
  provisioned = []
  await Promise.all(all.map((f) => f.dispose().catch(() => undefined)))
})

/** Provision an isolated workspace and select it (tree is the only renderer). */
async function treeWorkspace(page: Page, request: APIRequestContext): Promise<FixtureProject> {
  const project = await provisionWorkspace(page, request)
  provisioned.push(project)
  return project
}

// Tree-renderer node probes (the renderer stamps each node with its tree id).
const dock = (page: Page) => page.locator('[data-node-id="dock"]')
const activity = (page: Page) => page.locator('[data-node-id="activity"]')
const mainNode = (page: Page) => page.locator('[data-node-id="main"]')
const projectsLeaf = (page: Page) => page.locator('[data-panel-leaf="projects"]')

const widthOf = async (l: Locator): Promise<number> => {
  const box = await l.boundingBox()
  if (!box) throw new Error('no bounding box')
  return box.width
}
const heightOf = async (l: Locator): Promise<number> => {
  const box = await l.boundingBox()
  if (!box) throw new Error('no bounding box')
  return box.height
}

test.describe('Desktop tree renderer — geometry', () => {
  test('default columns: dock ≈ 220, projects ≈ 120, empty editor yields width to activity', async ({ page, request }) => {
    await treeWorkspace(page, request)

    // The tree rendered (its stamped nodes exist) — not the legacy skeleton.
    await expect(dock(page)).toBeVisible()
    await expect(activity(page)).toBeVisible()
    expectApproxSize(await widthOf(dock(page)), DOCK)
    expectApproxSize(await heightOf(projectsLeaf(page)), PROJECTS)

    // Empty editor: no open tabs ⇒ the main tabs node is excluded and the activity
    // column absorbs the freed width (one handle between dock and activity).
    await expect(mainNode(page)).toHaveCount(0)
    const vw = page.viewportSize()!.width
    const emptyActivity = await widthOf(activity(page))
    expectApproxSize(emptyActivity, vw - DOCK - VHANDLE, 14)
    expect(emptyActivity).toBeGreaterThan(ACTIVITY + 200)
  })

  test('opening a file mounts the editor and snaps activity back to its docked width', async ({ page, request }) => {
    await treeWorkspace(page, request)
    await expect(mainNode(page)).toHaveCount(0)

    // README.md ships with the fixture and is indexed at load.
    await openFileViaSearch(page, 'README')

    await expect(mainNode(page)).toBeVisible()
    const vw = page.viewportSize()!.width
    const dockW = await widthOf(dock(page))
    const activityW = await widthOf(activity(page))
    const mainW = await widthOf(mainNode(page))

    expectApproxSize(dockW, DOCK)
    expectApproxSize(activityW, ACTIVITY)
    // Editor fills the remainder between dock and activity (two handles).
    expectApproxSize(mainW, vw - dockW - activityW - 2 * VHANDLE, 16)
  })
})

test.describe('Desktop tree renderer — dock / activity toggles', () => {
  test('Cmd+B hides and restores the dock column', async ({ page, request }) => {
    await treeWorkspace(page, request)
    await expect(dock(page)).toBeVisible()

    await page.keyboard.press('Meta+b')
    await expect(dock(page)).toHaveCount(0)

    await page.keyboard.press('Meta+b')
    await expect(dock(page)).toBeVisible()
    expectApproxSize(await widthOf(dock(page)), DOCK)
  })

  test('Cmd+Shift+B hides and restores the activity column', async ({ page, request }) => {
    await treeWorkspace(page, request)
    await expect(activity(page)).toBeVisible()

    await page.keyboard.press('Meta+Shift+b')
    await expect(activity(page)).toHaveCount(0)

    await page.keyboard.press('Meta+Shift+b')
    await expect(activity(page)).toBeVisible()
  })

  test('a reveal (Cmd+Shift+F) and subsequent Cmd+B keep flat + tree visibility in lockstep', async ({ page, request }) => {
    await treeWorkspace(page, request)
    await expect(dock(page)).toBeVisible()

    // Hide the dock (flat showSidebar → false, mirrored onto the tree).
    await page.keyboard.press('Meta+b')
    await expect(dock(page)).toHaveCount(0)

    // Reveal via text search. This writes ONLY the flat store (showSidebar:true);
    // the dock must reappear under the tree engine — proving the reveal path stays
    // in lockstep. (Pre-fix the tree dock stayed hidden, so search was invisible.)
    await page.keyboard.press('Meta+Shift+f')
    await expect(dock(page)).toBeVisible()

    // Now Cmd+B must HIDE again — not flip the opposite way. (Pre-fix, the blind
    // tree toggle had drifted out of phase with the flat store, so this re-opened
    // the dock instead of closing it.)
    await page.keyboard.press('Meta+b')
    await expect(dock(page)).toHaveCount(0)

    // And toggle back on, still in step.
    await page.keyboard.press('Meta+b')
    await expect(dock(page)).toBeVisible()
  })
})

test.describe('Desktop tree renderer — section collapse', () => {
  test('the framed Projects header collapses its section under the tree engine', async ({ page, request }) => {
    await treeWorkspace(page, request)

    const header = sectionHeader(page, 'Projects')
    // Click the header interior (not its center): collapsed it is a 28px row
    // directly above the Files header, so a center click sits on their shared
    // edge and Playwright's hit-test can resolve to the neighbour.
    const hit = { position: { x: 20, y: 6 } }
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    expectApproxSize(await heightOf(projectsLeaf(page)), PROJECTS)

    // Collapse → header flips and the section renders header-only (≪ its basis).
    await header.click(hit)
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(await heightOf(projectsLeaf(page))).toBeLessThan(50)

    // Restore.
    await header.click(hit)
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    expectApproxSize(await heightOf(projectsLeaf(page)), PROJECTS)
  })
})

test.describe('Desktop tree renderer — resize persistence', () => {
  test('dragging the dock handle resizes and persists the split child basis', async ({ page, request }) => {
    const project = await treeWorkspace(page, request)

    // Open a file so both vertical handles are present; the first is dock|main.
    await openFileViaSearch(page, 'README')
    await expect(mainNode(page)).toBeVisible()
    const startW = await widthOf(dock(page))
    expectApproxSize(startW, DOCK)

    const handle = page.locator('.resize-handle-v').first()
    const box = (await handle.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const dx = 80 // drag right ⇒ grow the dock
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + dx / 2, cy, { steps: 6 })
    await page.mouse.move(cx + dx, cy, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(700) // resize commit + 300ms layout-save debounce

    await expect.poll(() => widthOf(dock(page))).toBeGreaterThan(startW + dx - 14)
    expectApproxSize(await widthOf(dock(page)), startW + dx, 16)

    // Persisted into the panel-layout tree (version 1), not the flat layout.
    const state = await getWorkspaceState(page, project.name)
    expect(state?.panelLayout?.version).toBe(1)

    // Reload — the wider dock survives.
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1500)
    await expect(dock(page)).toBeVisible()
    expectApproxSize(await widthOf(dock(page)), startW + dx, 18)
  })

  // Migrated from the deleted legacy resize-persist.spec.ts ("section handle
  // resizes the projects section"): the dock is a col split, so the projects|files
  // handle is a horizontal handle that resizes the projects section's height. The
  // size lives on the split-child basis (panelLayout), so it survives reload.
  test('dragging a section handle resizes the projects section and persists', async ({ page, request }) => {
    const project = await treeWorkspace(page, request)

    await expect(dock(page)).toBeVisible()
    const startH = await heightOf(projectsLeaf(page))
    expectApproxSize(startH, PROJECTS)

    // First horizontal handle inside the dock = projects|files; drag down to grow.
    const handle = dock(page).locator('.resize-handle-h').first()
    const box = (await handle.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const dy = 60
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx, cy + dy / 2, { steps: 6 })
    await page.mouse.move(cx, cy + dy, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(700) // resize commit + 300ms layout-save debounce

    await expect.poll(() => heightOf(projectsLeaf(page))).toBeGreaterThan(startH + dy - 14)
    expectApproxSize(await heightOf(projectsLeaf(page)), startH + dy, 16)
    expect((await getWorkspaceState(page, project.name))?.panelLayout?.version).toBe(1)

    // Reload — the taller projects section survives.
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1500)
    expectApproxSize(await heightOf(projectsLeaf(page)), startH + dy, 18)
  })

  // Migrated from the deleted legacy resize-persist.spec.ts "right handle resizes
  // activity width": with a file open the root row is dock|main|activity, so the
  // SECOND vertical handle (main|activity) resizes the right activity column. The
  // size lives on its split-child basis (panelLayout), so it survives reload.
  test('dragging the activity handle resizes the activity column and persists', async ({ page, request }) => {
    const project = await treeWorkspace(page, request)

    // Open a file so both vertical handles exist and the activity column is
    // width-bound (≈ ACTIVITY); the second handle is main|activity.
    await openFileViaSearch(page, 'README')
    await expect(mainNode(page)).toBeVisible()
    const startW = await widthOf(activity(page))
    expectApproxSize(startW, ACTIVITY)

    const handle = page.locator('.resize-handle-v').nth(1)
    const box = (await handle.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const grow = 80 // drag the handle LEFT ⇒ grow the activity column
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx - grow / 2, cy, { steps: 6 })
    await page.mouse.move(cx - grow, cy, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(700) // resize commit + 300ms layout-save debounce

    await expect.poll(() => widthOf(activity(page))).toBeGreaterThan(startW + grow - 14)
    expectApproxSize(await widthOf(activity(page)), startW + grow, 16)
    expect((await getWorkspaceState(page, project.name))?.panelLayout?.version).toBe(1)

    // Reload — the file tab restores (so activity stays width-bound) and the size holds.
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1500)
    await expect(activity(page)).toBeVisible()
    expectApproxSize(await widthOf(activity(page)), startW + grow, 18)
  })
})

// Persistence + hidden-subtree restore, migrated from the deleted legacy-pinned
// specs now that the tree is the live source (resize-persist / hidden-dock / the
// legacy halves of workspace-persistence). Each pins behavior the tree renderer
// now owns: a collapsed section survives reload, and a Cmd+B hide/restore brings
// back the prior dock width AND a section's collapse flag.
test.describe('Desktop tree renderer — collapse persistence + hidden-dock restore', () => {
  test('a collapsed section persists across reload', async ({ page, request }) => {
    await treeWorkspace(page, request)

    const header = sectionHeader(page, 'Projects')
    const hit = { position: { x: 20, y: 6 } } // avoid the shared edge with the Files header
    await expect(header).toHaveAttribute('aria-expanded', 'true')

    await header.click(hit)
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(await heightOf(projectsLeaf(page))).toBeLessThan(50)

    // Reload — still collapsed (the leaf carries `collapsed` in panelLayout).
    await page.reload()
    await waitForAppReady(page)
    await page.waitForTimeout(1500)
    await expect(sectionHeader(page, 'Projects')).toHaveAttribute('aria-expanded', 'false')
    expect(await heightOf(projectsLeaf(page))).toBeLessThan(50)
  })

  test('Cmd+B hide/restore preserves a resized dock basis and a collapsed section', async ({ page, request }) => {
    await treeWorkspace(page, request)

    // Open a file so the dock|main vertical handle exists, then widen the dock.
    await openFileViaSearch(page, 'README')
    await expect(mainNode(page)).toBeVisible()
    const startW = await widthOf(dock(page))
    expectApproxSize(startW, DOCK)

    const handle = page.locator('.resize-handle-v').first()
    const box = (await handle.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const dx = 80
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + dx / 2, cy, { steps: 6 })
    await page.mouse.move(cx + dx, cy, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const widerW = await widthOf(dock(page))
    expectApproxSize(widerW, startW + dx, 16)

    // Collapse the Projects section — the flag that must survive the hide/restore.
    const header = sectionHeader(page, 'Projects')
    await header.click({ position: { x: 20, y: 6 } })
    await expect(header).toHaveAttribute('aria-expanded', 'false')

    // Hide the dock (Cmd+B), then restore it.
    await page.keyboard.press('Meta+b')
    await expect(dock(page)).toHaveCount(0)
    await page.keyboard.press('Meta+b')
    await expect(dock(page)).toBeVisible()

    // Width preserved AND Projects still collapsed (hidden subtree kept its state).
    expectApproxSize(await widthOf(dock(page)), widerW, 16)
    await expect(sectionHeader(page, 'Projects')).toHaveAttribute('aria-expanded', 'false')
  })

  // Migrated from the deleted legacy hidden-dock.spec.ts ACTIVITY case: Cmd+Shift+B
  // hides AND restores the right activity column, preserving its resized basis and
  // the Sessions section's collapse flag (the hidden subtree keeps its state).
  test('Cmd+Shift+B hide/restore preserves the activity basis and Sessions collapse', async ({ page, request }) => {
    await treeWorkspace(page, request)

    // Open a file so the main|activity handle exists and activity is width-bound.
    await openFileViaSearch(page, 'README')
    await expect(mainNode(page)).toBeVisible()
    const startW = await widthOf(activity(page))
    expectApproxSize(startW, ACTIVITY)

    // Widen the activity column off its default (so a reset-to-default would fail
    // the size check below — proving the basis is genuinely preserved).
    const handle = page.locator('.resize-handle-v').nth(1)
    const box = (await handle.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const grow = 80
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx - grow / 2, cy, { steps: 6 })
    await page.mouse.move(cx - grow, cy, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const widerW = await widthOf(activity(page))
    expectApproxSize(widerW, startW + grow, 16)

    // Collapse the Sessions section (it lives in the activity column) — the flag
    // that must survive the hide/restore. Click the header interior, not a button.
    const sessions = sectionHeader(page, 'Sessions')
    await expect(sessions).toHaveAttribute('aria-expanded', 'true')
    await sessions.click({ position: { x: 20, y: 6 } })
    await expect(sessions).toHaveAttribute('aria-expanded', 'false')

    // Hide the activity column (Cmd+Shift+B), then restore it.
    await page.keyboard.press('Meta+Shift+b')
    await expect(activity(page)).toHaveCount(0)
    await page.keyboard.press('Meta+Shift+b')
    await expect(activity(page)).toBeVisible()

    // Width preserved AND Sessions still collapsed (hidden subtree kept its state).
    expectApproxSize(await widthOf(activity(page)), widerW, 16)
    await expect(sectionHeader(page, 'Sessions')).toHaveAttribute('aria-expanded', 'false')
  })
})

// Migrated from the deleted legacy close-surface case "tasks-active with no open
// tabs keeps the activity column at its docked width": when Tasks is the active
// main panel, `withEmptyEditorRule` keeps the main node occupying its width even
// with zero editor tabs, so the activity column stays at its docked ~420 instead
// of flex-expanding over the main region.
test.describe('Desktop tree renderer — tasks-active activity width', () => {
  test('tasks active with no open tabs keeps the activity column docked', async ({ page, request }) => {
    const project = await createWorktreeFixture(request)
    provisioned.push(project)
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, project.name)

    // Open Tasks into the main region; no file has been opened, so zero editor tabs.
    await page.keyboard.press('Meta+Shift+t')
    await expect(mainNode(page)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="tab"]')).toHaveCount(0)

    // The activity column holds its fixed docked width (~420), not flex-expanding
    // toward half the viewport (~530 on 1280px) the way an empty editor would.
    await expect(activity(page)).toBeVisible()
    const activityW = await widthOf(activity(page))
    expect(activityW).toBeGreaterThan(360)
    expect(activityW).toBeLessThan(480)
  })
})

// --- Terminal no-remount under the tree engine ------------------------------

async function startShellSession(request: APIRequestContext, project: FixtureProject): Promise<string> {
  const name = `shell-${runTag()}`
  const res = await request.post('/api/sessions/start', {
    data: { provider: 'shell', cwd: project.path, name },
  })
  expect(res.ok(), `start shell session: ${res.status()}`).toBeTruthy()
  return ((await res.json()) as { name: string }).name
}

const xterm = (page: Page) => page.locator('.yaco-terminal-xterm')

test.describe('Desktop tree renderer — terminal lifecycle', () => {
  test('attached terminal keeps its node across an unrelated re-render', async ({ page, request }) => {
    const project = await createFixtureProject(request)
    provisioned.push(project)
    const sessionName = await startShellSession(request, project)

    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, project.name)

    // The shell session lists in the activity column's Sessions section.
    const sessionRow = activity(page).getByText(sessionName, { exact: true })
    await expect(sessionRow).toBeVisible({ timeout: 15_000 })
    await sessionRow.click()
    await expect(xterm(page)).toBeVisible({ timeout: 15_000 })

    // Stamp the live xterm node so a remount (new node) is observable.
    const node = await xterm(page).elementHandle()
    expect(node).not.toBeNull()
    await node!.evaluate((el) => el.setAttribute('data-tree-probe', 'attached'))

    // Re-render #1: open a file. The main tabs node mounts and the activity column
    // resizes from absorber to fixed — big layout churn — but the terminal must not
    // remount (same node still attached, current node still stamped).
    await expect(mainNode(page)).toHaveCount(0)
    await openFileViaSearch(page, 'README')
    await expect(mainNode(page)).toBeVisible({ timeout: 15_000 })
    expect(await node!.evaluate((el) => el.isConnected), 'terminal node disposed (remounted)').toBe(true)
    expect(await xterm(page).getAttribute('data-tree-probe'), 'live xterm replaced (remounted)').toBe('attached')

    // Re-render #2: collapse a sidebar section — unrelated layout-state change.
    const header = sectionHeader(page, 'Projects')
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(await node!.evaluate((el) => el.isConnected), 'terminal node disposed after collapse').toBe(true)
    expect(await xterm(page).getAttribute('data-tree-probe')).toBe('attached')

    await request.post(`/api/sessions/${encodeURIComponent(sessionName)}/close`).catch(() => undefined)
  })
})
