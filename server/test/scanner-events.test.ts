import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { appendEvent } from '../src/lib/eventsLog'
import { scanProgress } from '../src/lib/scanner'
import type { Project } from '../src/lib/projects'

const ORIGINAL_YACO_HOME = process.env.YACO_HOME

let fixtureRoot: string
let repoA: string
let repoB: string

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'yaco-scanner-test-'))
  process.env.YACO_HOME = fixtureRoot
  repoA = join(fixtureRoot, 'repo-a')
  repoB = join(fixtureRoot, 'repo-b')
  await mkdir(join(repoA, 'projects', 'active', 'bundle-a'), { recursive: true })
  await mkdir(join(repoB, 'projects'), { recursive: true })
})

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
  if (ORIGINAL_YACO_HOME === undefined) delete process.env.YACO_HOME
  else process.env.YACO_HOME = ORIGINAL_YACO_HOME
})

describe('scanProgress with events.jsonl + legacy progress.json', () => {
  it('merges events with legacy entries and dedupes only within the same project/workstream/id', async () => {
    await appendEvent('alpha', {
      id: 'same-id',
      ts: '2026-05-27T10:00:00.000Z',
      kind: 'session_idle',
      taskId: 'bundle-a',
      sessionId: 'w-a',
      payload: { agent: 'claude', message: 'event wins' },
    })

    await writeFile(join(repoA, 'projects', 'active', 'bundle-a', 'progress.json'), JSON.stringify([
      {
        id: 'same-id',
        agent: 'claude',
        type: 'session_idle',
        message: 'legacy duplicate should be hidden',
        timestamp: '2026-05-27T09:00:00.000Z',
        status: 'active',
        sessionName: 'w-a',
      },
      {
        id: 'legacy-only',
        agent: 'codex',
        type: 'info',
        message: 'legacy still visible',
        timestamp: '2026-05-27T08:00:00.000Z',
        status: 'active',
      },
    ]), 'utf-8')

    await writeFile(join(repoB, 'projects', 'progress.json'), JSON.stringify([
      {
        id: 'same-id',
        agent: 'codex',
        type: 'blocked',
        message: 'same id in another project is distinct',
        timestamp: '2026-05-27T07:00:00.000Z',
        status: 'active',
      },
    ]), 'utf-8')

    const projects: Project[] = [
      { name: 'alpha', path: repoA },
      { name: 'beta', path: repoB },
    ]

    const entries = await scanProgress(projects)

    expect(entries.map(e => `${e.project}:${e.workstream}:${e.id}:${e.message}`)).toEqual([
      'alpha:bundle-a:same-id:event wins',
      'alpha:bundle-a:legacy-only:legacy still visible',
      'beta::same-id:same id in another project is distinct',
    ])
  })
})
