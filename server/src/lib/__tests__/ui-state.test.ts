import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir } = vi.hoisted(() => ({ homeDir: { value: '' } }))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

homeDir.value = await mkdtemp(join(tmpdir(), 'workflow-ui-state-test-'))
await mkdir(join(homeDir.value, '.workflow'), { recursive: true })

const {
  readJson,
  writeJson,
  getPinnedSessions,
  setPinnedSessions,
} = await import('../ui-state')

const uiStateDir = join(homeDir.value, '.workflow', 'ui-state')

describe('ui-state: generic JSON helpers', () => {
  beforeEach(async () => {
    await rm(uiStateDir, { recursive: true, force: true })
  })
  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  it('readJson returns default when file missing', async () => {
    expect(await readJson('missing.json', { hello: 'world' })).toEqual({ hello: 'world' })
    expect(await readJson<number[]>('missing.json', [])).toEqual([])
  })

  it('readJson returns default when file unparseable', async () => {
    await mkdir(uiStateDir, { recursive: true })
    const { writeFile } = await import('fs/promises')
    await writeFile(join(uiStateDir, 'bad.json'), '{not valid', 'utf-8')
    expect(await readJson('bad.json', { fallback: true })).toEqual({ fallback: true })
  })

  it('writeJson + readJson round-trip', async () => {
    const data = { a: 1, b: ['x', 'y'], c: { nested: true } }
    await writeJson('round.json', data)
    expect(await readJson('round.json', {})).toEqual(data)
  })
})

describe('ui-state: pinned sessions', () => {
  beforeEach(async () => {
    await rm(uiStateDir, { recursive: true, force: true })
  })
  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  it('getPinnedSessions returns empty when unset', async () => {
    expect(await getPinnedSessions('proj-a')).toEqual([])
  })

  it('setPinnedSessions preserves order across writes', async () => {
    await setPinnedSessions('proj-a', ['a', 'b', 'c'])
    expect(await getPinnedSessions('proj-a')).toEqual(['a', 'b', 'c'])

    await setPinnedSessions('proj-a', ['c', 'a', 'b'])
    expect(await getPinnedSessions('proj-a')).toEqual(['c', 'a', 'b'])
  })

  it('setPinnedSessions with empty array clears that project', async () => {
    await setPinnedSessions('proj-a', ['x', 'y'])
    expect(await getPinnedSessions('proj-a')).toEqual(['x', 'y'])

    await setPinnedSessions('proj-a', [])
    expect(await getPinnedSessions('proj-a')).toEqual([])
  })

  it('two projects are independent', async () => {
    await setPinnedSessions('proj-a', ['a1', 'a2'])
    await setPinnedSessions('proj-b', ['b1'])

    expect(await getPinnedSessions('proj-a')).toEqual(['a1', 'a2'])
    expect(await getPinnedSessions('proj-b')).toEqual(['b1'])

    await setPinnedSessions('proj-a', [])
    expect(await getPinnedSessions('proj-a')).toEqual([])
    expect(await getPinnedSessions('proj-b')).toEqual(['b1'])
  })
})
