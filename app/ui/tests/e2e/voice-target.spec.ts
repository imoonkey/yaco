import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  waitForAppReady,
  openFileViaSearch,
  waitForSSERefresh,
  createTestFile,
  activityPanel,
  group,
  uniqueFileName,
  runTag,
  type FixtureProject,
} from './helpers/workspace'

// Desktop global voice control (design: §G). The target indicator + dropdown are
// pure UI state driven by focus + eligibility — no recording — so they run in the
// static build once /api/voice/status reports enabled (the control renders in the
// App top bar beside the bell). Pins:
//   - the voice target FOLLOWS the focused instance across editor↔terminal;
//   - a dropdown pick OVERRIDES the target, and the override CLEARS when focus next
//     transitions to an eligible pane (follow-focus resumes);
//   - when the current target's instance is CLOSED, the target re-resolves to a live
//     eligible instance (the build-verifiable analog of target-loss; the recording
//     target-loss path is covered by the useVoice / voiceStateMachine unit tests).

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
  const name = `mi-voice-${runTag()}`
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

/** Report voice enabled so the GlobalVoiceControl renders against the static build
 *  (no Groq key / mic needed — the target indicator does not depend on capability). */
async function stubVoiceEnabled(page: Page): Promise<void> {
  await page.route('**/api/voice/status', (route) =>
    route.fulfill({ json: { enabled: true, sttModel: 'stub', maxUploadBytes: 20_000_000 } }),
  )
}

// Editor and terminal share a group's strip and hide each other (one active body
// per group), so the two eligible voice targets must live in SEPARATE groups: the
// file editor in group:1, and a session opened BESIDE it as a terminal in group:2.
const homePane = (page: Page) => group(page, 'group:1').locator('[data-panel-leaf="editor"]')
const terminalPane = (page: Page) => group(page, 'group:2').locator('[data-panel-leaf="terminal"]')
const voiceTarget = (page: Page) => page.getByRole('button', { name: /^Voice target:/ })
const sessionRow = (page: Page, name: string) => activityPanel(page).getByText(name, { exact: true }).first()

/** Open a session BESIDE the editor → a bound terminal in its own group:2. */
async function openSessionBeside(page: Page, name: string): Promise<void> {
  await sessionRow(page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open beside' }).click()
}

/** Focus the editor and wait for the focus marker so a target assertion can't race
 *  the focus transition. */
async function focusEditor(page: Page): Promise<void> {
  await homePane(page).locator('.cm-content').click()
  await expect(homePane(page)).toHaveAttribute('data-focused', 'true')
}
/** Focus the (bound) terminal by clicking its body, then wait for the focus marker. */
async function focusTerminal(page: Page): Promise<void> {
  await terminalPane(page).locator('.yaco-terminal-xterm').click()
  await expect(terminalPane(page)).toHaveAttribute('data-focused', 'true')
}

test.describe('Global voice control — target follows focus + dropdown override', () => {
  test('target follows focus across editor/terminal, with a dropdown override that clears on refocus', async ({ page, request }) => {
    await stubVoiceEnabled(page)
    const file = uniqueFileName('voice.txt')
    fixture = await createFixtureProject(request)
    const s = await startShell(request, fixture.path)
    await waitServed(request, fixture.name)
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    // One editor (the file) + one bound terminal (the session) → two eligible targets.
    await createTestFile(page, fixture.name, file, 'voice body\n')
    await waitForSSERefresh(page, 3000)
    await openFileViaSearch(page, file)
    await openSessionBeside(page, s) // bind the session as a terminal in group:2 + focus it
    await expect(terminalPane(page)).toHaveAttribute('data-focused', 'true', { timeout: 15_000 })

    // The target follows focus across kinds: terminal → the session, editor → the file.
    await expect(voiceTarget(page)).toHaveAccessibleName(`Voice target: ${s}`, { timeout: 10_000 })
    await focusEditor(page)
    await expect(voiceTarget(page)).toHaveAccessibleName(`Voice target: ${file}`)
    await focusTerminal(page)
    await expect(voiceTarget(page)).toHaveAccessibleName(`Voice target: ${s}`)

    // Dropdown override: while the terminal is focused, pick the editor → the target
    // is forced to the file even though focus stays on the terminal.
    await voiceTarget(page).click()
    await page.getByRole('menuitemradio', { name: file }).click()
    await expect(voiceTarget(page)).toHaveAccessibleName(`Voice target: ${file}`)

    // The override clears on the next focus transition (epoch advance): focusing the
    // editor advances it; focus-follow then resumes, so re-focusing the terminal once
    // more resolves back to the session (it would still be the file if the override
    // had stuck).
    await focusEditor(page)
    await expect(voiceTarget(page)).toHaveAccessibleName(`Voice target: ${file}`)
    await focusTerminal(page)
    await expect(voiceTarget(page)).toHaveAccessibleName(`Voice target: ${s}`)
  })

  test('closing the target terminal re-resolves the voice target to a live instance', async ({ page, request }) => {
    await stubVoiceEnabled(page)
    const file = uniqueFileName('voice_keep.txt')
    fixture = await createFixtureProject(request)
    const s = await startShell(request, fixture.path)
    await waitServed(request, fixture.name)
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    await createTestFile(page, fixture.name, file, 'keep\n')
    await waitForSSERefresh(page, 3000)
    await openFileViaSearch(page, file)
    await openSessionBeside(page, s) // bind the session as a terminal in group:2 + focus it
    await expect(voiceTarget(page)).toHaveAccessibleName(`Voice target: ${s}`, { timeout: 15_000 })

    // Close the terminal via its tab's close × (the close lives in the group tab bar,
    // not the pane body). With the terminal gone, the target re-resolves to the
    // remaining eligible instance — the editor.
    const terminalTab = group(page, 'group:2').locator('[data-testid="group-tab"][data-tab-kind="terminal"]')
    await terminalTab.hover()
    await terminalTab.getByRole('button', { name: 'Close terminal' }).click()
    await expect(terminalPane(page)).toHaveCount(0)
    await expect(voiceTarget(page)).toHaveAccessibleName(`Voice target: ${file}`, { timeout: 10_000 })
  })
})
