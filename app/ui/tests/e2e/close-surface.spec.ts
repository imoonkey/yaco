import { test, expect, type APIRequestContext } from '@playwright/test'
import {
  provisionWorkspace,
  createFixtureProject,
  createWorktreeFixture,
  selectProject,
  waitForAppReady,
  createTestFile,
  openFileViaSearch,
  waitForSSERefresh,
  uniqueFileName,
  runTag,
  activityPanel,
  sectionHeader,
  getWorkspaceState,
  type FixtureProject,
} from './helpers/workspace'

// Characterizes every branch of `closeFocusedSurface` (WorkspaceScreen.tsx) — the
// state machine behind Cmd+W — against the CURRENT renderer, so the flexible-layout
// refactor can migrate it field-by-field without regressing close routing:
//   1. search-open      -> close the quick-open overlay
//   2. editor focus     -> close the active editor tab
//   3. tasks tab focus  -> close the tab AND sync the sidebar Tasks toggle off
//   4. session focus    -> detach the active session
//   5. terminal focus   -> detach the active session
// Each test asserts the surface was actually open/attached first, then that Cmd+W
// changed exactly that surface — no branch passes vacuously.

const TERMINAL_PLACEHOLDER = 'Select a session to attach terminal'

/** Start a real shell session (live tmux PTY) in the given cwd, under a unique
 *  per-run name so parallel runs never collide on the global `shell-N` namespace.
 *  A real PTY keeps the terminal WS connected, so the session only detaches when
 *  Cmd+W routes through `detachActiveSession` — not from a dropped socket. */
async function startShell(request: APIRequestContext, cwd: string): Promise<string> {
  const name = `e2e-close-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell session failed: ${res.status()} ${await res.text()}`).toBeTruthy()
  const body = await res.json() as { name: string }
  return body.name
}

async function closeShell(request: APIRequestContext, name: string): Promise<void> {
  await request.post(`/api/sessions/${encodeURIComponent(name)}/close`).catch(() => undefined)
}

test.describe('closeFocusedSurface routing (Cmd+W across all branches)', () => {
  let fixture: FixtureProject | null = null
  const openedSessions: string[] = []

  test.afterEach(async ({ request }) => {
    for (const name of openedSessions.splice(0)) await closeShell(request, name)
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
  })

  test('search-open branch: Cmd+W closes the quick-open search', async ({ page, request }) => {
    fixture = await provisionWorkspace(page, request)
    const searchInput = page.locator('input[placeholder="Search files..."]')

    await page.keyboard.press('Meta+p')
    await expect(searchInput).toBeVisible({ timeout: 10_000 })

    await page.keyboard.press('Meta+w')
    await expect(searchInput).toHaveCount(0)
  })

  test('editor branch: Cmd+W closes the focused editor tab', async ({ page, request }) => {
    fixture = await provisionWorkspace(page, request)
    const file = uniqueFileName('close_editor.txt')
    await createTestFile(page, fixture.name, file, 'editor branch fixture\n')
    await waitForSSERefresh(page, 3000)

    await openFileViaSearch(page, file)
    const tab = page.locator('.overflow-x-auto').locator(`[title="${file}"]`)
    await expect(tab).toBeVisible({ timeout: 10_000 })

    // Focus the editor (focusTarget -> 'editor'), then close via Cmd+W.
    await page.locator('.cm-content').click()
    await page.keyboard.press('Meta+w')

    await expect(tab).toHaveCount(0)
  })

  test('tasks branch: Cmd+W closes the Tasks tab and syncs the sidebar toggle off', async ({ page, request }) => {
    // A task-bearing fixture: the Tasks workspace only renders its toolbar/search
    // once the graph has nodes (an empty graph shows a bare status pane).
    fixture = await createWorktreeFixture(request)
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    const tasksSearch = page.locator('input[placeholder="Search tasks..."]')
    const tasksSection = sectionHeader(page, 'Tasks')

    // Sidebar Tasks section starts expanded (showTasks default true).
    await expect(tasksSection).toHaveAttribute('aria-expanded', 'true')

    // Cmd+Shift+T opens the Tasks tab (focusTarget -> 'editor').
    await page.keyboard.press('Meta+Shift+t')
    await expect(tasksSearch).toBeVisible({ timeout: 15_000 })

    await page.keyboard.press('Meta+w')

    // Tab closed AND the sidebar Tasks toggle synced off (the "close+sync" branch).
    await expect(tasksSearch).toHaveCount(0)
    await expect(tasksSection).toHaveAttribute('aria-expanded', 'false')
    await expect
      .poll(async () => (await getWorkspaceState(page, fixture!.name))?.layout?.showTasks)
      .toBe(false)
  })

  test('session-focus branch: Cmd+W detaches the active session', async ({ page, request }) => {
    fixture = await createFixtureProject(request)
    const sessionName = await startShell(request, fixture.path)
    openedSessions.push(sessionName)

    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    const panel = activityPanel(page)
    const placeholder = panel.getByText(TERMINAL_PLACEHOLDER)
    // Session surfaced in the Sessions list; nothing attached yet.
    await expect(panel.getByText(sessionName)).toBeVisible({ timeout: 15_000 })
    await expect(placeholder).toBeVisible()

    // Cmd+Ctrl+1 attaches + sets focusTarget='session'.
    await page.keyboard.press('Control+Meta+Digit1')
    await expect(placeholder).toHaveCount(0)
    await expect
      .poll(async () => (await getWorkspaceState(page, fixture!.name))?.activeSession)
      .toBe(sessionName)

    // Cmd+W routes through the session branch -> detach.
    await page.keyboard.press('Meta+w')
    await expect(placeholder).toBeVisible()
    await expect
      .poll(async () => (await getWorkspaceState(page, fixture!.name))?.activeSession)
      .toBe('')
  })

  test('terminal-focus branch: Cmd+W detaches the active session', async ({ page, request }) => {
    fixture = await createFixtureProject(request)
    const sessionName = await startShell(request, fixture.path)
    openedSessions.push(sessionName)

    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    const panel = activityPanel(page)
    const placeholder = panel.getByText(TERMINAL_PLACEHOLDER)
    await expect(panel.getByText(sessionName)).toBeVisible({ timeout: 15_000 })
    await expect(placeholder).toBeVisible()

    // Cmd+Ctrl+ArrowDown attaches + sets focusTarget='terminal'.
    await page.keyboard.press('Control+Meta+ArrowDown')
    await expect(placeholder).toHaveCount(0)
    await expect
      .poll(async () => (await getWorkspaceState(page, fixture!.name))?.activeSession)
      .toBe(sessionName)

    // Cmd+W routes through the terminal branch -> detach.
    await page.keyboard.press('Meta+w')
    await expect(placeholder).toBeVisible()
    await expect
      .poll(async () => (await getWorkspaceState(page, fixture!.name))?.activeSession)
      .toBe('')
  })
})
