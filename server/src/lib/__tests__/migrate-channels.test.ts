import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir, renameOverride } = vi.hoisted(() => ({
  homeDir: { value: '' },
  // When set, the mocked fs/promises rename throws this error instead of
  // delegating to the real implementation. Used to simulate EACCES/EXDEV.
  renameOverride: { error: null as NodeJS.ErrnoException | null },
}))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (src: string, dst: string) => {
      if (renameOverride.error) throw renameOverride.error
      return actual.rename(src, dst)
    },
  }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'migrate-channels-test-'))

const { migrateLegacyChannelPaths } = await import('../migrate-channels')

const workflowDir = () => join(homeDir.value, '.workflow')
const legacy = (name: string) => join(workflowDir(), name)
const newPath = (...parts: string[]) => join(workflowDir(), 'channels', ...parts)

async function resetWorkflowDir(): Promise<void> {
  await rm(workflowDir(), { recursive: true, force: true })
}

function makeErr(code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`mock ${code}`)
  e.code = code
  return e
}

describe('migrateLegacyChannelPaths', () => {
  beforeEach(async () => {
    renameOverride.error = null
    await resetWorkflowDir()
  })

  afterAll(async () => {
    renameOverride.error = null
    await rm(homeDir.value, { recursive: true, force: true })
  })

  it('no-op when ~/.workflow does not exist', async () => {
    await migrateLegacyChannelPaths()
    expect(existsSync(workflowDir())).toBe(false)
  })

  it('creates scope dirs even when no legacy files exist', async () => {
    await mkdir(workflowDir(), { recursive: true })
    await migrateLegacyChannelPaths()
    expect(existsSync(newPath('wechat'))).toBe(true)
    expect(existsSync(newPath('whatsapp'))).toBe(true)
  })

  it('migrates all six legacy paths when present', async () => {
    await mkdir(workflowDir(), { recursive: true })
    await writeFile(legacy('wechat-qr.txt'),       'QR-ASCII')
    await writeFile(legacy('wechat-auth.json'),    '{"wa":1}')
    await writeFile(legacy('wechat-state.json'),   '{"ws":2}')
    await writeFile(legacy('whatsapp-auth.json'),  '{"a":1}')
    await writeFile(legacy('whatsapp-state.json'), '{"s":2}')
    await mkdir(legacy('whatsapp-session'), { recursive: true })
    await writeFile(join(legacy('whatsapp-session'), 'cookie.bin'), 'COOKIE')

    await migrateLegacyChannelPaths()

    expect(existsSync(legacy('wechat-qr.txt'))).toBe(false)
    expect(existsSync(legacy('wechat-auth.json'))).toBe(false)
    expect(existsSync(legacy('wechat-state.json'))).toBe(false)
    expect(existsSync(legacy('whatsapp-auth.json'))).toBe(false)
    expect(existsSync(legacy('whatsapp-state.json'))).toBe(false)
    expect(existsSync(legacy('whatsapp-session'))).toBe(false)

    expect(await readFile(newPath('wechat',   'qr.txt'),     'utf-8')).toBe('QR-ASCII')
    expect(await readFile(newPath('wechat',   'auth.json'),  'utf-8')).toBe('{"wa":1}')
    expect(await readFile(newPath('wechat',   'state.json'), 'utf-8')).toBe('{"ws":2}')
    expect(await readFile(newPath('whatsapp', 'auth.json'),  'utf-8')).toBe('{"a":1}')
    expect(await readFile(newPath('whatsapp', 'state.json'), 'utf-8')).toBe('{"s":2}')
    expect(await readFile(join(newPath('whatsapp', 'session'), 'cookie.bin'), 'utf-8')).toBe('COOKIE')
  })

  it('skips when new path already exists (no-op)', async () => {
    await mkdir(newPath('whatsapp'), { recursive: true })
    await writeFile(newPath('whatsapp', 'auth.json'), '{"new":true}')
    await mkdir(workflowDir(), { recursive: true })
    await writeFile(legacy('whatsapp-auth.json'), '{"legacy":true}')

    await migrateLegacyChannelPaths()

    expect(await readFile(newPath('whatsapp', 'auth.json'), 'utf-8')).toBe('{"new":true}')
    expect(existsSync(legacy('whatsapp-auth.json'))).toBe(true)
  })

  it('mixed state: migrates only legacy entries whose new path is missing', async () => {
    await mkdir(newPath('whatsapp'), { recursive: true })
    await writeFile(newPath('whatsapp', 'state.json'), '{"preexisting":true}')

    await mkdir(workflowDir(), { recursive: true })
    await writeFile(legacy('wechat-qr.txt'),       'QR')
    await writeFile(legacy('whatsapp-auth.json'),  'AUTH')
    await writeFile(legacy('whatsapp-state.json'), 'OLD-STATE')

    await migrateLegacyChannelPaths()

    // Missing-new paths migrate
    expect(existsSync(legacy('wechat-qr.txt'))).toBe(false)
    expect(existsSync(legacy('whatsapp-auth.json'))).toBe(false)
    expect(await readFile(newPath('wechat',   'qr.txt'),    'utf-8')).toBe('QR')
    expect(await readFile(newPath('whatsapp', 'auth.json'), 'utf-8')).toBe('AUTH')

    // Existing-new path preserved; legacy stays put
    expect(await readFile(newPath('whatsapp', 'state.json'), 'utf-8')).toBe('{"preexisting":true}')
    expect(existsSync(legacy('whatsapp-state.json'))).toBe(true)
  })

  it('idempotent: second call is a no-op', async () => {
    await mkdir(workflowDir(), { recursive: true })
    await writeFile(legacy('wechat-qr.txt'), 'QR')

    await migrateLegacyChannelPaths()
    const after1 = await readFile(newPath('wechat', 'qr.txt'), 'utf-8')

    await migrateLegacyChannelPaths()
    const after2 = await readFile(newPath('wechat', 'qr.txt'), 'utf-8')

    expect(after1).toBe(after2)
    expect(await readdir(workflowDir())).not.toContain('wechat-qr.txt')
  })

  it('propagates non-race rename failures (EACCES)', async () => {
    await mkdir(workflowDir(), { recursive: true })
    await writeFile(legacy('wechat-qr.txt'), 'QR')

    renameOverride.error = makeErr('EACCES')

    await expect(migrateLegacyChannelPaths()).rejects.toMatchObject({ code: 'EACCES' })

    // Legacy file remains untouched — boot should crash rather than silently
    // leave channel modules reading empty new paths.
    expect(existsSync(legacy('wechat-qr.txt'))).toBe(true)
    expect(existsSync(newPath('wechat', 'qr.txt'))).toBe(false)
  })

  it('swallows ENOENT (source vanished mid-flight) and continues', async () => {
    await mkdir(workflowDir(), { recursive: true })
    await writeFile(legacy('wechat-qr.txt'), 'QR')

    renameOverride.error = makeErr('ENOENT')

    await expect(migrateLegacyChannelPaths()).resolves.toBeUndefined()
  })

  it('swallows EEXIST (concurrent boot won the race) and continues', async () => {
    await mkdir(workflowDir(), { recursive: true })
    await writeFile(legacy('wechat-qr.txt'), 'QR')

    renameOverride.error = makeErr('EEXIST')

    await expect(migrateLegacyChannelPaths()).resolves.toBeUndefined()
  })
})
