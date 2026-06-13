import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  activityPanel,
  createTestFile,
  deleteTestFile,
  openFileViaSearch,
  openPinnedFile,
  waitForSSERefresh,
  uniqueFileName,
  group,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// Multi-instance terminal flows under the VSCode tab-group model (design:
// vt-sessions clickSession / openBeside, vt-bodies, session reconcile, close).
// Terminals are TABS in the working groups now (not standalone leaves in the
// activity panel). Pins:
//   - "Open beside" twice → two terminal tabs, one bound session each, 1-per-session
//     (re-opening a shown session FOCUSES it, never spawns a duplicate PTY);
//   - those bindings survive a reload (terminal round-trip);
//   - ending a session in its shell (`exit`) auto-closes its terminal tab (the live
//     PTY disconnect tears the tab down, no idle placeholder left);
//   - the bright focus marker tracks the focused pane and the dim active marker
//     appears only when a type has >1 instance.

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

// The Sessions-list ROW (in the activity panel) drives the REAL provider; scoped to
// the activity panel so it never resolves to a terminal TAB title in a group.
const sessionRow = (page: Page, name: string) =>
  activityPanel(page).getByText(name, { exact: true }).first()
const openBesideBtn = (page: Page, name: string) =>
  page.getByRole('button', { name: `Open ${name} beside` })
// A bound terminal TAB shows its session name as its label/title.
const terminalTab = (page: Page, name: string) =>
  page.locator(`[data-testid="group-tab"][data-tab-kind="terminal"][title="${name}"]`)
const allTerminalTabs = (page: Page) =>
  page.locator('[data-testid="group-tab"][data-tab-kind="terminal"]')
const xterm = (page: Page) => page.locator('.yaco-terminal-xterm')
// The ACTIVE editor/terminal body of a group (only the active tab has a wrapper).
const editorBody = (page: Page, groupId: string) => group(page, groupId).locator('[data-panel-leaf="editor"]')

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

