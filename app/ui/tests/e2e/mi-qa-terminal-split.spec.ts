import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  activityPanel,
  group,
  createTestFile,
  openPinnedFile,
  waitForSSERefresh,
  uniqueFileName,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// USER-QA for the VSCode tab-group TERMINAL flows. Drives the REAL provider
// `clickSession` (a click on the actual Sessions-list row — NOT a test bypass), so
// a regression back to the old MRU/active-terminal rebind is caught end-to-end.
//
// Under the FLAT group model a terminal is its own TAB in a working group (bound on
// create), never a standalone leaf or an unbound placeholder pane. A session click
// opens a PREVIEW terminal (like a file preview); re-clicking pins it. The asserted
// USER-OBSERVABLE outcomes:
//   3. splitting a terminal-active group MOVES the terminal into the new group (the
//      SAME instance — no new PTY); clicking another session then binds it on create
//      WITHOUT rebinding the first.
//   4. every terminal TAB has a working close ×; closing it removes the tab and the
//      session keeps running (survives).
//   5. Open beside binds each session to its OWN distinct group/tab (the contrast).

test.use({ viewport: { width: 1280, height: 800 } })

let fixture: FixtureProject | null = null
const openedSessions: string[] = []

test.afterEach(async ({ request }) => {
  for (const name of openedSessions.splice(0)) {
    await request.post(`/api/sessions/${encodeURIComponent(name)}/close`).catch(() => undefined)
  }
  if (fixture) {
    await fixture.dispose()
    fixture = null
  }
})

