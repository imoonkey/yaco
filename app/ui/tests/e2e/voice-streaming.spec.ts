import { expect, test, type Page, type Route, type WebSocketRoute } from '@playwright/test'
import {
  createFixtureProject,
  openFileViaSearch,
  selectProject,
  waitForAppReady,
  type FixtureProject,
} from './helpers/workspace'

const liveBrowserFixture = process.env.YACO_VOICE_LIVE_AUDIO_FIXTURE

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      ...(liveBrowserFixture ? [`--use-file-for-fake-audio-capture=${liveBrowserFixture}`] : []),
    ],
  },
})

let fixture: FixtureProject | undefined

test.beforeEach(async ({ request }) => {
  fixture = await createFixtureProject(request, {
    files: { 'package.json': '{"name":"voice-stream-fixture","private":true}\n' },
  })
})

test.afterEach(async () => {
  await fixture?.dispose()
})

async function prepareVoice(page: Page, autoFormat: boolean): Promise<void> {
  await page.route('**/api/voice/status', route => route.fulfill({
    json: {
      enabled: true,
      providers: {
        codex: { available: true },
        groq: { available: true, model: 'stub' },
      },
      formatter: { available: true, models: ['stub'] },
      maxUploadBytes: 20_000_000,
      tts: { enabled: false },
    },
  }))
  await page.addInitScript((enabled) => {
    localStorage.setItem('yaco.voiceProvider', 'codex')
    localStorage.setItem('yaco.voiceAutoFormat', enabled ? '1' : '0')
    const windowWithCapture = window as unknown as {
      __YACO_FAKE_CAPTURE__?: (
        callbacks: unknown,
        pcmSink?: {
          start: (sampleRateHz: number) => void
          append: (chunk: Int16Array) => void
        },
      ) => Promise<unknown>
    }
    windowWithCapture.__YACO_FAKE_CAPTURE__ = (_callbacks, pcmSink) => {
      pcmSink?.start(48_000)
      pcmSink?.append(new Int16Array([1, -1, 2, -2]))
      return Promise.resolve({
        stop: async () => new Blob(['synthetic-fallback'], { type: 'audio/webm' }),
        release: async () => {},
      })
    }
  }, autoFormat)

  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, fixture!.name)
  await openFileViaSearch(page, 'package.json')
  await expect(page.getByRole('button', { name: 'Start voice recording' })).toBeVisible({
    timeout: 10_000,
  })
}

async function prepareNativeCapture(page: Page): Promise<void> {
  await page.route('**/api/voice/status', route => route.fulfill({
    json: {
      enabled: true,
      providers: { codex: { available: true }, groq: { available: false } },
      formatter: { available: false },
      maxUploadBytes: 20_000_000,
    },
  }))
  await page.addInitScript(() => {
    localStorage.setItem('yaco.voiceProvider', 'codex')
    localStorage.setItem('yaco.voiceAutoFormat', '0')
  })
  await page.goto('/')
  await waitForAppReady(page)
  await selectProject(page, fixture!.name)
  await openFileViaSearch(page, 'package.json')
  await expect(page.getByRole('button', { name: 'Start voice recording' })).toBeVisible({
    timeout: 10_000,
  })
}

function respondToStream(
  socket: WebSocketRoute,
  outcome: 'final' | 'failed',
  received: { binaryFrames: number; finishes: number },
): void {
  socket.onMessage((message) => {
    if (typeof message !== 'string') {
      received.binaryFrames++
      return
    }
    const control = JSON.parse(message) as { type?: string }
    if (control.type === 'start') {
      socket.send(JSON.stringify({ type: 'ready' }))
      return
    }
    if (control.type === 'finish') {
      received.finishes++
      socket.send(JSON.stringify(
        outcome === 'final'
          ? { type: 'final', text: 'stream-result-sentinel' }
          : { type: 'failed' },
      ))
    }
  })
}

async function recordAndStop(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start voice recording' }).click()
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible({ timeout: 5_000 })
  await stop.click()
}

