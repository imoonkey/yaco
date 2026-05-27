import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { homedir } from 'os'

const ORIGINAL_YACO_HOME = process.env.YACO_HOME

async function freshImport() {
  // Bust the module cache so getYacoHome's path constants re-resolve against
  // whatever process.env.YACO_HOME / mocked homedir() the test just set.
  vi.resetModules()
  return await import('../src/lib/yacoHome')
}

describe('getYacoHome', () => {
  beforeEach(() => {
    delete process.env.YACO_HOME
  })

  afterEach(() => {
    if (ORIGINAL_YACO_HOME === undefined) delete process.env.YACO_HOME
    else process.env.YACO_HOME = ORIGINAL_YACO_HOME
  })

  it('defaults to ~/.yaco when YACO_HOME is unset', async () => {
    const mod = await freshImport()
    expect(mod.getYacoHome()).toBe(join(homedir(), '.yaco'))
  })

  it('honors YACO_HOME verbatim when set', async () => {
    process.env.YACO_HOME = '/tmp/yaco-fixture-root'
    const mod = await freshImport()
    expect(mod.getYacoHome()).toBe('/tmp/yaco-fixture-root')
  })

  it('treats empty YACO_HOME as unset (falls back to default)', async () => {
    process.env.YACO_HOME = ''
    const mod = await freshImport()
    expect(mod.getYacoHome()).toBe(join(homedir(), '.yaco'))
  })
})

describe('YACO path helpers under a YACO_HOME fixture', () => {
  const FIXTURE = '/tmp/yaco-fixture-root'

  beforeEach(() => {
    process.env.YACO_HOME = FIXTURE
  })

  afterEach(() => {
    if (ORIGINAL_YACO_HOME === undefined) delete process.env.YACO_HOME
    else process.env.YACO_HOME = ORIGINAL_YACO_HOME
  })

  it('projectsFile resolves under YACO_HOME', async () => {
    const mod = await freshImport()
    expect(mod.projectsFile()).toBe(`${FIXTURE}/projects.json`)
  })

  it('uiStateDir resolves under YACO_HOME', async () => {
    const mod = await freshImport()
    expect(mod.uiStateDir()).toBe(`${FIXTURE}/ui-state`)
  })

  it('shellSessionsDir resolves under YACO_HOME', async () => {
    const mod = await freshImport()
    expect(mod.shellSessionsDir()).toBe(`${FIXTURE}/shell-sessions`)
  })

  it('channelsDir resolves under YACO_HOME', async () => {
    const mod = await freshImport()
    expect(mod.channelsDir()).toBe(`${FIXTURE}/channels`)
  })

  it('channelScopeDir nests scope under channels/', async () => {
    const mod = await freshImport()
    expect(mod.channelScopeDir('whatsapp')).toBe(`${FIXTURE}/channels/whatsapp`)
    expect(mod.channelScopeDir('wechat')).toBe(`${FIXTURE}/channels/wechat`)
  })

  it('projectEventsFile resolves to projects/<id>/events.jsonl under YACO_HOME', async () => {
    const mod = await freshImport()
    expect(mod.projectEventsFile('workflow')).toBe(`${FIXTURE}/projects/workflow/events.jsonl`)
  })
})
