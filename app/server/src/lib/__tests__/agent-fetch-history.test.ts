import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
}))

vi.mock('../constants', () => ({
  YACO_AGENT_COMMAND_TIMEOUT_MS: 5_000,
  YACO_AGENT_STATUS_TIMEOUT_MS: 10_000,
  AGENT_SESSIONS_DIR: '/tmp/yaco-agent-test-sessions',
  YACO_PATH: '/tmp/yaco-test-bin',
}))

vi.mock('../ssh-auth', () => ({
  buildChildProcessEnv: () => ({ PATH: process.env.PATH ?? '' }),
}))

import { fetchHistory } from '../agent'

function mockSpawnOutput(stdout: string, code = 0): void {
  spawnMock.mockImplementation(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = vi.fn()
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout))
      proc.emit('close', code)
    })
    return proc
  })
}

describe('fetchHistory', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('reads rows from the canonical history window envelope', async () => {
    const row = {
      sessionId: 'sid-1',
      provider: 'claude',
      title: null,
      summary: 'Fix tests',
      created: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      messageCount: null,
      gitBranch: null,
      live: false,
      liveSessionName: null,
    }
    mockSpawnOutput(JSON.stringify({
      ok: true,
      data: { rows: [row], returned: 1, truncated: false, oldestUpdatedAt: row.updatedAt },
    }))

    await expect(fetchHistory('/repo/app')).resolves.toEqual([row])
    expect(spawnMock).toHaveBeenCalledWith(
      '/tmp/yaco-test-bin',
      ['agent', 'history', '--path', '/repo/app', '--json'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    )
  })
})
