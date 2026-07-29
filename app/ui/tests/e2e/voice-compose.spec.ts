import { test, expect, type Page, type Route } from '@playwright/test'
import {
  createFixtureProject,
  selectProject,
  openFileViaSearch,
  waitForAppReady,
  type FixtureProject,
} from './helpers/workspace'

// Drives the real ComposeTray via a fake capture session + stubbed voice API.
// The clipboard is only ever written by the explicit Copy button — closing the
// tray (Insert / X) must leave it untouched, so a draft can never leak into an
// unrelated paste.
//
// The fake capture hook is enabled by DEV or the isolated E2E-only build flag.

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
async function stubVoice(
  page: Page,
  displayText: string,
  transcribe?: (route: Route) => Promise<void> | void,
) {
  await page.route('**/api/voice/status', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        providers: {
          codex: { available: true },
          groq: { available: true, model: 'stub' },
        },
        formatter: { available: true, models: ['stub'] },
        maxUploadBytes: 20_000_000,
        tts: { enabled: true, voice: 'stub' },
      },
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
    transcribe?.(route) ?? route.fulfill({ json: { text: 'original transcript' } }),
  )
  await page.route('**/api/voice/format', (route) =>
    route.fulfill({ json: { displayText, formattingStatus: 'formatted' } }),
  )
}

async function readTranscribeForm(route: Route): Promise<{ provider: string | null; audio: string }> {
  const request = route.request()
  const body = request.postDataBuffer()
  const contentType = request.headers()['content-type']
  expect(body).not.toBeNull()
  expect(contentType).toContain('multipart/form-data')

  const form = await new Response(body!, { headers: { 'content-type': contentType! } }).formData()
  const audio = form.get('audio')
  expect(audio).toBeInstanceOf(File)
  return {
    provider: form.get('provider') as string | null,
    audio: Buffer.from(await (audio as File).arrayBuffer()).toString('hex'),
  }
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

test('Insert leaves the clipboard untouched', async ({ page }) => {
  await stubVoice(page, 'original transcript')
  await openFileForVoice(page)
  await page.evaluate(() => navigator.clipboard.writeText('pre-existing clipboard'))
  await recordToCompose(page)

  await page.getByLabel('Compose input').fill('carefully edited QA text')
  await page.getByRole('button', { name: 'Insert', exact: true }).click()

  await expect(page.getByLabel('Compose input')).toBeHidden({ timeout: 5_000 })
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('pre-existing clipboard')
})

test('Close (X) leaves the clipboard untouched; only Copy writes to it', async ({ page }) => {
  await stubVoice(page, 'original transcript')
  await openFileForVoice(page)
  await page.evaluate(() => navigator.clipboard.writeText('pre-existing clipboard'))
  await recordToCompose(page)

  const edited = 'draft that must not leak into a paste'
  await page.getByLabel('Compose input').fill(edited)
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByLabel('Compose input')).toBeHidden({ timeout: 5_000 })
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('pre-existing clipboard')

  // The explicit Copy button is the one path that writes the draft.
  await recordToCompose(page)
  await page.getByLabel('Compose input').fill(edited)
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(edited)
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

test('failure allows an explicit provider switch and Retry reuses the cached audio', async ({ page }) => {
  const requests: Array<{ provider: string | null; audio: string }> = []
  let attempts = 0
  let formatCalls = 0
  page.on('request', request => {
    if (request.url().endsWith('/api/voice/format')) formatCalls++
  })
  await stubVoice(page, 'unused', async route => {
    requests.push(await readTranscribeForm(route))
    attempts++
    if (attempts === 1) {
      await route.fulfill({ status: 502, json: { error: 'Transcription failed. Try again.' } })
      return
    }
    await route.fulfill({ json: { text: 'raw retry transcript' } })
  })
  await openFileForVoice(page)

  await page.getByRole('button', { name: 'Start voice recording' }).click()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 10_000 })

  const provider = page.getByRole('combobox', { name: 'Transcription provider' })
  const autoFormat = page.getByRole('checkbox', { name: 'Auto format' })
  await expect(provider).toHaveValue('codex')
  await provider.selectOption('groq')
  await autoFormat.uncheck()
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByLabel('Compose input')).toHaveValue('raw retry transcript', { timeout: 10_000 })

  expect(requests.map(request => request.provider)).toEqual(['codex', 'groq'])
  expect(requests[0]!.audio).toBe(requests[1]!.audio)
  expect(formatCalls).toBe(0)
})