test.describe('Multi-instance terminals (open-beside / 1-per-session / session exit / markers)', () => {
  test('two "Open beside" terminals bind one session each and survive reload (1-per-session)', async ({ page, request }) => {
    const { project, sessions: [s1, s2] } = await openProjectWithSessions(page, request, 2)

    // Open beside each session → a terminal TAB bound to that session in its own group.
    await sessionRow(page, s1).hover()
    await openBesideBtn(page, s1).click()
    await expect(terminalTab(page, s1)).toHaveCount(1, { timeout: 15_000 })
    await sessionRow(page, s2).hover()
    await openBesideBtn(page, s2).click()
    await expect(terminalTab(page, s2)).toHaveCount(1, { timeout: 15_000 })
    // Two distinct bound terminal tabs coexist.
    await expect(allTerminalTabs(page)).toHaveCount(2)

    // 1-per-session guard: opening a session already shown FOCUSES its existing
    // terminal tab — it must not spawn a second tab AND must move focus onto it.
    await sessionRow(page, s1).hover()
    await openBesideBtn(page, s1).click()
    await expect(terminalTab(page, s1), 're-opening a shown session does not duplicate it').toHaveCount(1)
    await expect(allTerminalTabs(page)).toHaveCount(2)
    const focusedTerminal = page.locator('[data-panel-leaf="terminal"][data-focused="true"]')
    await expect(focusedTerminal, 're-opening focuses the existing s1 terminal').toHaveCount(1, { timeout: 10_000 })

    // The two bindings persist (terminal round-trip).
    await page.reload()
    await waitForAppReady(page)
    await selectProject(page, project.name)
    await expect(terminalTab(page, s1)).toHaveCount(1, { timeout: 15_000 })
    await expect(terminalTab(page, s2)).toHaveCount(1, { timeout: 15_000 })
  })

  test('ending a session in its shell auto-closes its terminal tab (→ History)', async ({ page, request }) => {
    const { sessions: [s] } = await openProjectWithSessions(page, request, 1)

    // Attach the session via the REAL session-row click → a bound terminal tab + xterm.
    await sessionRow(page, s).click()
    await expect(terminalTab(page, s)).toHaveCount(1, { timeout: 15_000 })
    await expect(xterm(page)).toBeVisible({ timeout: 15_000 })

    // Prove the PTY is interactive before sending `exit` (a keystroke sent before the
    // socket opens is dropped, and then the session never ends). A round-tripped
    // marker gates it.
    await xterm(page).click()
    await page.keyboard.type('echo TERMREADY')
    await page.keyboard.press('Enter')
    await expect(xterm(page).locator('.xterm-rows')).toContainText('TERMREADY', { timeout: 15_000 })

    // End the session from inside its shell → the PTY closes, the socket disconnects,
    // and the tab tears itself down (closePane on disconnect).
    await xterm(page).click()
    await page.keyboard.type('exit')
    await page.keyboard.press('Enter')

    // The terminal TAB is removed (not merely unbound): gone from the strip AND no
    // idle placeholder takes its place — proving the tab was torn down.
    await expect(terminalTab(page, s)).toHaveCount(0, { timeout: 30_000 })
    await expect(allTerminalTabs(page)).toHaveCount(0)
    await expect(page.getByText('Select a session to attach terminal')).toHaveCount(0)
    await expect(xterm(page)).toHaveCount(0)
  })

  test('focus marker is bright on the focused pane; the dim active marker needs >1 instance', async ({ page, request }) => {
    const { sessions: [s] } = await openProjectWithSessions(page, request, 1)
    const project = fixture!
    const file = uniqueFileName('focus.ts')
    await createTestFile(page, project.name, file, 'export const f = 1\n')
    await waitForSSERefresh(page, 3000)

    // One editor in group:1. A single editor instance → the focused pane is bright
    // (data-focused) but the dim active marker is suppressed.
    await openPinnedFile(page, file)
    await editorBody(page, 'group:1').locator('.cm-content').click()
    await expect(editorBody(page, 'group:1')).toHaveAttribute('data-focused', 'true', { timeout: 10_000 })
    await expect(editorBody(page, 'group:1')).not.toHaveAttribute('data-active', 'true') // 1 editor → suppressed

    // Open the session beside → a bound terminal tab in its OWN group (group:2). Now
    // one editor + one terminal, each visible in its group. Each type is single, so
    // focusing either lights it bright with no dim sibling.
    await sessionRow(page, s).hover()
    await openBesideBtn(page, s).click()
    const termBody = group(page, 'group:2').locator('[data-panel-leaf="terminal"]')
    await expect(termBody).toBeVisible({ timeout: 15_000 })
    await termBody.locator('.yaco-terminal-xterm').click()
    await expect(termBody).toHaveAttribute('data-focused', 'true', { timeout: 10_000 })
    await expect(editorBody(page, 'group:1')).not.toHaveAttribute('data-active', 'true') // 1 editor → suppressed

    // Add a SECOND editor: focus the group:1 editor, Cmd+\ splits it into group:3
    // SEEDED with a duplicate of the file (FIX 2); re-selecting it via quick-open
    // makes it the focused MRU head (editor:2).
    await editorBody(page, 'group:1').locator('.cm-content').click()
    await page.keyboard.press('Meta+\\')
    await expect(group(page, 'group:3')).toBeVisible({ timeout: 10_000 })
    await openFileViaSearch(page, file)
    await expect(editorBody(page, 'group:3')).toHaveAttribute('data-focused', 'true', { timeout: 10_000 })

    // Focus the TERMINAL → it goes bright; the active-but-unfocused editor (editor:2,
    // the MRU head) now carries the DIM active marker — two editors unmask it — while
    // it is no longer the focused pane.
    await termBody.locator('.yaco-terminal-xterm').click()
    await expect(termBody).toHaveAttribute('data-focused', 'true')
    await expect(editorBody(page, 'group:3')).toHaveAttribute('data-active', 'true')
    await expect(editorBody(page, 'group:3')).not.toHaveAttribute('data-focused', 'true')

    await deleteTestFile(page, project.name, file)
  })
})
