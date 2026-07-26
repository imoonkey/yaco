import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../../lib/constants', async (original) => {
  const actual = await original<typeof import('../../lib/constants')>()
  return {
    ...actual,
    get YACO_PATH() { return stubScript },
    YACO_AGENT_USAGE_TIMEOUT_MS: 25_000,
  }
})

vi.mock('../../lib/ssh-auth', () => ({
  buildChildProcessEnv: () => ({ PATH: process.env.PATH ?? '' }),
}))

let stubScript = ''
let stubLog = ''

const { usageRoutes } = await import('../usage')

function writeStub(envelope: object, exitCode: number, channel: 'stdout' | 'stderr'): void {
  const body = JSON.stringify(envelope).replace(/'/g, `'\\''`)
  const redirect = channel === 'stdout' ? '' : '1>&2'
  const script = `#!/usr/bin/env bash
printf '%s\\n' '${body}' ${redirect}
echo "$@" >> '${stubLog}'
exit ${exitCode}
`
  writeFileSync(stubScript, script)
  chmodSync(stubScript, 0o755)
}

beforeEach(() => {
  const stubDir = mkdtempSync(join(tmpdir(), 'workflow-usage-route-stub-'))
  stubScript = join(stubDir, 'yaco')
  stubLog = join(stubDir, 'argv.log')
  writeFileSync(stubLog, '')
})

afterEach(() => {
  if (stubScript) {
    const stubDir = join(stubScript, '..')
    rmSync(stubDir, { recursive: true, force: true })
    stubScript = ''
  }
})

describe('GET / — cached usage', () => {
  it('runs yaco agent usage --json and returns payload', async () => {
    const payload = {
      ok: true,
      data: [
        {
          provider: 'claude',
          plan: 'max',
          checkedAt: '2026-07-25T11:58:00.000Z',
          windows: [{ window: 'session', percent: 4, resetsAt: '2026-07-25T16:00:00.000Z' }],
        },
      ],
    }
    writeStub(payload, 0, 'stdout')

    const res = await usageRoutes.request('/', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(payload.data)
    expect(readFileSync(stubLog, 'utf-8').trim()).toBe('agent usage --json')
  })

  it('returns 500 on malformed payload', async () => {
    writeStub({ ok: true, data: [{ provider: 'claude' }] }, 0, 'stdout')
    const res = await usageRoutes.request('/', { method: 'GET' })
    expect(res.status).toBe(500)
  })
})

describe('POST /refresh — forced re-probe', () => {
  it('runs yaco agent usage --fresh --json', async () => {
    const payload = {
      ok: true,
      data: [
        {
          provider: 'claude',
          checkedAt: '2026-07-25T12:00:00.000Z',
          windows: [{ window: 'session', percent: 10 }],
        },
        {
          provider: 'codex',
          checkedAt: '2026-07-25T12:00:00.000Z',
          windows: [],
          error: { code: 'ENV', message: 'codex CLI not found on PATH' },
        },
      ],
    }
    writeStub(payload, 0, 'stdout')

    const res = await usageRoutes.request('/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(payload.data)
    expect(readFileSync(stubLog, 'utf-8').trim()).toBe('agent usage --fresh --json')
  })

  it('maps CLI envelope failures to HTTP errors', async () => {
    writeStub({ ok: false, error: { code: 'RATE_LIMIT', message: 'retry after 1m' } }, 1, 'stderr')
    const res = await usageRoutes.request('/refresh', { method: 'POST' })
    expect(res.status).toBe(429)
    expect((await res.json()).error).toBe('retry after 1m')
  })
})
