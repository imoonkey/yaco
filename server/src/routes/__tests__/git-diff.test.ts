import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SpawnSyncReturns } from 'child_process'

// Track spawnSync calls and return configurable output per git command
let spawnResults: Map<string, string>
const mockSpawnSync = vi.fn((_cmd: string, args: string[]): SpawnSyncReturns<string> => {
  // Identify which fallback step based on args
  let key = 'unknown'
  if (args.includes('--no-index')) key = 'no-index'
  else if (args.includes('--cached')) key = 'cached'
  else if (args[0] === 'diff' && args[1] === 'HEAD') key = 'head'

  return {
    stdout: spawnResults.get(key) ?? '',
    stderr: '',
    status: 0,
    signal: null,
    pid: 1,
    output: [],
    error: undefined as unknown as Error,
  }
})

vi.mock('child_process', () => ({ spawnSync: mockSpawnSync }))

let testProjectPath: string
vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([{ name: 'test-project', path: testProjectPath }]),
}))

const { gitRoutes } = await import('../git')

function diffRequest(filePath: string) {
  return gitRoutes.request(`/test-project/diff?path=${encodeURIComponent(filePath)}`)
}

describe('GET /:project/diff — 3-step fallback', () => {
  beforeEach(() => {
    testProjectPath = '/tmp/fake-repo'
    spawnResults = new Map()
    mockSpawnSync.mockClear()
  })

  it('returns working-tree diff when HEAD diff has output', async () => {
    spawnResults.set('head', 'diff --git a/file.ts\n-old\n+new\n')

    const res = await diffRequest('file.ts')
    expect(res.status).toBe(200)
    const json = await res.json() as { diff: string }
    expect(json.diff).toContain('-old')

    // Should not call cached or no-index
    const calls = mockSpawnSync.mock.calls.map(c => c[1])
    expect(calls.some(a => a.includes('--cached'))).toBe(false)
    expect(calls.some(a => a.includes('--no-index'))).toBe(false)
  })

  it('falls back to staged diff when HEAD diff is empty', async () => {
    spawnResults.set('head', '')
    spawnResults.set('cached', 'diff --git a/file.ts\n-staged\n+change\n')

    const res = await diffRequest('file.ts')
    expect(res.status).toBe(200)
    const json = await res.json() as { diff: string }
    expect(json.diff).toContain('-staged')

    // Should have called HEAD then cached, but not no-index
    const calls = mockSpawnSync.mock.calls.map(c => c[1])
    expect(calls.some(a => a.includes('--cached'))).toBe(true)
    expect(calls.some(a => a.includes('--no-index'))).toBe(false)
  })

  it('falls back to untracked diff when HEAD and staged are empty', async () => {
    spawnResults.set('head', '')
    spawnResults.set('cached', '')
    spawnResults.set('no-index', 'diff --git /dev/null b/file.ts\n+new file\n')

    const res = await diffRequest('file.ts')
    expect(res.status).toBe(200)
    const json = await res.json() as { diff: string }
    expect(json.diff).toContain('+new file')

    const calls = mockSpawnSync.mock.calls.map(c => c[1])
    expect(calls.some(a => a.includes('--cached'))).toBe(true)
    expect(calls.some(a => a.includes('--no-index'))).toBe(true)
  })

  it('returns empty diff when all three steps produce nothing', async () => {
    spawnResults.set('head', '')
    spawnResults.set('cached', '')
    spawnResults.set('no-index', '')

    const res = await diffRequest('file.ts')
    expect(res.status).toBe(200)
    const json = await res.json() as { diff: string }
    expect(json.diff).toBe('')
  })
})
