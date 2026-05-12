import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  execFileSyncMock,
  spawnSyncMock,
  platformMock,
} = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  platformMock: vi.fn(),
}))

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  spawnSync: spawnSyncMock,
}))

vi.mock('os', () => ({
  platform: platformMock,
}))

import { buildChildProcessEnv } from '../ssh-auth'

describe('buildChildProcessEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    platformMock.mockReturnValue('darwin')
    process.env.SSH_AUTH_SOCK = '/stale/socket'
  })

  it('strips npm_config_* vars leaked by `npm run`', () => {
    spawnSyncMock.mockReturnValue({ status: 0 })
    process.env.npm_config_prefix = '/some/prefix'
    process.env.npm_config_cache = '/some/cache'
    process.env.npm_lifecycle_event = 'dev'

    const env = buildChildProcessEnv()

    expect(env.npm_config_prefix).toBeUndefined()
    expect(env.npm_config_cache).toBeUndefined()
    expect(env.npm_lifecycle_event).toBeUndefined()

    delete process.env.npm_config_prefix
    delete process.env.npm_config_cache
    delete process.env.npm_lifecycle_event
  })

  it('keeps the current socket when ssh-agent is already reachable', () => {
    spawnSyncMock.mockReturnValue({ status: 0 })

    const env = buildChildProcessEnv()

    expect(env.SSH_AUTH_SOCK).toBe('/stale/socket')
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
  })

  it('replaces a stale socket with a live ssh-agent socket on macOS', () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 2 })
      .mockReturnValueOnce({ status: 0 })
    execFileSyncMock
      .mockReturnValueOnce('4242\n')
      .mockReturnValueOnce([
        'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
        'ssh-agent 4242 moonkey 3u unix 0x0 0t0 /live/socket',
      ].join('\n'))

    const env = buildChildProcessEnv()

    expect(env.SSH_AUTH_SOCK).toBe('/live/socket')
    expect(process.env.SSH_AUTH_SOCK).toBe('/live/socket')
  })

  it('loads identities from Apple keychain when the agent is reachable but empty', () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 })

    const env = buildChildProcessEnv()

    expect(env.SSH_AUTH_SOCK).toBe('/stale/socket')
    expect(spawnSyncMock).toHaveBeenNthCalledWith(2, 'ssh-add', ['--apple-load-keychain'], expect.objectContaining({
      env: expect.objectContaining({ SSH_AUTH_SOCK: '/stale/socket' }),
    }))
  })
})
