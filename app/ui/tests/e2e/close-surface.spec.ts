import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import {
  provisionWorkspace,
  createFixtureProject,
  selectProject,
  waitForAppReady,
  openFileViaSearch,
  runTag,
  sidebar,
  activityPanel,
  group,
  getWorkspaceState,
  activeBoundSession,
  type FixtureProject,
} from './helpers/workspace'

// Characterizes the branches of `closeFocusedSurface` (the Cmd+W state machine)
// under the VSCode tab-group model:
//   1. search-open    -> close the quick-open overlay
//   2. editor focus    -> close the active editor tab (the bound session survives)
//   3. terminal focus  -> close the focused terminal tab (the editor tab survives,
//                         the session keeps running — closePane, not a kill)
//   4. tasks-first     -> with Tasks showing, Cmd+W dismisses Tasks BEFORE closing
//                         the editor tab (the editor/tasks branch returns to editor)
//
// The editor and terminal are two tabs in ONE group's strip; only the ACTIVE tab
// renders a body, so activating the editor tab unmounts the terminal's xterm (and
// vice-versa) — that is what makes focus deterministic for the Cmd+W routing.

const README_TAB = 'README.md'

let fixture: FixtureProject | null = null
const openedSessions: string[] = []

async function startShell(request: APIRequestContext, cwd: string): Promise<string> {
  const name = `e2e-close-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell session failed: ${res.status()} ${await res.text()}`).toBeTruthy()
  const body = await res.json() as { name: string }
  openedSessions.push(body.name)
  return body.name
}

/** The session bound to the active terminal — the persisted state the close routing
 *  acts on (derived from `terminalBindings`/`terminalMru`). */
async function persistedActiveSession(page: Page): Promise<string> {
  return activeBoundSession(await getWorkspaceState(page, fixture!.name))
}

const sessionRow = (page: Page, name: string) => activityPanel(page).getByText(name, { exact: true }).first()
const readmeTab = (page: Page) => page.locator(`[data-testid="group-tab"][title="${README_TAB}"]`)
const terminalTab = (page: Page, name: string) =>
  page.locator(`[data-testid="group-tab"][data-tab-kind="terminal"][title="${name}"]`)
const editorBody = (page: Page) => group(page, 'group:1').locator('[data-panel-leaf="editor"]')
const terminalBody = (page: Page) => group(page, 'group:1').locator('[data-panel-leaf="terminal"]')

/** Provision a project + a live session, open README as an editor tab, then bind the
 *  session as a terminal tab in the SAME group (so editor + terminal are two tabs in
 *  one strip; the terminal is the active tab right after binding). */
async function openEditorAndTerminal(
  page: Page, request: APIRequestContext,
): Promise<{ sessionName: string }> {
  fixture = await createFixtureProject(request)
  const sessionName = await startShell(request, fixture.path)

  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, fixture.name)

  await expect(sidebar(page).getByText(README_TAB)).toBeVisible({ timeout: 10_000 })
  await openFileViaSearch(page, README_TAB)
  await expect(readmeTab(page)).toBeVisible({ timeout: 10_000 })

  await expect(sessionRow(page, sessionName)).toBeVisible({ timeout: 15_000 })
  await sessionRow(page, sessionName).click() // clickSession → bound terminal tab in group:1
  await expect(terminalTab(page, sessionName)).toBeVisible({ timeout: 15_000 })
  return { sessionName }
}

/** Dismiss the default-open Tasks dock (showTasks → false) so a subsequent editor
 *  Cmd+W routes to closing the tab rather than the editor/tasks "return" branch. */
async function dismissTasks(page: Page): Promise<void> {
  await page.keyboard.press('Meta+Shift+t')
  await page.waitForTimeout(200)
}

test.describe('closeFocusedSurface routing (Cmd+W across all branches)', () => {
  test.afterEach(async ({ request }) => {
    const failures: string[] = []
    for (const name of openedSessions.splice(0)) {
      const res = await request.post(`/api/sessions/${encodeURIComponent(name)}/close`)
      if (!res.ok()) failures.push(`${name}: ${res.status()} ${await res.text()}`)
    }
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
    if (failures.length) throw new Error(`shell session cleanup failed: ${failures.join('; ')}`)
  })

  test('search-open branch: Cmd+W closes the quick-open search', async ({ page, request }) => {
    fixture = await provisionWorkspace(page, request)
    const searchInput = page.locator('input[placeholder="Search files..."]')

    await page.keyboard.press('Meta+p')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })

    await page.keyboard.press('Meta+w')
    await expect(searchInput).toHaveCount(0)
  })

  test('editor branch: Cmd+W closes the focused editor tab and leaves the session bound', async ({ page, request }) => {
    const { sessionName } = await openEditorAndTerminal(page, request)

    // Activate the README editor tab → the terminal's xterm unmounts (only the active
    // tab renders), so focus stays on the editor. Dismiss Tasks, then Cmd+W closes the
    // editor tab; the bound terminal/session is untouched.
    await readmeTab(page).click()
    await expect(editorBody(page)).toHaveAttribute('data-focused', 'true')
    await dismissTasks(page)
    await page.keyboard.press('Meta+w')

    await expect(readmeTab(page)).toHaveCount(0)
    await expect(terminalTab(page, sessionName), 'the terminal tab survives the editor close').toBeVisible()
    await expect.poll(() => persistedActiveSession(page)).toBe(sessionName)
  })

  test('terminal branch: Cmd+W closes the focused terminal tab and leaves the editor tab open', async ({ page, request }) => {
    const { sessionName } = await openEditorAndTerminal(page, request)

    // The terminal is the active+focused tab right after binding. Cmd+W → closePane:
    // the terminal tab closes, the editor tab is untouched, and the session KEEPS
    // RUNNING (its row stays listed — afterEach closes it by name and throws otherwise).
    await expect(terminalBody(page)).toHaveAttribute('data-focused', 'true', { timeout: 15_000 })
    await page.keyboard.press('Meta+w')

    await expect(terminalTab(page, sessionName)).toHaveCount(0)
    await expect(page.getByText('Select a session to attach terminal')).toHaveCount(0)
    await expect(readmeTab(page), 'the editor tab survives the terminal close').toBeVisible()
    await expect(sessionRow(page, sessionName), 'the session keeps running').toBeVisible()
  })

  test('tasks branch: with Tasks showing, Cmd+W dismisses Tasks before closing the editor tab', async ({ page, request }) => {
    // Tasks is shown by default; provision a clean editor tab with focus on it.
    fixture = await provisionWorkspace(page, request)
    await expect(sidebar(page).getByText(README_TAB)).toBeVisible({ timeout: 10_000 })
    await openFileViaSearch(page, README_TAB)
    await group(page, 'group:1').locator('[data-panel-leaf="editor"] .cm-content').click()

    // First Cmd+W with Tasks showing routes to the editor/tasks branch (dismiss Tasks
    // / return to editor) — the editor tab is NOT closed yet.
    await page.keyboard.press('Meta+w')
    await page.waitForTimeout(300)
    await expect(readmeTab(page), 'the first Cmd+W dismisses Tasks, not the tab').toBeVisible()

    // Second Cmd+W (Tasks no longer showing) closes the editor tab.
    await page.keyboard.press('Meta+w')
    await expect(readmeTab(page)).toHaveCount(0)
  })
})
