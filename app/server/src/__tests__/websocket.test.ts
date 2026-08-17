import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

const SERVER_ROOT = resolve(import.meta.dirname, '../..')
const ALLOWED_ORIGIN = 'http://allowed.test'

let child: ChildProcess
let home: string
let port: number
let stdout = ''
let stderr = ''

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as { port: number }
      probe.close(() => resolvePort(address.port))
    })
  })
}

async function waitForHealth(): Promise<void> {
  await vi.waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(response.ok).toBe(true)
  }, { timeout: 20_000, interval: 100 })
}

async function connect(path: string, origin = ALLOWED_ORIGIN): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', resolveOpen)
    ws.once('error', reject)
  })
  return ws
}

async function expectRejected(path: string, origin = ALLOWED_ORIGIN): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin })
  await new Promise<void>((resolveRejected, reject) => {
    ws.once('open', () => reject(new Error('unexpected WebSocket upgrade')))
    ws.once('unexpected-response', (_request, response) => {
      response.resume()
      resolveRejected()
    })
    ws.once('error', () => resolveRejected())
    ws.once('close', () => resolveRejected())
  })
  ws.terminate()
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'yaco-websocket-test-'))
  port = await freePort()
  child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      YACO_HOME: home,
      WORKFLOW_PORT: String(port),
      WORKFLOW_CORS_ORIGINS: ALLOWED_ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
  child.once('exit', (code) => {
    if (code && code !== 0) stderr += `\nserver exited ${code}`
  })
  await waitForHealth()
}, 30_000)

afterAll(async () => {
  child?.kill('SIGTERM')
  if (child && child.exitCode === null) {
    await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  }
  await rm(home, { recursive: true, force: true })
})

describe('server WebSocket upgrade routing', () => {
  it('accepts the exact Codex voice path for an allowed origin', async () => {
    const ws = await connect('/ws/voice/codex')
    ws.close()
  })

  it('rejects a disallowed voice origin and every unknown path', async () => {
    await expectRejected('/ws/voice/codex', 'https://evil.example')
    await expectRejected('/ws/voice/codex/extra')
    await expectRejected('/ws/not-a-route')
  })

  it('continues to route terminal sockets through the terminal attach path', async () => {
    const name = `missing-terminal-${process.pid}`
    const ws = await connect(`/ws/terminal/${name}`)
    await vi.waitFor(() => expect(stdout).toContain(`[ws] terminal attached: ${name}`))
    expect(stderr).not.toContain('uncaughtException')
    ws.close()
  })
})
