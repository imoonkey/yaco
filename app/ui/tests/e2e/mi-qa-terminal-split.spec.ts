import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  activityPanel,
  group,
  createTestFile,
  openFileViaSearch,
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
// create), never a standalone leaf or an unbound placeholder pane. The asserted
// USER-OBSERVABLE outcomes:
//   3. clicking a session after a split binds it to the NEW (focused) group on
//      create; the first session stays bound where it was (NO rebind); no leftover
//      empty placeholder.
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
  test('flow 3: clicking a second session binds it on create WITHOUT rebinding the first (Bug 3)', async ({ page, request }) => {
    const { sessions: [s1, s2] } = await openProjectWithSessions(page, request, 2)

    // Bind s1 via the REAL session-row click → a bound terminal tab in group:1.
    await sessionRow(page, s1).click()
    await expect(terminalTab(group(page, 'group:1'), s1)).toBeVisible({ timeout: 15_000 })

    // Split group:1 → an EMPTY adjacent group (decided OQ2: a split spawns an empty
    // group, NEVER a stranded/unbound terminal pane). Capture the emptiness now,
    // before any focus settles — there is no leftover placeholder to fill.
    await splitButton(page, 'group:1').click()
    await page.getByRole('menuitem', { name: 'Split Right' }).click()
    await expect(group(page, 'group:2')).toBeVisible({ timeout: 10_000 })
    await expect(group(page, 'group:2').locator('[data-panel-leaf]'), 'the split made an EMPTY group, not a stranded terminal').toHaveCount(0)
    await expect(group(page, 'group:2').getByText('No files open')).toBeVisible()

    // Click the OTHER session row (the REAL provider clickSession). OUTCOME (Bug 3
    // fix): s2 is BOUND ON CREATE to its OWN new terminal tab, and s1 is NOT
    // rebound — its terminal tab survives, still bound to s1. (The new terminal
    // lands in the focused group; the anti-rebind guarantee is the load-bearing
    // outcome — the old bug silently rebound s1 to s2.)
    await sessionRow(page, s2).click()
    await expect(terminalTab(page, s2), 's2 is bound on create to its own new terminal tab').toHaveCount(1, { timeout: 15_000 })
    await expect(terminalTab(page, s1), 's1 MUST stay bound — clicking s2 must NOT rebind the first terminal').toHaveCount(1)
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

  test('flow 5 (contrast): Open beside binds each session to its own distinct tab', async ({ page, request }) => {
    const { sessions: [s1, s2] } = await openProjectWithSessions(page, request, 2)

    // Open beside via the per-row hover button — it splits to a fresh group and
    // binds the NEW terminal directly (the reported-working path).
    const openBeside = async (name: string) => {
      await sessionRow(page, name).hover()
      await page.getByRole('button', { name: `Open ${name} beside` }).click()
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

    // Open a file → an editor tab in group:1.
    const file = uniqueFileName('mixed.ts')
    await createTestFile(page, project.name, file, 'export const m = 1\n')
    await waitForSSERefresh(page, 3000)
    await openFileViaSearch(page, file)
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
