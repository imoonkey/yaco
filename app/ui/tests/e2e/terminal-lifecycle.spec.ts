import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  activityPanel,
  sectionHeader,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// --- T0h: terminal no-remount / PTY scrollback characterization ---
//
// The single biggest unguarded risk in the flexible-layout refactor: a benign,
// unrelated workspace re-render gives the terminal panel/context a new identity,
// React remounts <Terminal>, xterm is disposed + recreated, the PTY WebSocket
// reconnects, and on-screen content is lost. A DOM snapshot can't see this — a
// fresh xterm renders identically. So we pin BEHAVIOR, with three independent
// signals each of which FAILS on a remount:
//
//   1. Identity: a live handle to the original xterm node must stay
//      `isConnected`, AND the CURRENT `.yaco-terminal-xterm` must still carry the
//      stamp we set (a remount builds a new, un-stamped node — and a detached old
//      node keeps its attributes, so the stamp is checked on the live node, the
//      identity on the captured one).
//   2. Socket: a Proxy over WebSocket counts opens AND closes to
//      `/ws/terminal/<session>`. No remount ⇒ exactly one open, zero closes for
//      the terminal's whole lifetime. A remount closes the old socket and opens a
//      new one; a silent teardown closes without reopening — both are caught.
//   3. Liveness: after every re-render a NEW command is typed and must round-trip
//      through the SAME PTY and appear after the prior output (stream continuity),
//      proving the terminal is still wired to the live session — not a redrawn or
//      detached husk.

interface TermSockets {
  opens: number
  closes: number
  last: WebSocket | null
}
interface TermWindow extends Window {
  __termWs?: TermSockets
}

/** Wrap WebSocket before any app code runs. Each `/ws/terminal/<session>` open
 *  bumps `opens` and records the socket; its close bumps `closes`. The app nulls
 *  its own `onclose` during teardown but never removes this addEventListener
 *  listener, so a teardown-close is still observed. */
async function instrumentTerminalSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as TermWindow
    w.__termWs = { opens: 0, closes: 0, last: null }
    const Native = window.WebSocket
    window.WebSocket = new Proxy(Native, {
      construct(target, argArray) {
        const sock = Reflect.construct(target, argArray) as WebSocket
        if (String(argArray[0] ?? '').includes('/ws/terminal/')) {
          const stats = w.__termWs!
          stats.opens += 1
          stats.last = sock
          sock.addEventListener('close', () => { stats.closes += 1 })
        }
        return sock
      },
    })
  })
}

function termWsStats(page: Page): Promise<{ opens: number; closes: number }> {
  return page.evaluate(() => {
    const s = (window as TermWindow).__termWs
    return { opens: s?.opens ?? 0, closes: s?.closes ?? 0 }
  })
}

/** readyState of the most recent terminal socket (1 = OPEN), or -1 if none. A
 *  PTY-path readiness signal — no fixed sleep. */
function termWsReadyState(page: Page): Promise<number> {
  return page.evaluate(() => (window as TermWindow).__termWs?.last?.readyState ?? -1)
}

/** Start a tmux-backed shell session in the fixture project. Shell sessions need
 *  no agent binary, so they give us a real PTY in CI. Named per-run because the
 *  tmux namespace is global (not YACO_HOME-isolated) and parallel worktree runs
 *  share one tmux server. */
async function startShellSession(request: APIRequestContext, project: FixtureProject): Promise<string> {
  const name = `shell-${runTag()}`
  const res = await request.post('/api/sessions/start', {
    data: { provider: 'shell', cwd: project.path, name },
  })
  expect(res.ok(), `start shell session: ${res.status()}`).toBeTruthy()
  const body = (await res.json()) as { name: string }
  expect(body.name).toBe(name)
  return body.name
}

async function closeShellSession(request: APIRequestContext, name: string): Promise<void> {
  await request.post(`/api/sessions/${encodeURIComponent(name)}/close`).catch(() => undefined)
}

const xtermLocator = (page: Page) => page.locator('.yaco-terminal-xterm')
const xtermRows = (page: Page) => page.locator('.yaco-terminal-xterm .xterm-rows')
// A bound terminal's identity shows in its GROUP TAB now (desktop has no per-pane
// header). The tab lives in the working group, not the activity panel.
const terminalHeader = (page: Page, name: string) =>
  page.locator(`[data-testid="group-tab"][data-tab-kind="terminal"][title="${name}"]`)

