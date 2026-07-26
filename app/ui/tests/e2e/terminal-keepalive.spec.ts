import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  activityPanel,
  groupTab,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// Terminal keep-alive across a tab switch (design: plan/all/terminal-switch-latency).
//
// Switching terminal tabs used to unmount the pane: xterm disposed, WebSocket closed,
// the server killed the PTY and tmux detached — so switching BACK paid a fresh wss
// handshake plus a tmux attach (~1s on a remote browser). The previously active
// terminal now stays mounted and hidden, which the specs below pin through what a user
// can observe:
//   - the switch opens NO new WebSocket (the property that removes the latency);
//   - the hidden pane keeps its scrollback, so switching back shows the old output
//     immediately rather than a blank pane that repaints;
//   - focus follows the switch, so the next keystroke reaches the pane you switched to;
//   - exactly one pane per group stays the resolvable leaf (markers/geometry/DnD).
//
// Every gesture is the real affordance: the session ROW binds a session to a tab, the
// group TAB switches between them.

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
  const name = `ka-term-${runTag()}`
  const res = await request.post('/api/sessions/start', { data: { provider: 'shell', cwd, name } })
  expect(res.ok(), `start shell: ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as { name: string }
  openedSessions.push(body.name)
  return body.name
}

const sessionRow = (page: Page, name: string) =>
  activityPanel(page).getByText(name, { exact: true }).first()
/** Every mounted xterm, hidden panes included. */
const allXterms = (page: Page) => page.locator('.yaco-terminal-xterm')
const activeXterm = (page: Page) => page.locator('[data-panel-leaf="terminal"] .yaco-terminal-xterm')

/** Type a marker into the focused terminal and wait for the PTY to echo it back.
 *  Retried as a whole: keystrokes sent before a freshly attached socket is open are
 *  dropped on the floor, and nothing observable says "the PTY is listening now". */
async function runMarker(page: Page, marker: string): Promise<void> {
  await expect(async () => {
    await page.keyboard.press('Enter')
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect(activeXterm(page).locator('.xterm-rows')).toContainText(marker, { timeout: 4_000 })
  }).toPass({ timeout: 30_000 })
}

test.describe('Terminal keep-alive across a tab switch', () => {
  test('switching tabs keeps the old terminal live: no new socket, content and focus intact', async ({ page, request }) => {
    fixture = await createFixtureProject(request)
    const s1 = await startShell(request, fixture.path)
    const s2 = await startShell(request, fixture.path)

    // Count every terminal WebSocket the page opens. A re-attach on switch would
    // show up here as an extra socket for a session already attached — this is the
    // property the keep-alive exists to guarantee.
    const socketUrls: string[] = []
    page.on('websocket', (ws) => { if (ws.url().includes('/ws/terminal/')) socketUrls.push(ws.url()) })
    const socketsFor = (name: string) => socketUrls.filter((u) => u.includes(encodeURIComponent(name)))

    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)
    await expect(sessionRow(page, s1)).toBeVisible({ timeout: 15_000 })
    await expect(sessionRow(page, s2)).toBeVisible({ timeout: 15_000 })

    // Two sessions clicked in turn → two terminal tabs in the SAME group.
    await sessionRow(page, s1).click()
    await expect(activeXterm(page)).toBeVisible({ timeout: 15_000 })
    await activeXterm(page).click()
    await runMarker(page, 'KEEPALIVE1')

    await sessionRow(page, s2).click()
    await expect(groupTab(page, s2)).toHaveCount(1, { timeout: 15_000 })
    await expect(activeXterm(page)).toBeVisible({ timeout: 15_000 })
    await activeXterm(page).click()
    await runMarker(page, 'KEEPALIVE2')

    // s1's pane is MOUNTED but hidden: both xterms are in the DOM, only one is shown,
    // and only the active one is a resolvable leaf.
    await expect(allXterms(page)).toHaveCount(2)
    await expect(page.locator('[data-panel-leaf="terminal"]')).toHaveCount(1)
    expect(socketsFor(s1), 's1 attached exactly once').toHaveLength(1)
    expect(socketsFor(s2), 's2 attached exactly once').toHaveLength(1)

    // Switch BACK via the real group tab.
    await groupTab(page, s1).click()
    await expect(groupTab(page, s1)).toHaveAttribute('data-tab-active', 'true', { timeout: 10_000 })

    // The old output is there immediately — the pane was never torn down.
    await expect(activeXterm(page).locator('.xterm-rows')).toContainText('KEEPALIVE1')
    // ...and no second socket was opened for either session.
    expect(socketsFor(s1), 'switching back must not re-attach s1').toHaveLength(1)
    expect(socketsFor(s2), 'switching away must not re-attach s2').toHaveLength(1)

    // Focus followed the switch: the next keystroke goes to s1's PTY, not s2's.
    await runMarker(page, 'KEEPALIVE3')
    await expect(activeXterm(page).locator('.xterm-rows')).toContainText('KEEPALIVE1')
    await expect(activeXterm(page).locator('.xterm-rows')).not.toContainText('KEEPALIVE2')
  })

  test('a hidden terminal takes no keystrokes when the new tab claims no focus', async ({ page, request }) => {
    fixture = await createFixtureProject(request)
    const s1 = await startShell(request, fixture.path)

    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)
    await expect(sessionRow(page, s1)).toBeVisible({ timeout: 15_000 })

    await sessionRow(page, s1).click()
    await expect(activeXterm(page)).toBeVisible({ timeout: 15_000 })
    await activeXterm(page).click()
    await runMarker(page, 'BEFOREHIDE')

    // Cmd+Shift+T opens the Tasks tab over this group — from the KEYBOARD, so no
    // pointer click moves focus, and the tasks body claims none either. Chromium
    // keeps a focused descendant focused (and still delivers keydown to it) when an
    // ancestor merely turns invisible, so the hidden terminal would go on taking the
    // user's keystrokes and forwarding them to a live PTY.
    await page.keyboard.press('Meta+Shift+T')
    await expect(page.locator('[data-panel-leaf="terminal"]'), 'terminal is now the hidden pane')
      .toHaveCount(0, { timeout: 10_000 })

    const hiddenRows = page.locator('.yaco-terminal-xterm .xterm-rows')
    await expect(hiddenRows, 'the pane is still mounted with its scrollback').toContainText('BEFOREHIDE')

    await page.keyboard.type('echo LEAKCHECK')
    await page.keyboard.press('Enter')
    // Give a leaked keystroke time to round-trip through the PTY before asserting.
    await page.waitForTimeout(2_000)
    await expect(hiddenRows, 'keystrokes must not reach a hidden terminal').not.toContainText('LEAKCHECK')
  })
})
