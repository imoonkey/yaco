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
import { resolveDevPorts } from '../../e2ePorts'

// The voice target selector now lives in the ComposeTray header (design: §G),
// not the top nav bar. It names the instance the next Insert routes into and
// re-points it — the target binds at Insert, not at record. This drives the real
// tray (fake capture + stubbed voice API) to prove the routing: a take recorded
// against the bound terminal (the focus default), then RE-POINTED to the editor
// file, lands in the editor — not the terminal.
//
// The fake capture hook is gated on import.meta.env.DEV (voiceCapture.ts), so it
// only works against the dev server — the static build has no seam. Run with
// E2E_REUSE=1. The default-from-focus precedence + target-loss recovery + the
// in-flight retarget lock are covered by the resolveVoiceTarget /
// voiceStateMachine unit tests.
const skipOnBuild = resolveDevPorts({ e2e: true }).yacoHome !== null

test.use({
  viewport: { width: 1280, height: 800 },
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
})

let fixture: FixtureProject | null = null
const openedSessions: string[] = []

test.beforeEach(() => {
  test.skip(skipOnBuild, 'voice fake-capture hook is dev-only (import.meta.env.DEV); run with E2E_REUSE=1')
})

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

/** Stub the voice endpoints + capture so a take runs without a Groq key or mic.
 *  `__YACO_FAKE_CAPTURE__` replaces startCaptureSession's body. */
async function stubVoice(page: Page): Promise<void> {
  await page.route('**/api/voice/status', (route) =>
    route.fulfill({ json: { enabled: true, sttModel: 'stub', maxUploadBytes: 20_000_000 } }),
  )
  await page.addInitScript(() => {
    const w = window as unknown as { __YACO_FAKE_CAPTURE__?: () => Promise<unknown> }
    w.__YACO_FAKE_CAPTURE__ = () => Promise.resolve({
      stop: async () => new Blob(['fake-audio'], { type: 'audio/webm' }),
      release: async () => {},
    })
  })
  await page.route('**/api/voice/transcribe', (route) => route.fulfill({ json: { text: 'transcript' } }))
  await page.route('**/api/voice/format', (route) =>
    route.fulfill({ json: { displayText: 'transcript', formattingStatus: 'formatted' } }),
  )
}

// Editor and terminal share a group's strip and hide each other, so the two
// eligible voice targets live in SEPARATE groups: the file editor in group:1, and
// a session opened BESIDE it as a terminal in group:2.
const homePane = (page: Page) => group(page, 'group:1').locator('[data-panel-leaf="editor"]')
const terminalPane = (page: Page) => group(page, 'group:2').locator('[data-panel-leaf="terminal"]')
const insertTarget = (page: Page) => page.getByRole('button', { name: /^Insert target:/ })
const composeInput = (page: Page) => page.getByLabel('Compose input')
const sessionRow = (page: Page, name: string) => activityPanel(page).getByText(name, { exact: true }).first()

/** Open a session BESIDE the editor → a bound terminal in its own group:2. */
async function openSessionBeside(page: Page, name: string): Promise<void> {
  await sessionRow(page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open beside' }).click()
}

test.describe('Compose tray target selector — re-point routes the insert', () => {
  test('a take recorded against the terminal lands in the editor once retargeted', async ({ page, request }) => {
    await stubVoice(page)
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

    // Record via the nav mic into the focus default (the just-focused terminal),
    // so the tray opens bound to the terminal session.
    await page.getByRole('button', { name: 'Start voice recording' }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(composeInput(page)).toHaveValue(/transcript/, { timeout: 10_000 })
    await expect(insertTarget(page)).toHaveAccessibleName(`Insert target: ${s}`)

    // Re-point the selector from the terminal to the editor file.
    await insertTarget(page).click()
    await expect(page.getByRole('menuitemradio', { name: s })).toBeVisible()
    await page.getByRole('menuitemradio', { name: file }).click()
    await expect(insertTarget(page)).toHaveAccessibleName(`Insert target: ${file}`)

    // Insert routes to the re-pointed target: the draft lands in the editor file,
    // not the terminal, and the tray closes.
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect(composeInput(page)).toBeHidden({ timeout: 5_000 })
    await expect(homePane(page).locator('.cm-content')).toContainText('transcript', { timeout: 10_000 })
  })

  test('Esc while recording closes the tray instead of leaking to the terminal', async ({ page, request }) => {
    await stubVoice(page)
    fixture = await createFixtureProject(request)
    const s = await startShell(request, fixture.path)
    await waitServed(request, fixture.name)
    await page.goto('/')
    await waitForAppReady(page)
    await selectProject(page, fixture.name)

    // Bind + focus a terminal, then start a take into it via the nav mic. The take
    // stays in flight (no Stop) — the regression is that the background terminal,
    // not the tray, used to keep focus, so Esc reached the PTY and killed the job.
    await openSessionBeside(page, s)
    await expect(terminalPane(page)).toHaveAttribute('data-focused', 'true', { timeout: 15_000 })
    await page.getByRole('button', { name: 'Start voice recording' }).click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 5_000 })

    // The modal owns the keyboard while recording: focus is in the tray, not xterm.
    await expect(composeInput(page)).toBeFocused()
    // …and the target selector stays interactive mid-take (routing binds at Insert).
    await expect(insertTarget(page)).toBeEnabled()

    // Esc is captured by the tray (closes it), never reaching the terminal.
    await page.keyboard.press('Escape')
    await expect(composeInput(page)).toBeHidden({ timeout: 5_000 })
  })
})
