import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'

// Track calls and return configurable output per git command
let spawnResults: Map<string, string>
/** Per-command exit codes — non-zero means err is set, but stdout is still returned. */
let spawnExitCodes: Map<string, number>
const mockExecFile = vi.fn(
  (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    let key = 'unknown'
    if (args[0] === 'status') key = 'status'
    else if (args[0] === 'show') key = 'show'
    else if (args.includes('--no-index')) key = 'no-index'
    else if (args.includes('--cached')) key = 'cached'
    else if (args[0] === 'diff' && args.includes('--shortstat')) key = 'shortstat'
    else if (args[0] === 'diff' && args[1] === 'HEAD') key = 'head'

    const code = spawnExitCodes.get(key) ?? 0
    const err = code === 0 ? null : Object.assign(new Error(`exit ${code}`), { code })
    cb(err, spawnResults.get(key) ?? '', '')
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

function baselineRequest(filePath: string) {
  return gitRoutes.request(`/test-project/baseline?path=${encodeURIComponent(filePath)}`)
}

describe('GET /:project/diff — 3-step fallback', () => {
  beforeEach(() => {
    testProjectPath = '/tmp/fake-repo'
    spawnResults = new Map()
    spawnExitCodes = new Map()
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

  // Regression: `git diff --no-index` exits 1 when it produced a diff —
  // the wrapper must still return stdout, not treat exit≠0 as failure.
  it('returns untracked diff even though git --no-index exits 1', async () => {
    spawnResults.set('head', '')
    spawnResults.set('cached', '')
    spawnResults.set('no-index', 'diff --git /dev/null b/new.ts\n+content\n')
    spawnExitCodes.set('no-index', 1)

    const res = await diffRequest('new.ts')
    expect(res.status).toBe(200)
    const json = await res.json() as { diff: string }
    expect(json.diff).toContain('+content')
  })
})

describe('GET /:project/status — null-terminated parsing', () => {
  beforeEach(() => {
    testProjectPath = '/tmp/fake-repo'
    spawnResults = new Map()
    spawnExitCodes = new Map()
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

describe('GET /:project/baseline — HEAD content', () => {
  beforeEach(() => {
    testProjectPath = '/tmp/fake-repo'
    spawnResults = new Map()
    spawnExitCodes = new Map()
    mockExecFile.mockClear()
  })

  it('returns file content from HEAD', async () => {
    spawnResults.set('show', 'committed content\n')

    const res = await baselineRequest('src/file.ts')
    expect(res.status).toBe(200)
    const json = await res.json() as { content: string; exists: boolean }
    expect(json).toEqual({ content: 'committed content\n', exists: true })
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['show', 'HEAD:./src/file.ts'],
      expect.objectContaining({ cwd: testProjectPath }),
      expect.any(Function),
    )
  })

  it('returns an empty missing baseline for untracked files', async () => {
    spawnExitCodes.set('show', 128)

    const res = await baselineRequest('new-file.ts')
    expect(res.status).toBe(200)
    const json = await res.json() as { content: string; exists: boolean }
    expect(json).toEqual({ content: '', exists: false })
  })

  it('rejects unsafe baseline paths', async () => {
    const res = await baselineRequest('../secret.txt')
    expect(res.status).toBe(400)
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('does not treat transient git failures as missing files', async () => {
    spawnExitCodes.set('show', 1)

    const res = await baselineRequest('src/file.ts')
    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('git baseline failed')
  })

  // Regression: the content endpoint serves a symlink's real target, so the
  // baseline must read that target's HEAD blob. `git show HEAD:<symlink>` returns
  // only the link text — diffing the real buffer against it paints the whole file
  // as changed. Resolve the symlink and run git from the target's own directory.
  it('resolves symlinks to the real target for the baseline', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'baseline-symlink-'))
    testProjectPath = repo
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'real.txt'), 'real content\n')
    symlinkSync(join('src', 'real.txt'), join(repo, 'link.txt'))
    const realTarget = realpathSync(join(repo, 'link.txt'))

    spawnResults.set('show', 'real content\n')

    const res = await baselineRequest('link.txt')
    expect(res.status).toBe(200)
    const json = await res.json() as { content: string; exists: boolean }
    expect(json).toEqual({ content: 'real content\n', exists: true })
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['show', 'HEAD:./real.txt'],
      expect.objectContaining({ cwd: dirname(realTarget) }),
      expect.any(Function),
    )
  })
})
