import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { appendEvent } from '../src/lib/eventsLog'
import { scanProgress } from '../src/lib/scanner'
import type { Project } from '../src/lib/projects'

const ORIGINAL_YACO_HOME = process.env.YACO_HOME

let fixtureRoot: string
let repoRoot: string

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'yaco-scanner-test-'))
  process.env.YACO_HOME = fixtureRoot
  repoRoot = join(fixtureRoot, 'repo')
  await mkdir(join(repoRoot, 'projects', 'active', 'bundle-a'), { recursive: true })
})

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
  if (ORIGINAL_YACO_HOME === undefined) delete process.env.YACO_HOME
  else process.env.YACO_HOME = ORIGINAL_YACO_HOME
})

describe('scanProgress with events.jsonl', () => {
  it('reads only canonical events and ignores repo-local progress.json files', async () => {
    await appendEvent('alpha', {
      id: 'event-id',
      ts: '2026-05-27T10:00:00.000Z',
      kind: 'session_idle',
      taskId: 'bundle-a',
      sessionId: 'w-a',
      payload: { agent: 'claude', message: 'event is visible' },
    })

    await writeFile(join(repoRoot, 'projects', 'active', 'bundle-a', 'progress.json'), JSON.stringify([
      {
        id: 'legacy-id',
        agent: 'claude',
        type: 'session_idle',
        message: 'legacy must be ignored',
        timestamp: '2026-05-27T09:00:00.000Z',
        status: 'active',
        sessionName: 'w-a',
      },
    ]), 'utf-8')

    const projects: Project[] = [{ name: 'alpha', path: repoRoot }]
    const entries = await scanProgress(projects)

    expect(entries.map(e => `${e.project}:${e.workstream}:${e.id}:${e.message}`)).toEqual([
      'alpha:bundle-a:event-id:event is visible',
    ])
  })
})