async function readBatchTake(route: Route): Promise<{ provider: FormDataEntryValue | null; audio: Buffer }> {
  const request = route.request()
  const body = request.postDataBuffer()
  const contentType = request.headers()['content-type']
  expect(body).not.toBeNull()
  expect(contentType).toContain('multipart/form-data')
  const form = await new Response(body!, {
    headers: { 'content-type': contentType! },
  }).formData()
  const audio = form.get('audio')
  expect(audio).toBeInstanceOf(File)
  return {
    provider: form.get('provider'),
    audio: Buffer.from(await (audio as File).arrayBuffer()),
  }
}

test('Codex stream final skips batch and Auto format runs once after raw text', async ({ page }) => {
  const received = { binaryFrames: 0, finishes: 0 }
  let batchCalls = 0
  let formatCalls = 0
  await page.routeWebSocket('**/ws/voice/codex', socket => {
    respondToStream(socket, 'final', received)
  })
  await page.route('**/api/voice/transcribe', (route) => {
    batchCalls++
    return route.fulfill({ status: 500 })
  })
  await page.route('**/api/voice/format', (route) => {
    formatCalls++
    return route.fulfill({
      json: { displayText: 'formatted-result-sentinel', formattingStatus: 'formatted' },
    })
  })

  await prepareVoice(page, true)
  await recordAndStop(page)

  await expect(page.getByLabel('Compose input')).toHaveValue('formatted-result-sentinel', {
    timeout: 10_000,
  })
  expect(received.binaryFrames).toBe(1)
  expect(received.finishes).toBe(1)
  expect(batchCalls).toBe(0)
  expect(formatCalls).toBe(1)
  await expect(page.getByRole('checkbox', { name: 'Auto format' })).toBeChecked()
})

test('forced stream failure uses Codex batch once; Retry reuses it with Auto format off', async ({ page }) => {
  const received = { binaryFrames: 0, finishes: 0 }
  const takes: Array<{ provider: FormDataEntryValue | null; audio: Buffer }> = []
  let formatCalls = 0
  await page.routeWebSocket('**/ws/voice/codex', socket => {
    respondToStream(socket, 'failed', received)
  })
  await page.route('**/api/voice/transcribe', async (route: Route) => {
    takes.push(await readBatchTake(route))
    if (takes.length === 1) {
      await route.fulfill({ status: 502, json: { error: 'synthetic failure' } })
      return
    }
    await route.fulfill({ json: { text: 'batch-result-sentinel' } })
  })
  await page.route('**/api/voice/format', (route) => {
    formatCalls++
    return route.fulfill({ status: 500 })
  })

  await prepareVoice(page, false)
  await recordAndStop(page)
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('combobox', { name: 'Transcription provider' })).toHaveValue('codex')
  await expect(page.getByRole('checkbox', { name: 'Auto format' })).not.toBeChecked()

  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByLabel('Compose input')).toHaveValue('batch-result-sentinel', {
    timeout: 10_000,
  })
  expect(received.binaryFrames).toBe(1)
  expect(received.finishes).toBe(1)
  expect(takes.map(take => take.provider)).toEqual(['codex', 'codex'])
  expect(takes[0]!.audio.equals(takes[1]!.audio)).toBe(true)
  expect(formatCalls).toBe(0)
})

test('opt-in Chromium capture exercises getUserMedia, MediaRecorder, AudioWorklet, and Stop', async ({ page }) => {
  test.skip(!liveBrowserFixture, 'set YACO_VOICE_LIVE_AUDIO_FIXTURE to a temporary WAV')
  const received = { binaryFrames: 0, finishes: 0 }
  let batchCalls = 0
  await page.routeWebSocket('**/ws/voice/codex', socket => {
    respondToStream(socket, 'failed', received)
  })
  await page.route('**/api/voice/transcribe', (route) => {
    batchCalls++
    return route.fulfill({ json: { text: 'native-capture-result-sentinel' } })
  })

  await prepareNativeCapture(page)
  await page.getByRole('button', { name: 'Start voice recording' }).click()
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible({ timeout: 5_000 })
  await expect.poll(() => received.binaryFrames, { timeout: 10_000 }).toBeGreaterThan(0)
  await stop.click()

  await expect(page.getByLabel('Compose input')).toHaveValue('native-capture-result-sentinel', {
    timeout: 10_000,
  })
  expect(received.finishes).toBe(1)
  expect(batchCalls).toBe(1)
})
