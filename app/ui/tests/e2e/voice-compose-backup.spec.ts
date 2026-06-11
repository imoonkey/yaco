import { test, expect, type Page } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  openFileViaSearch,
  waitForAppReady,
  type FixtureProject,
} from './helpers/workspace'
import { resolveDevPorts } from '../../e2ePorts'

// Drives the real ComposeTray via a fake capture session + stubbed voice API,
// and verifies the defensive clipboard backup: whenever the tray closes with
// edited content (Insert / Discard), the draft lands on the clipboard so a
// glitched insert can never silently lose carefully-edited text.
//
// The fake capture hook is gated on import.meta.env.DEV (voiceCapture.ts), so it
// only works against the dev server — the default isolated suite serves a static
// build, where the seam is absent. Run this with E2E_REUSE=1.
const skipOnBuild = resolveDevPorts({ e2e: true }).yacoHome !== null

test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
})

// Provision the fixture (with a package.json to open) WITHOUT navigating — the
// voice stubs/init scripts must be installed before the first goto.
let fixture: FixtureProject | undefined

test.beforeEach(async ({ request }) => {
  test.skip(skipOnBuild, 'voice fake-capture hook is dev-only (import.meta.env.DEV); run with E2E_REUSE=1')
  fixture = await createFixtureProject(request, {
    files: { 'package.json': '{"name":"voice-fixture","private":true}\n' },
  })
})

test.afterEach(async () => {
  await fixture?.dispose()
})

/** Stub the voice endpoints + capture so the tray works without a Groq key or a
 *  real mic. `__YACO_FAKE_CAPTURE__` replaces startCaptureSession's body: stop()
 *  resolves a dummy blob, which the stubbed /transcribe + /format then turn into
 *  `displayText`. */
async function stubVoice(page: Page, displayText: string) {
  await page.route('**/api/voice/status', (route) =>
    route.fulfill({
      json: { enabled: true, sttModel: 'stub', maxUploadBytes: 20_000_000 },
    }),
  )
  await page.addInitScript(() => {
    const w = window as unknown as {
      __YACO_FAKE_CAPTURE__?: (callbacks: unknown) => Promise<unknown>
      __YACO_FAKE_CAPTURE_EVENTS__?: string[]
    }
    w.__YACO_FAKE_CAPTURE_EVENTS__ = []
    w.__YACO_FAKE_CAPTURE__ = () => {
      w.__YACO_FAKE_CAPTURE_EVENTS__?.push('start')
      return Promise.resolve({
        stop: async () => {
          w.__YACO_FAKE_CAPTURE_EVENTS__?.push('stop')
          return new Blob(['fake-audio'], { type: 'audio/webm' })
        },
        release: async () => { w.__YACO_FAKE_CAPTURE_EVENTS__?.push('release') },
      })
    }
  })
  await page.route('**/api/voice/transcribe', (route) =>
    route.fulfill({ json: { text: 'original transcript' } }),
  )
  await page.route('**/api/voice/format', (route) =>
    route.fulfill({ json: { displayText, formattingStatus: 'formatted' } }),
  )
}

/** Open the fixture project and a file so the editor compose launcher appears. */
async function openFileForVoice(page: Page): Promise<void> {
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, fixture!.name)

  // Open a file via Cmd+P search so a file is the active editor tab.
  await openFileViaSearch(page, 'package.json')

  // The editor mic only renders once a file is the active tab.
  await expect(page.getByRole('button', { name: 'Start voice recording' })).toBeVisible({
    timeout: 10_000,
  })
}

/** Click the mic (records immediately), stop, and land in compose with the
 *  transcript appended. */
async function recordToCompose(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start voice recording' }).click()
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible({ timeout: 5_000 })
  await stop.click()
  // The transcript is appended once /transcribe and /format have both returned.
  await expect(page.getByLabel('Compose input')).toHaveValue(/original transcript/, { timeout: 10_000 })
}

test('Insert copies the edited draft to the clipboard as a backup', async ({ page }) => {
  await stubVoice(page, 'original transcript')
  await openFileForVoice(page)
  await recordToCompose(page)

  const edited = 'carefully edited QA backup text'
  await page.getByLabel('Compose input').fill(edited)
  await page.getByRole('button', { name: 'Insert' }).click()

  // Tray closes…
  await expect(page.getByLabel('Compose input')).toBeHidden({ timeout: 5_000 })
  // …and the draft is on the clipboard even if the insert itself glitched.
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(edited)
})

test('Close (X) still preserves the draft on the clipboard', async ({ page }) => {
  await stubVoice(page, 'original transcript')
  await openFileForVoice(page)
  await recordToCompose(page)

  const edited = 'discarded but recoverable text'
  await page.getByLabel('Compose input').fill(edited)
  await page.getByRole('button', { name: 'Close' }).click()

  await expect(page.getByLabel('Compose input')).toBeHidden({ timeout: 5_000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(edited)
})

test('plain Enter inserts a newline; only Cmd/Ctrl+Enter sends', async ({ page }) => {
  await stubVoice(page, 'original transcript')
  await openFileForVoice(page)
  await recordToCompose(page)

  const input = page.getByLabel('Compose input')
  await input.fill('line one')
  // Plain Enter must NOT send — it inserts a newline and the tray stays open.
  await input.press('Enter')
  await input.type('line two')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('line one\nline two')

  // ControlOrMeta+Enter sends (inserts) and closes the tray.
  await input.press('ControlOrMeta+Enter')
  await expect(input).toBeHidden({ timeout: 5_000 })
})

test('Format replaces the draft; the inline Undo button restores it', async ({ page }) => {
  await stubVoice(page, 'original transcript')
  // The Format button (and the take pipeline) post to /voice/format; return a
  // distinct polished string so the replace is observable.
  await page.route('**/api/voice/format', (route) =>
    route.fulfill({ json: { displayText: 'Polished text.', formattingStatus: 'formatted' } }),
  )
  await openFileForVoice(page)

  // A take lands the formatted text; then type raw text so Format produces a change.
  await page.getByRole('button', { name: 'Start voice recording' }).click()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  const input = page.getByLabel('Compose input')
  await expect(input).toHaveValue('Polished text.', { timeout: 10_000 })

  await input.fill('some unformatted draft')
  await page.getByRole('button', { name: 'Format' }).click()
  await expect(input).toHaveValue('Polished text.', { timeout: 5_000 })

  // The inline Undo button (next to Format) restores the pre-format draft.
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(input).toHaveValue('some unformatted draft')
})
