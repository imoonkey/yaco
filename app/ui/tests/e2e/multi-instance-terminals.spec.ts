import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  activityPanel,
  createTestFile,
  deleteTestFile,
  openFileViaSearch,
  waitForSSERefresh,
  uniqueFileName,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// Multi-instance terminal flows against the real renderer (design: §3.5 clickSession
// / openBeside, §C session reconcile, §3.7 close). Pins:
//   - "Open beside" twice → two terminal panes, one bound session each, 1-per-session
//     (re-opening a shown session focuses it, never spawns a duplicate PTY);
//   - those bindings survive a reload (terminal round-trip);
//   - ending a session in its shell (`exit`) auto-closes its terminal pane and the
//     session moves to History (the live PTY disconnect tears the pane down).

test.use({ viewport: { width: 1280, height: 800 } })

let fixture: FixtureProject | null = null
const openedSessions: string[] = []

test.afterEach(async ({ request }) => {
  // Lenient: a session ended by the test (exit) is already gone — don't throw.
  for (const name of openedSessions.splice(0)) {
    await request.post(`/api/sessions/${encodeURIComponent(name)}/close`).catch(() => undefined)
  }
  if (fixture) {
    await fixture.dispose()
    fixture = null
  }
})

async function startShell(request: APIRequestContext, cwd: string): Promise<string> {
  const name = `mi-term-${runTag()}`
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

// A bound terminal pane shows the session name in its header (the live-header
// selector the terminal-lifecycle spec uses).
const terminalHeader = (page: Page, name: string) =>
  page.locator('span.truncate.flex-1.font-semibold', { hasText: name })
const openBesideBtn = (page: Page, name: string) =>
  page.getByRole('button', { name: `Open ${name} beside` })
const homePane = (page: Page) => page.locator('[data-instance-id="editor"]')
const secondaryPane = (page: Page) => page.locator('[data-instance-id="editor:2"]')
const terminalPane = (page: Page) => page.locator('[data-instance-id="terminal"]')

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
  for (const s of sessions) {
    await expect(page.getByText(s, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  }
  return { project, sessions }
}

test.describe('Multi-instance terminals (open-beside / 1-per-session / session exit)', () => {
  test('two "Open beside" terminals bind one session each and survive reload (1-per-session)', async ({ page, request }) => {
    const { project, sessions: [s1, s2] } = await openProjectWithSessions(page, request, 2)

    // Open beside each session → a terminal pane bound to that session.
    await openBesideBtn(page, s1).click()
    await expect(terminalHeader(page, s1)).toHaveCount(1, { timeout: 15_000 })
    await openBesideBtn(page, s2).click()
    await expect(terminalHeader(page, s2)).toHaveCount(1, { timeout: 15_000 })
    // Two distinct bound terminals coexist.
    await expect(terminalHeader(page, s1)).toHaveCount(1)

    // 1-per-session guard: opening a session already shown FOCUSES its existing
    // terminal — it must not spawn a second pane AND must move focus onto the s1
    // pane (a no-op duplicate-open would leave count==1 too, so assert the focus moved).
    await openBesideBtn(page, s1).click()
    const focusedTerminal = page.locator('[data-panel-leaf="terminal"][data-focused="true"]')
    await expect(focusedTerminal).toHaveCount(1, { timeout: 10_000 })
    await expect(focusedTerminal.locator('span.truncate.flex-1.font-semibold', { hasText: s1 })).toBeVisible()
    await expect(terminalHeader(page, s1)).toHaveCount(1)
    await expect(terminalHeader(page, s2)).toHaveCount(1)

    // The two bindings persist (terminal round-trip).
    await page.reload()
    await waitForAppReady(page)
    await selectProject(page, project.name)
    await expect(terminalHeader(page, s1)).toHaveCount(1, { timeout: 15_000 })
    await expect(terminalHeader(page, s2)).toHaveCount(1, { timeout: 15_000 })
  })

  test('ending a session in its shell auto-closes its terminal pane (→ History)', async ({ page, request }) => {
    const { sessions: [s] } = await openProjectWithSessions(page, request, 1)

    // Attach the session into the structural terminal (clickSession binds + focuses).
    await page.getByText(s, { exact: true }).first().click()
    const xterm = activityPanel(page).locator('.yaco-terminal-xterm')
    await expect(xterm).toBeVisible({ timeout: 15_000 })
    await expect(terminalHeader(page, s)).toBeVisible()

    // Prove the PTY is interactive before sending `exit` — under load the socket may
    // connect after the node renders, and a keystroke sent too early is dropped (then
    // the session never ends and the pane never closes). A round-tripped marker gates it.
    await xterm.click()
    await page.keyboard.type('echo TERMREADY')
    await page.keyboard.press('Enter')
    await expect(xterm.locator('.xterm-rows')).toContainText('TERMREADY', { timeout: 15_000 })

    // End the session from inside its shell. The PTY closes, the terminal socket
    // disconnects, and the pane tears itself down (closePane on disconnect).
    await xterm.click()
    await page.keyboard.type('exit')
    await page.keyboard.press('Enter')

    // The terminal pane is REMOVED via closePane (PTY disconnect), not merely
    // unbound: its wrapper is gone from the tree AND no idle placeholder takes its
    // place — proving the pane was torn down, not left as an empty terminal.
    await expect(terminalHeader(page, s)).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('[data-panel-leaf="terminal"]')).toHaveCount(0)
    await expect(page.getByText('Select a session to attach terminal')).toHaveCount(0)
    await expect(activityPanel(page).locator('.yaco-terminal-xterm')).toHaveCount(0)
  })

  test('focus marker is bright on the focused pane; the dim active marker needs >1 instance', async ({ page, request }) => {
    const { project, sessions: [s] } = await openProjectWithSessions(page, request, 1)
    const file = uniqueFileName('focus.ts')
    await createTestFile(page, project.name, file, 'export const f = 1\n')
    await waitForSSERefresh(page, 3000)

    // Open a file so the home editor renders (and is focusable).
    await openFileViaSearch(page, file)
    await expect(homePane(page)).toBeVisible({ timeout: 10_000 })

    // Attach the session into the structural terminal and focus it (clickSession).
    // One editor + one terminal → the focused pane is bright; neither type shows the
    // dim active marker (it is suppressed while a type has a single instance).
    await page.getByText(s, { exact: true }).first().click()
    await expect(terminalPane(page)).toHaveAttribute('data-focused', 'true', { timeout: 10_000 })
    await expect(homePane(page)).not.toHaveAttribute('data-active', 'true') // 1 editor → suppressed

    // Focus the home editor: it goes bright, the lone terminal stays dim-free.
    await homePane(page).locator('.cm-content').click()
    await expect(homePane(page)).toHaveAttribute('data-focused', 'true')
    await expect(terminalPane(page)).not.toHaveAttribute('data-active', 'true') // 1 terminal → suppressed

    // Split the editor → a second editor instance, focused (bright). Use the tab-bar
    // Split button (acts on its own instance id) so the new pane is deterministic.
    await homePane(page).getByRole('button', { name: 'Split editor', exact: true }).click()
    await expect(secondaryPane(page)).toHaveAttribute('data-focused', 'true', { timeout: 10_000 })

    // Move focus back to the terminal by clicking its (bound) body — unambiguous,
    // unlike the session row whose name now also appears in the terminal header.
    // Now the active editor (the secondary, MRU head) carries the DIM active marker —
    // two editors unmask it — while it is no longer the bright-focused pane.
    await terminalPane(page).locator('.yaco-terminal-xterm').click()
    await expect(terminalPane(page)).toHaveAttribute('data-focused', 'true')
    await expect(secondaryPane(page)).toHaveAttribute('data-active', 'true')
    await expect(secondaryPane(page)).not.toHaveAttribute('data-focused', 'true')

    await deleteTestFile(page, project.name, file)
  })
})