test.describe('Terminal lifecycle: no remount on unrelated re-render', () => {
  let fixture: FixtureProject
  let sessionName: string

  test.beforeEach(async ({ request }) => {
    fixture = await createFixtureProject(request)
    sessionName = await startShellSession(request, fixture)
  })

  test.afterEach(async ({ request }) => {
    if (sessionName) await closeShellSession(request, sessionName)
    await fixture?.dispose()
  })

  test('attach a session, re-render the workspace, terminal keeps its live PTY', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(err.message))

    // Short markers so they never wrap (and split mid-token across rows) when the
    // Activity panel narrows on file-open. One per typed command.
    let markerSeq = 0
    const nextMarker = () => `TLIFEMARK${(markerSeq += 1)}`
    // Focus the live terminal node and run `echo <marker>` through the PTY.
    const typeMarker = async (marker: string): Promise<void> => {
      await xtermLocator(page).click()
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')
    }

    await instrumentTerminalSockets(page)
    await page.goto('/')
    await selectProject(page, fixture.name)

    // The shell session is listed in the Activity panel's Sessions section.
    const sessionRow = activityPanel(page).getByText(sessionName, { exact: true })
    await expect(sessionRow).toBeVisible({ timeout: 15_000 })

    // Attach it — clicking sets activeSession and mounts the lazy Terminal.
    await sessionRow.click()
    await expect(xtermLocator(page)).toBeVisible({ timeout: 15_000 })
    await expect(terminalHeader(page, sessionName)).toBeVisible()

    // Readiness from the PTY path: wait until the socket is OPEN (no fixed sleep),
    // then prove one-and-only-one socket exists.
    await expect.poll(() => termWsReadyState(page), { timeout: 15_000 }).toBe(WebSocket.OPEN)
    expect(await termWsStats(page)).toEqual({ opens: 1, closes: 0 })

    // Seed real output, then capture + stamp the live xterm node.
    let lastMarker = nextMarker()
    await typeMarker(lastMarker)
    await expect(xtermRows(page)).toContainText(lastMarker, { timeout: 15_000 })

    const node = await xtermLocator(page).elementHandle()
    expect(node).not.toBeNull()
    await node!.evaluate(el => el.setAttribute('data-lifecycle-probe', 'attached-1'))

    // Assert the SAME terminal survived an unrelated re-render: same node, same
    // socket, and a fresh command still round-trips after the prior output.
    const assertSameTerminal = async (label: string): Promise<void> => {
      // Identity: original node still attached; current node still stamped.
      const stillConnected = await node!.evaluate(el => el.isConnected)
      expect(stillConnected, `${label}: original xterm node disposed (remounted)`).toBe(true)
      const stamp = await xtermLocator(page).getAttribute('data-lifecycle-probe')
      expect(stamp, `${label}: live xterm node replaced (remounted)`).toBe('attached-1')

      // Header still bound to the session.
      await expect(terminalHeader(page, sessionName), `${label}: header lost session`).toBeVisible()

      // Prior output is still on screen, and a NEW command round-trips through the
      // same live PTY and lands after it (stream continuity, no reset).
      await expect(xtermRows(page), `${label}: prior output lost`).toContainText(lastMarker)
      const fresh = nextMarker()
      await typeMarker(fresh)
      // Poll one CONSISTENT capture until prior + fresh are both present and
      // ordered. xterm rewrites its reused row nodes per animation frame, so a
      // single innerText() snapshot can miss freshly-rendered output — never
      // assert ordering on one stale read; wait for it to actually round-trip.
      const prior = lastMarker
      await expect
        .poll(async () => {
          const text = await xtermRows(page).innerText()
          const iPrev = text.indexOf(prior)
          const iFresh = text.indexOf(fresh)
          return iPrev >= 0 && iFresh > iPrev
        }, { timeout: 15_000, message: `${label}: fresh output did not round-trip after prior output` })
        .toBe(true)
      lastMarker = fresh

      // Exactly one PTY socket for the whole lifetime; never closed/reopened. The
      // round-trip above gives any delayed reconnect time to surface first.
      expect(await termWsStats(page), `${label}: PTY reconnected or closed`).toEqual({ opens: 1, closes: 0 })
    }

    // The terminal is the sole tab of the working group (group:1); we never open a
    // file into that group (which would swap the active tab and hide the terminal
    // body). So the unrelated re-renders below are layout-state changes that churn
    // WorkspaceScreen without touching the terminal's group/active tab.

    // --- Re-render #1: collapse a sidebar section. A layout-state change unrelated
    // to the terminal's group — the terminal must not remount. ---
    const projectsHeader = sectionHeader(page, 'Projects')
    await expect(projectsHeader).toHaveAttribute('aria-expanded', 'true')
    await projectsHeader.click()
    await expect(projectsHeader).toHaveAttribute('aria-expanded', 'false')
    await assertSameTerminal('after collapsing a sidebar section')

    // --- Re-render #2: hide + restore the dock (Cmd+B). Big layout churn that
    // re-renders WorkspaceScreen / the tree, still unrelated to the terminal. ---
    await page.keyboard.press('Meta+b')
    await expect(page.locator('[data-node-id="dock"]')).toHaveCount(0)
    await page.keyboard.press('Meta+b')
    await expect(page.locator('[data-node-id="dock"]')).toBeVisible({ timeout: 10_000 })
    await assertSameTerminal('after toggling the dock')

    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([])
  })
})
