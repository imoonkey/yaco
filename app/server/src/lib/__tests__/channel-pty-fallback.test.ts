import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { homeDir, captureSession, sendToSession } = vi.hoisted(() => ({
  homeDir: { value: '' },
  captureSession: vi.fn(),
  sendToSession: vi.fn(async () => undefined),
}))

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

vi.mock('../agent', async (orig) => {
  const actual = await orig<typeof import('../agent')>()
  return { ...actual, captureSession, sendToSession }
})

vi.mock('../channels/agent-output', async (orig) => {
  const actual = await orig<typeof import('../channels/agent-output')>()
  return { ...actual, startTurn: vi.fn(async () => null) }
})

vi.mock('../channels/pty-tap', () => ({
  acquireTap: vi.fn(async () => undefined),
  releaseTap: vi.fn(async () => undefined),
  hasTap: vi.fn(() => true),
  recordOffset: vi.fn(() => 0),
  sliceFromOffset: vi.fn(() => ({ text: '', truncated: false })),
  waitForQuiet: vi.fn(async () => ({ quiet: true })),
}))

homeDir.value = await mkdtemp(join(tmpdir(), 'channel-pty-fallback-'))
const originalHome = process.env.HOME
const originalYacoHome = process.env.YACO_HOME
process.env.HOME = homeDir.value
process.env.YACO_HOME = join(homeDir.value, '.yaco')

const projectPath = join(homeDir.value, 'quant')
const yacoHome = join(homeDir.value, '.yaco')
await mkdir(join(yacoHome, 'sessions'), { recursive: true })
await mkdir(projectPath, { recursive: true })
await writeFile(join(yacoHome, 'projects.json'), JSON.stringify([
  { id: 'quant', path: projectPath },
]))
await writeFile(join(yacoHome, 'sessions', 'flight.json'), JSON.stringify({
  handle: 'flight',
  provider: 'codex',
  sessionPath: projectPath,
  pid: 1234,
  sessionId: 'unresolvable-id',
  status: 'idle',
  createdAt: '2026-08-13T20:39:47.221Z',
}))

const { createRouter } = await import('../channels/router')
const { createBindingStore } = await import('../channels/state')

afterAll(async () => {
  process.env.HOME = originalHome
  process.env.YACO_HOME = originalYacoHome
  await rm(homeDir.value, { recursive: true, force: true })
})

describe('channel PTY fallback', () => {
  it('replies from the rendered Codex pane instead of forwarding repaint bytes', async () => {
    captureSession.mockResolvedValue([
      '› hhi',
      '',
      '• Hi! What would you like to work on?',
      '',
      '› Improve documentation in @filename',
      '',
      '  quant · main · Context 97% left · gpt-5.6-sol medium · Full Access',
    ].join('\n'))

    const store = createBindingStore('pty-fallback-test')
    await store.addSession('chat', {
      project: 'quant',
      session: 'flight',
      boundAt: '2026-08-13T20:39:47.221Z',
    })
    const router = createRouter(store)
    let resolveReply!: (text: string) => void
    const reply = new Promise<string>((resolve) => { resolveReply = resolve })
    await router.handleMessage({ conversationId: 'chat' }, 'hhi', async (message) => {
      if (message.kind === 'text') resolveReply(message.text)
    })

    await expect(reply).resolves.toBe('[flight] • Hi! What would you like to work on?')
    expect(sendToSession).toHaveBeenCalledWith('flight', 'hhi')
    expect(captureSession).toHaveBeenCalledWith('flight', 2000)
  })
})
