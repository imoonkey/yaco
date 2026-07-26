import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaco-channels-'))
  process.env.YACO_HOME = home
})

afterEach(() => {
  delete process.env.YACO_HOME
  rmSync(home, { recursive: true, force: true })
})

function writeRaw(contents: string): void {
  mkdirSync(join(home, 'channels'), { recursive: true })
  writeFileSync(join(home, 'channels', 'enabled.json'), contents, 'utf-8')
}

describe('channel enablement', () => {
  it('treats an absent file as every channel off', async () => {
    const { readChannelEnabled } = await import('../enabled')
    expect(readChannelEnabled()).toEqual({ wechat: false, whatsapp: false })
  })

  // Anchors the two cases below: they assert "off" for bad contents, which is
  // also what a file the reader never found would return. This proves the
  // reader is actually looking where the fixture writes.
  it('reads a hand-written file at the path it is expected to live', async () => {
    writeRaw(JSON.stringify({ wechat: true, whatsapp: false }))
    const { readChannelEnabled } = await import('../enabled')
    expect(readChannelEnabled()).toEqual({ wechat: true, whatsapp: false })
  })

  it('treats a malformed file as every channel off rather than throwing', async () => {
    writeRaw('{ not json')
    const { readChannelEnabled } = await import('../enabled')
    expect(readChannelEnabled()).toEqual({ wechat: false, whatsapp: false })
  })

  it('only accepts a literal true, so a truthy value never enables a channel', async () => {
    writeRaw(JSON.stringify({ wechat: 'yes', whatsapp: 1 }))
    const { readChannelEnabled } = await import('../enabled')
    expect(readChannelEnabled()).toEqual({ wechat: false, whatsapp: false })
  })

  it('round-trips a toggle', async () => {
    const { setChannelEnabled, isChannelEnabled } = await import('../enabled')
    setChannelEnabled('whatsapp', true)
    expect(isChannelEnabled('whatsapp')).toBe(true)
    setChannelEnabled('whatsapp', false)
    expect(isChannelEnabled('whatsapp')).toBe(false)
  })

  it('toggling one channel leaves the other untouched', async () => {
    const { setChannelEnabled, readChannelEnabled } = await import('../enabled')
    setChannelEnabled('wechat', true)
    setChannelEnabled('whatsapp', true)
    setChannelEnabled('wechat', false)
    expect(readChannelEnabled()).toEqual({ wechat: false, whatsapp: true })
  })

  it('writes atomically, leaving no temp file behind', async () => {
    const { setChannelEnabled } = await import('../enabled')
    setChannelEnabled('wechat', true)
    const dir = join(home, 'channels')
    expect(readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'enabled.json'), 'utf-8')).wechat).toBe(true)
  })
})
