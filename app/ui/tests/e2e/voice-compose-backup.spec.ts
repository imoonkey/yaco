import { test, expect, type Page } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  openFileViaSearch,
  waitForAppReady,
  type FixtureProject,
} from './helpers/workspace'
import { resolveDevPorts } from '../../e2ePorts'

// Drives the real ComposeTray via a fake MicVAD + stubbed voice API, and
// verifies the defensive clipboard backup: whenever the tray closes with edited
// content (Insert / Discard), the draft lands on the clipboard so a glitched
// insert can never silently lose carefully-edited text.
//
// The fake MicVAD hook is gated on import.meta.env.DEV (voiceVad.ts), so it only
// works against the dev server — the default isolated suite serves a static
// build, where real VAD can't run headless. Run this with E2E_REUSE=1.
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
  test.skip(skipOnBuild, 'voice fake-VAD hook is dev-only (import.meta.env.DEV); run with E2E_REUSE=1')
  fixture = await createFixtureProject(request, {
    files: { 'package.json': '{"name":"voice-fixture","private":true}\n' },
  })
})

test.afterEach(async () => {
  await fixture?.dispose()
})

/** Stub the voice endpoints so the tray works without a Groq key or real audio. */
async function stubVoice(page: Page, displayText: string) {
  await page.route('**/api/voice/status', (route) =>
    route.fulfill({
      json: { enabled: true, sttModel: 'stub', formatterModels: ['stub'], maxUploadBytes: 20_000_000 },
    }),
  )
  await page.addInitScript(() => {
    const w = window as unknown as {
      __YACO_FAKE_MIC_VAD__?: unknown
      __YACO_FAKE_VAD_EVENTS__?: string[]
    }
    w.__YACO_FAKE_VAD_EVENTS__ = []
    w.__YACO_FAKE_MIC_VAD__ = {
      MicVAD: {
        new: async (options) => {
          w.__YACO_FAKE_VAD_EVENTS__?.push('new')
          await new Promise((resolve) => setTimeout(resolve, 100))
          w.__YACO_FAKE_VAD_EVENTS__?.push('ready')
          return {
            pause: async () => {
              w.__YACO_FAKE_VAD_EVENTS__?.push('pause')
              options.onSpeechEnd(new Float32Array(16000).fill(0.2))
            },
            destroy: async () => {
              w.__YACO_FAKE_VAD_EVENTS__?.push('destroy')
            },
          }
        },
      },
    }
  })
  await page.route('**/api/voice/transcribe', (route) =>
    route.fulfill({ json: { text: 'original transcript' } }),
  )
  await page.route('**/api/voice/format', (route) =>
    route.fulfill({
      json: { displayText, formattingStatus: 'formatted' },
    }),
  )
}

/** Open the fixture project and a file so the editor voice button appears. */
async function openFileForVoice(page: Page): Promise<void> {
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, fixture!.name)

  // Open a file via Cmd+P search so a file is the active editor tab.
  await openFileViaSearch(page, 'package.json')

  // Editor voice button only renders once a file is the active editor tab.
  await expect(page.getByRole('button', { name: 'Start voice recording' })).toBeVisible({
    timeout: 10_000,
  })
}

/** Start fake VAD, stop it, then land in the compose state. */
async function recordToCompose(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start voice recording' }).click()
  const fakeEvents = () =>
    page.evaluate(() => (window as unknown as { __YACO_FAKE_VAD_EVENTS__?: string[] }).__YACO_FAKE_VAD_EVENTS__ ?? [])
  await expect.poll(fakeEvents).toContain('new')
  await expect.poll(fakeEvents).toContain('ready')
  await page.waitForTimeout(300)
  expect(await fakeEvents()).not.toContain('destroy')
  // Tray shows immediately in the active state with a Stop button.
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible({ timeout: 5_000 })
  await stop.click()
  // Compose textarea appears once /transcribe and /format have both returned.
  await expect(page.getByLabel('Voice transcript')).toBeVisible({ timeout: 10_000 })
}

test('Insert copies the edited draft to the clipboard as a backup', async ({ page }) => {
  await stubVoice(page, 'original transcript')
  await openFileForVoice(page)
  await recordToCompose(page)

  const edited = 'carefully edited QA backup text'
  await page.getByLabel('Voice transcript').fill(edited)
  await page.getByRole('button', { name: 'Insert' }).click()

  // Tray closes…
  await expect(page.getByLabel('Voice transcript')).toBeHidden({ timeout: 5_000 })
  // …and the draft is on the clipboard even if the insert itself glitched.
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(edited)
})

test('Discard still preserves the draft on the clipboard', async ({ page }) => {
  await stubVoice(page, 'original transcript')
  await openFileForVoice(page)
  await recordToCompose(page)

  const edited = 'discarded but recoverable text'
  await page.getByLabel('Voice transcript').fill(edited)
  await page.getByRole('button', { name: 'Discard' }).click()

  await expect(page.getByLabel('Voice transcript')).toBeHidden({ timeout: 5_000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(edited)
})
