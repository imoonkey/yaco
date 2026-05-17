import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir } = vi.hoisted(() => ({ homeDir: { value: '' } }))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'migrate-channels-test-'))

const { migrateLegacyChannelPaths } = await import('../migrate-channels')

const workflowDir = () => join(homeDir.value, '.workflow')
const legacy = (name: string) => join(workflowDir(), name)
const newPath = (...parts: string[]) => join(workflowDir(), 'channels', ...parts)

async function resetWorkflowDir(): Promise<void> {
  await rm(workflowDir(), { recursive: true, force: true })
}

describe('migrateLegacyChannelPaths', () => {
  beforeEach(async () => {
    await resetWorkflowDir()
  })

  afterAll(async () => {
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

  it('migrates all four legacy paths when present', async () => {
    await mkdir(workflowDir(), { recursive: true })
    await writeFile(legacy('wechat-qr.txt'),       'QR-ASCII')
    await writeFile(legacy('whatsapp-auth.json'),  '{"a":1}')
    await writeFile(legacy('whatsapp-state.json'), '{"s":2}')
    await mkdir(legacy('whatsapp-session'), { recursive: true })
    await writeFile(join(legacy('whatsapp-session'), 'cookie.bin'), 'COOKIE')

    await migrateLegacyChannelPaths()

    expect(existsSync(legacy('wechat-qr.txt'))).toBe(false)
    expect(existsSync(legacy('whatsapp-auth.json'))).toBe(false)
    expect(existsSync(legacy('whatsapp-state.json'))).toBe(false)
    expect(existsSync(legacy('whatsapp-session'))).toBe(false)

    expect(await readFile(newPath('wechat',   'qr.txt'),    'utf-8')).toBe('QR-ASCII')
    expect(await readFile(newPath('whatsapp', 'auth.json'), 'utf-8')).toBe('{"a":1}')
    expect(await readFile(newPath('whatsapp', 'state.json'),'utf-8')).toBe('{"s":2}')
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
})