async function startShell(request: APIRequestContext, cwd: string): Promise<string> {
  const name = `mi-qa-term-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell: ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as { name: string }
  openedSessions.push(body.name)
  return body.name
}

async function waitServed(request: APIRequestContext, name: string): Promise<void> {
  await expect.poll(async () => {
    const res = await request.get('/api/projects')
    return res.ok() && (await res.json() as { name: string }[]).some((p) => p.name === name)
  }, { timeout: 10_000 }).toBe(true)
}

// The Sessions-list ROW (in the activity panel) — clicking it drives the REAL
// provider clickSession. Scoped to the activity panel so it never resolves to the
// session's name as it appears in a terminal TAB title in the working area.
const sessionRow = (page: Page, name: string) =>
  activityPanel(page).getByText(name, { exact: true }).first()
// A bound terminal TAB shows its session name as the tab label/title. Optionally
// scoped to one group.
const terminalTab = (scope: Page | ReturnType<Page['locator']>, name: string) =>
  scope.locator(`[data-testid="group-tab"][data-tab-kind="terminal"][title="${name}"]`)
const allTerminalTabs = (page: Page) =>
  page.locator('[data-testid="group-tab"][data-tab-kind="terminal"]')
const idlePlaceholder = (page: Page) => page.getByText('Select a session to attach terminal')
const splitButton = (page: Page, groupId: string) =>
  group(page, groupId).locator('[data-testid="split-group"]')
const closeGroupButton = (page: Page, groupId: string) =>
  group(page, groupId).locator('[data-testid="close-group"]')
const emptyArea = (page: Page, groupId: string) =>
  group(page, groupId).locator('[data-testid="group-empty-area"]')
const allGroups = (page: Page) => page.locator('[data-group-id]')

async function openProjectWithSessions(
  page: Page, request: APIRequestContext, count: number,
): Promise<{ project: FixtureProject; sessions: string[] }> {
  const project = await createFixtureProject(request)
  fixture = project
  const sessions: string[] = []
  for (let i = 0; i < count; i++) sessions.push(await startShell(request, project.path))
  await waitServed(request, project.name)
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, project.name)
  for (const s of sessions) await expect(sessionRow(page, s)).toBeVisible({ timeout: 15_000 })
  return { project, sessions }
}

test.describe('USER-QA: terminal tabs — bind-on-create (3) / close × (4) / open-beside (5)', () => {
  test('flow A: a session click opens a PREVIEW terminal (italic) that survives its own focus; a second click pins it (Bug A)', async ({ page, request }) => {
    const { sessions: [s1] } = await openProjectWithSessions(page, request, 1)

    // First click → a PREVIEW terminal tab (italic). FIX A: creating + auto-focusing
    // the terminal must NOT pin it — the preview must SURVIVE (the bug pinned it
    // immediately on the xterm's mount focus, so it was never a preview).
    await sessionRow(page, s1).click()
    const tab = terminalTab(group(page, 'group:1'), s1)
    await expect(tab).toBeVisible({ timeout: 15_000 })
    await expect(tab, 'a fresh session click is a PREVIEW terminal (italic)').toHaveCSS('font-style', 'italic')

    // It STAYS a preview while idle — the mount/auto-focus (and PTY output) never
    // promote it.
    await page.waitForTimeout(600)
    await expect(tab, 'the preview survives its own auto-focus — not auto-pinned').toHaveCSS('font-style', 'italic')

    // A second click on the same session row pins it (click once = preview, click
    // again = pinned) → no longer italic.
    await sessionRow(page, s1).click()
    await expect(tab, 'a second session click pins the preview (no longer italic)').not.toHaveCSS('font-style', 'italic')
  })

  test('flow 3: splitting a terminal-active group MOVES the terminal (same instance), then a second session binds without rebinding (Bug 3)', async ({ page, request }) => {
    const { sessions: [s1, s2] } = await openProjectWithSessions(page, request, 2)

    // Bind s1 via the REAL session-row click → a PREVIEW terminal tab in group:1;
    // re-click PINS it (a session tab behaves like a file tab: click = preview, click
    // again = pinned), so it survives the split move + a later session preview.
    await sessionRow(page, s1).click()
    const s1Tab = terminalTab(group(page, 'group:1'), s1)
    await expect(s1Tab).toBeVisible({ timeout: 15_000 })
    await sessionRow(page, s1).click() // re-click → pinned
    const s1Instance = await s1Tab.getAttribute('data-tab-instance')

    // Split group:1 whose ACTIVE tab is s1's terminal → the terminal MOVES into the
    // new group (FIX 2): the SAME instance (no new PTY) now lives in group:2, and the
    // source group:1 is left empty (its only tab moved out).
    await splitButton(page, 'group:1').click()
    await page.getByRole('menuitem', { name: 'Split Right' }).click()
    await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
    const movedTab = terminalTab(group(page, 'group:2'), s1)
    await expect(movedTab, 's1 terminal moved into the new group').toBeVisible({ timeout: 10_000 })
    expect(await movedTab.getAttribute('data-tab-instance'), 'the SAME terminal instance moved — no new PTY').toBe(s1Instance)
    await expect(group(page, 'group:1').getByText('No files open'), 'the source group is left empty').toBeVisible()
    await expect(allTerminalTabs(page), 'still exactly one terminal — moved, not duplicated').toHaveCount(1)

    // Click the OTHER session row (the REAL provider clickSession). OUTCOME (Bug 3
    // fix): s2 is BOUND ON CREATE to its OWN new terminal tab in the active group;
    // s1 is NOT rebound — its (pinned, moved) terminal survives, still bound to s1.
    await sessionRow(page, s2).click()
    await expect(terminalTab(page, s2), 's2 is bound on create to its own new terminal tab').toHaveCount(1, { timeout: 15_000 })
    await expect(terminalTab(page, s1), 's1 MUST stay bound — clicking s2 must NOT rebind/replace it').toHaveCount(1)
    await expect(idlePlaceholder(page), 'no empty/idle terminal placeholder is left behind').toHaveCount(0)

    // Two DISTINCT bound terminals coexist (s1 + s2) — neither overwrote the other.
    const ids = await allTerminalTabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-tab-instance')))
    expect(ids.length, 'two terminal tabs (s1 + s2), not one rebound').toBe(2)
    expect(new Set(ids).size, 'the two terminal tabs are distinct instances').toBe(2)

    await page.screenshot({ path: 'test-results/mi-qa-terminal-flow3.png' })
  })

  test('flow 4: a bound terminal tab has a working close × and the session survives', async ({ page, request }) => {
    const { sessions: [s1] } = await openProjectWithSessions(page, request, 1)

    await sessionRow(page, s1).click()
    const tab = terminalTab(group(page, 'group:1'), s1)
    await expect(tab).toBeVisible({ timeout: 15_000 })

    // Every terminal tab carries a close × (Bug 4: it can never be an unclosable
    // header-less pane). Hover to reveal it, then close.
    await tab.hover()
    const closeX = tab.getByRole('button', { name: 'Close terminal' })
    await expect(closeX, 'a terminal tab always offers a close ×').toHaveCount(1)
    await closeX.click()

    // OUTCOME: the tab is gone, no idle placeholder takes its place, and the session
    // KEEPS RUNNING (closePane detaches the tab, not the PTY) — its row stays listed
    // (afterEach closes it by name and would throw if it were already gone).
    await expect(tab).toHaveCount(0, { timeout: 10_000 })
    await expect(idlePlaceholder(page)).toHaveCount(0)
    await expect(sessionRow(page, s1), 's1 keeps running after closing its terminal tab').toBeVisible()

    await page.screenshot({ path: 'test-results/mi-qa-terminal-flow4.png' })
  })

  // Set up a single-terminal group whose split MOVES the terminal into a new group,
  // leaving group:1 empty — the FIX B repro.
  async function splitSingleTerminalLeavingEmptySource(page: Page, s1: string): Promise<void> {
    await sessionRow(page, s1).click()
    await expect(terminalTab(group(page, 'group:1'), s1)).toBeVisible({ timeout: 15_000 })
    await sessionRow(page, s1).click() // re-click → pinned, so it survives the move
    await splitButton(page, 'group:1').click()
    await page.getByRole('menuitem', { name: 'Split Right' }).click()
    await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
    await expect(terminalTab(group(page, 'group:2'), s1), 'terminal moved into the new group').toBeVisible({ timeout: 10_000 })
    await expect(emptyArea(page, 'group:1'), 'the source group:1 is left empty').toBeVisible()
    await expect(allGroups(page)).toHaveCount(2)
  }

  test('flow B-1: the empty source left by a terminal split-move is closable via its Close Group button (Bug B)', async ({ page, request }) => {
    const { sessions: [s1] } = await openProjectWithSessions(page, request, 1)
    await splitSingleTerminalLeavingEmptySource(page, s1)

    // The empty source group offers a VISIBLE Close Group affordance — click it.
    await expect(closeGroupButton(page, 'group:1'), 'the empty group clearly offers a close affordance').toBeVisible()
    await closeGroupButton(page, 'group:1').click()

    // OUTCOME: back to ONE group — the empty source is gone; the moved terminal (in
    // the surviving group) is untouched and still bound.
    await expect(allGroups(page)).toHaveCount(1, { timeout: 10_000 })
    await expect(group(page, 'group:1')).toHaveCount(0)
    await expect(terminalTab(page, s1), 's1 terminal survives the empty-source close').toHaveCount(1)
    await expect(idlePlaceholder(page)).toHaveCount(0)
  })

  test('flow B-2: the empty source is also closable by activating it + Cmd+W (Bug B)', async ({ page, request }) => {
    const { sessions: [s1] } = await openProjectWithSessions(page, request, 1)
    await splitSingleTerminalLeavingEmptySource(page, s1)

    // Click the empty source to make it the active group (and blur the moved
    // terminal's xterm), then Cmd+W → closeFocusedSurface closes the empty active
    // group, NOT the focused terminal in the other group.
    await emptyArea(page, 'group:1').click()
    await page.keyboard.press('Meta+w')

    await expect(allGroups(page)).toHaveCount(1, { timeout: 10_000 })
    await expect(terminalTab(page, s1), 's1 terminal survives — Cmd+W closed the empty group, not the terminal').toHaveCount(1)
    await expect(idlePlaceholder(page)).toHaveCount(0)
  })

  test('flow 5 (contrast): Open beside binds each session to its own distinct tab', async ({ page, request }) => {
    const { sessions: [s1, s2] } = await openProjectWithSessions(page, request, 2)

    // Open beside from the row context menu — it splits to a fresh group and
    // binds the NEW terminal directly (the reported-working path).
    const openBeside = async (name: string) => {
      await sessionRow(page, name).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Open beside' }).click()
      await expect(page.getByRole('menu')).toHaveCount(0)
    }

    await openBeside(s1)
    await expect(terminalTab(page, s1)).toHaveCount(1, { timeout: 15_000 })
    await openBeside(s2)
    await expect(terminalTab(page, s2)).toHaveCount(1, { timeout: 15_000 })

    // Both sessions end up shown in their OWN tabs — neither overwrites the other
    // (the failure mode flow 3 guards against). Distinct instance ids.
    await expect(terminalTab(page, s1)).toHaveCount(1)
    await expect(terminalTab(page, s2)).toHaveCount(1)
    const ids = await allTerminalTabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-tab-instance')))
    expect(new Set(ids).size, 'each terminal tab has a distinct instance id').toBe(ids.length)
    expect(ids.length).toBe(2)

    await page.screenshot({ path: 'test-results/mi-qa-terminal-flow5.png' })
  })

  test('new: clicking a session puts a terminal tab in the SAME strip as an editor tab (mixed, flat)', async ({ page, request }) => {
    const { project, sessions: [s1] } = await openProjectWithSessions(page, request, 1)

    // Open a file as a PINNED editor tab in group:1 (a pinned tab is not replaced by
    // the next preview — the session click opens a PREVIEW terminal).
    const file = uniqueFileName('mixed.ts')
    await createTestFile(page, project.name, file, 'export const m = 1\n')
    await waitForSSERefresh(page, 3000)
    await openPinnedFile(page, file)
    await expect(group(page, 'group:1').locator('[data-testid="group-tab"][data-tab-kind="editor"]')).toHaveCount(1, { timeout: 10_000 })

    // Click the session → a terminal tab joins the SAME group's strip (one uniform,
    // mixed editor+terminal row — the FLAT model).
    await sessionRow(page, s1).click()
    await expect(terminalTab(group(page, 'group:1'), s1)).toBeVisible({ timeout: 15_000 })
    await expect(group(page, 'group:1').locator('[data-testid="group-tab"]')).toHaveCount(2) // 1 editor + 1 terminal
    await expect(group(page, 'group:1').locator('[data-testid="group-tab"][data-tab-kind="editor"]')).toHaveCount(1)
    await expect(group(page, 'group:1').locator('[data-testid="group-tab"][data-tab-kind="terminal"]')).toHaveCount(1)
    // Still a single group — they share one strip.
    await expect(page.locator('[data-group-id]')).toHaveCount(1)
  })
})
