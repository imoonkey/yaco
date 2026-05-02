import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track calls and return configurable output per git command
let spawnResults: Map<string, string>
const mockExecFile = vi.fn(
  (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    let key = 'unknown'
    if (args[0] === 'status') key = 'status'
    else if (args.includes('--no-index')) key = 'no-index'
    else if (args.includes('--cached')) key = 'cached'
    else if (args[0] === 'diff' && args.includes('--shortstat')) key = 'shortstat'
    else if (args[0] === 'diff' && args[1] === 'HEAD') key = 'head'

    cb(null, spawnResults.get(key) ?? '', '')
  },
)

vi.mock('child_process', () => ({ execFile: mockExecFile }))

let testProjectPath: string
vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([{ name: 'test-project', path: testProjectPath }]),
}))

const { gitRoutes } = await import('../git')

function diffRequest(filePath: string) {
  return gitRoutes.request(`/test-project/diff?path=${encodeURIComponent(filePath)}`)
}

function statusRequest() {
  return gitRoutes.request('/test-project/status')
}

describe('GET /:project/diff — 3-step fallback', () => {
  beforeEach(() => {
    testProjectPath = '/tmp/fake-repo'
    spawnResults = new Map()
    mockExecFile.mockClear()
  })

  it('returns working-tree diff when HEAD diff has output', async () => {
    spawnResults.set('head', 'diff --git a/file.ts\n-old\n+new\n')

    const res = await diffRequest('file.ts')
    expect(res.status).toBe(200)
    const json = await res.json() as { diff: string }
    expect(json.diff).toContain('-old')

    // Should not call cached or no-index
    const calls = mockExecFile.mock.calls.map(c => c[1])
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

    const calls = mockExecFile.mock.calls.map(c => c[1])
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

    const calls = mockExecFile.mock.calls.map(c => c[1])
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

describe('GET /:project/status — null-terminated parsing', () => {
  beforeEach(() => {
    testProjectPath = '/tmp/fake-repo'
    spawnResults = new Map()
    mockExecFile.mockClear()
  })

  it('parses standard modified/added/deleted/untracked entries', async () => {
    // -z format: entries separated by \0, no trailing newline
    spawnResults.set('status', ' M src/app.ts\0A  new-file.ts\0 D removed.ts\0?? untracked.txt\0')
    spawnResults.set('shortstat', ' 2 files changed, 10 insertions(+), 3 deletions(-)')

    const res = await statusRequest()
    const json = await res.json() as { changes: Array<{ path: string; status: string }>; stale: boolean }
    expect(json.stale).toBe(false)
    expect(json.changes).toEqual([
      { path: 'src/app.ts', status: 'M' },
      { path: 'new-file.ts', status: 'A' },
      { path: 'removed.ts', status: 'D' },
      { path: 'untracked.txt', status: 'U' },
    ])
  })

  it('skips old-name entry for renames', async () => {
    // Rename: "R  new-name.ts\0old-name.ts\0" — two entries, second is old path
    spawnResults.set('status', 'R  new-name.ts\0old-name.ts\0 M other.ts\0')
    spawnResults.set('shortstat', '')

    const res = await statusRequest()
    const json = await res.json() as { changes: Array<{ path: string; status: string }> }
    expect(json.changes).toEqual([
      { path: 'new-name.ts', status: 'M' },  // R maps to M via parseStatus
      { path: 'other.ts', status: 'M' },
    ])
  })

  it('handles filenames with spaces correctly', async () => {
    spawnResults.set('status', ' M path with spaces/file name.ts\0')
    spawnResults.set('shortstat', '')

    const res = await statusRequest()
    const json = await res.json() as { changes: Array<{ path: string; status: string }> }
    expect(json.changes).toEqual([
      { path: 'path with spaces/file name.ts', status: 'M' },
    ])
  })
})
