import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import {
  provisionWorkspace,
  createFixtureProject,
  createWorktreeFixture,
  selectProject,
  waitForAppReady,
  openFileViaSearch,
  runTag,
  sidebar,
  activityPanel,
  getWorkspaceState,
  type FixtureProject,
} from './helpers/workspace'

// Characterizes every branch of `closeFocusedSurface` (WorkspaceScreen.tsx) — the
// state machine behind Cmd+W — against the CURRENT renderer, so the flexible-layout
// refactor can migrate it field-by-field without regressing close routing:
//   1. search-open      -> close the quick-open overlay
//   2. editor focus     -> close the active editor tab (session stays attached)
//   3. tasks tab focus  -> close the tab AND sync the sidebar Tasks toggle off
//   4. session focus    -> detach the session (editor tab stays open)
//   5. terminal focus   -> detach the session (editor tab stays open)
//
// The session/terminal/editor branches are characterized with BOTH an editor tab
// and an attached session present, then asserting the precise outcome of each
// focus target. This defeats the generic fallback `closeActiveTab() ||
// detachActiveSession()`: if the session branch were broken, the fallback would
// close the tab instead of detaching (and vice-versa), so "tab survived + session
// detached" / "tab closed + session attached" can only hold if the right branch ran.

const TERMINAL_PLACEHOLDER = 'Select a session to attach terminal'
const README_TAB = 'README.md'

let fixture: FixtureProject | null = null
const openedSessions: string[] = []

/** Start a real shell session (live tmux PTY) in the given cwd, under a unique
 *  per-run name so parallel runs never collide on the global `shell-N` namespace.
 *  A real PTY keeps the terminal WS connected, so the session only detaches when
 *  Cmd+W routes through `detachActiveSession` — not from a dropped socket. */
async function startShell(request: APIRequestContext, cwd: string): Promise<string> {
  const name = `e2e-close-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell session failed: ${res.status()} ${await res.text()}`).toBeTruthy()
  const body = await res.json() as { name: string }
  openedSessions.push(body.name)
  return body.name
}

/** The persisted active session — the exact state `detachActiveSession` clears. */
async function persistedActiveSession(page: Page): Promise<string | undefined> {
  return (await getWorkspaceState(page, fixture!.name))?.activeSession as string | undefined
}

/** Provision an isolated project + a live shell session, then open the committed
 *  README as an editor tab. README ships in the fixture commit, so it is in the
 *  file tree at load — no created-file SSE propagation to wait on. */
async function openProjectWithSessionAndTab(
  page: Page,
  request: APIRequestContext,
): Promise<{ sessionName: string; readmeTab: Locator }> {
  fixture = await createFixtureProject(request)
  const sessionName = await startShell(request, fixture.path)

  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, fixture.name)

  // Wait for the tree to render README (locator auto-wait) so quick-open's index
  // is populated, then open it as an editor tab.
  await expect(sidebar(page).getByText(README_TAB)).toBeVisible({ timeout: 10_000 })
  await openFileViaSearch(page, README_TAB)
  const readmeTab = page.locator('.overflow-x-auto').locator(`[title="${README_TAB}"]`)
  await expect(readmeTab).toBeVisible({ timeout: 10_000 })

  // The session surfaced in the Sessions list; nothing attached yet.
  await expect(activityPanel(page).getByText(sessionName)).toBeVisible({ timeout: 15_000 })
  return { sessionName, readmeTab }
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
    // Surface leaked tmux sessions loudly rather than silently swallowing them.
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

  test('editor branch: Cmd+W closes the focused tab and leaves the session attached', async ({ page, request }) => {
    const { sessionName, readmeTab } = await openProjectWithSessionAndTab(page, request)
    const placeholder = activityPanel(page).getByText(TERMINAL_PLACEHOLDER)

    // Attach the session, then move focus back to the editor (Cmd+Ctrl+Right
    // re-selects the only tab and sets focusTarget='editor').
    await page.keyboard.press('Control+Meta+Digit1')
    await expect(placeholder).toHaveCount(0)
    await page.keyboard.press('Control+Meta+ArrowRight')

    await page.keyboard.press('Meta+w')

    // Editor branch closed the TAB — it did NOT detach the session.
    await expect(readmeTab).toHaveCount(0)
    await expect(placeholder).toHaveCount(0)
    await expect.poll(() => persistedActiveSession(page)).toBe(sessionName)
  })

  test('tasks branch: Cmd+W closes the open Tasks workspace (returns to the editor)', async ({ page, request }) => {
    // The legacy half of this branch — a sidebar Tasks section + `state.layout.showTasks`
    // — was deleted with the legacy renderer (T8): the tree makes Tasks a main-tabs
    // panel with no sidebar section. The behavioral half (Cmd+W while Tasks shows
    // closes it) lives in workspace-tasks-tab.spec.ts ("Cmd+W closes the open Tasks
    // workspace"); this case characterizes that branch alongside the other Cmd+W
    // routes here, under the tree renderer.
    // A task-bearing fixture: the Tasks workspace only renders its toolbar/search
    // once the graph has nodes (an empty graph shows a bare status pane).
    fixture = await createWorktreeFixture(request)
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    const tasksSearch = page.locator('input[placeholder="Search tasks..."]')

    // Cmd+Shift+T opens the Tasks panel (focusTarget -> 'editor').
    await page.keyboard.press('Meta+Shift+t')
    await expect(tasksSearch).toBeVisible({ timeout: 15_000 })

    await page.keyboard.press('Meta+w')

    // The tasks branch closed the surface — back to the editor.
    await expect(tasksSearch).toHaveCount(0)
    await expect(page.locator('[data-layer="nodes"]')).toHaveCount(0)
  })

  test('session-focus branch: Cmd+W detaches the session and leaves the editor tab open', async ({ page, request }) => {
    const { sessionName, readmeTab } = await openProjectWithSessionAndTab(page, request)
    const placeholder = activityPanel(page).getByText(TERMINAL_PLACEHOLDER)

    // Cmd+Ctrl+1 attaches + sets focusTarget='session'.
    await page.keyboard.press('Control+Meta+Digit1')
    await expect(placeholder).toHaveCount(0)
    await expect.poll(() => persistedActiveSession(page)).toBe(sessionName)

    await page.keyboard.press('Meta+w')

    // Session branch detached the session — the editor tab is UNTOUCHED. (If this
    // branch were broken, the fallback would close the tab instead.)
    await expect(placeholder).toBeVisible()
    await expect.poll(() => persistedActiveSession(page)).toBe('')
    await expect(readmeTab).toBeVisible()
  })

  test('terminal-focus branch: Cmd+W detaches the session and leaves the editor tab open', async ({ page, request }) => {
    const { sessionName, readmeTab } = await openProjectWithSessionAndTab(page, request)
    const placeholder = activityPanel(page).getByText(TERMINAL_PLACEHOLDER)

    // Cmd+Ctrl+ArrowDown attaches + sets focusTarget='terminal'.
    await page.keyboard.press('Control+Meta+ArrowDown')
    await expect(placeholder).toHaveCount(0)
    await expect.poll(() => persistedActiveSession(page)).toBe(sessionName)

    await page.keyboard.press('Meta+w')

    // Terminal branch detached the session — the editor tab is UNTOUCHED.
    await expect(placeholder).toBeVisible()
    await expect.poll(() => persistedActiveSession(page)).toBe('')
    await expect(readmeTab).toBeVisible()
  })
})
