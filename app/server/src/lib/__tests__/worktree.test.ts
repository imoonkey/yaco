import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
const existsSyncMock = vi.hoisted(() => vi.fn())
const realpathSyncMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({ existsSync: existsSyncMock, realpathSync: realpathSyncMock }))

import {
  extractWorktreeSlug,
  getWorktreeStatus,
  getWorktreeStatuses,
  listRegisteredWorktrees,
  worktreeStatus,
} from '../worktree'

beforeEach(() => {
  vi.clearAllMocks()
  // Default: realpathSync returns its input (no symlink resolution needed)
  realpathSyncMock.mockImplementation((p: string) => p)
})

// --- extractWorktreeSlug ---

describe('extractWorktreeSlug', () => {
  it('extracts slug from Unix-style path', () => {
    expect(extractWorktreeSlug('/home/user/project/.worktrees/fix-login')).toBe('fix-login')
  })

  it('extracts slug from nested worktree path', () => {
    expect(extractWorktreeSlug('/project/.worktrees/my-task/src/index.ts')).toBe('my-task')
  })

  it('extracts slug from Windows-style backslash path', () => {
    expect(extractWorktreeSlug('C:\\Users\\dev\\project\\.worktrees\\feat-auth')).toBe('feat-auth')
  })

  it('returns undefined for non-worktree path', () => {
    expect(extractWorktreeSlug('/home/user/project/src/main.ts')).toBeUndefined()
  })

  it('returns undefined for path containing worktrees without dot prefix', () => {
    expect(extractWorktreeSlug('/project/worktrees/slug')).toBeUndefined()
  })

  it('handles path ending at slug with trailing slash', () => {
    expect(extractWorktreeSlug('/project/.worktrees/slug/')).toBe('slug')
  })
})

// --- getWorktreeStatus ---

describe('getWorktreeStatus', () => {
  it('returns inactive status when worktree directory does not exist', async () => {
    existsSyncMock.mockReturnValue(false)

    const result = await getWorktreeStatus('/project', 'my-task')

    expect(result).toEqual({
      active: false,
      dirty: false,
      branch: 'task/my-task',
      ahead: 0,
      behind: 0,
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('returns inactive when directory exists but is not a registered worktree', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree') {
        // git worktree list output does NOT include the leftover path
        cb(null, 'worktree /project\nHEAD abc\nbranch refs/heads/main\n\n', '')
      }
    })

    const result = await getWorktreeStatus('/project', 'leftover')

    expect(result).toEqual({
      active: false,
      dirty: false,
      branch: 'task/leftover',
      ahead: 0,
      behind: 0,
    })
  })

  it('returns active clean status with ahead/behind counts', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree') {
        cb(null, 'worktree /project\nHEAD abc\n\nworktree /project/.worktrees/feat\nHEAD def\n\n', '')
      } else if (args[0] === 'status') cb(null, '', '')
      else if (args[0] === 'rev-list') cb(null, '2\t5\n', '')
    })

    const result = await getWorktreeStatus('/project', 'feat')

    expect(result).toEqual({
      active: true,
      dirty: false,
      branch: 'task/feat',
      ahead: 5,
      behind: 2,
    })
  })

  it('returns dirty=true when git status has output', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree') {
        cb(null, 'worktree /project\n\nworktree /project/.worktrees/dirty-task\n\n', '')
      } else if (args[0] === 'status') cb(null, ' M src/index.ts\n', '')
      else if (args[0] === 'rev-list') cb(null, '0\t0\n', '')
    })

    const result = await getWorktreeStatus('/project', 'dirty-task')

    expect(result.active).toBe(true)
    expect(result.dirty).toBe(true)
  })

  it('handles git status failure gracefully (dirty defaults to false)', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree') {
        cb(null, 'worktree /project\n\nworktree /project/.worktrees/fail-status\n\n', '')
      } else if (args[0] === 'status') cb(new Error('git failed'))
      else if (args[0] === 'rev-list') cb(null, '0\t1\n', '')
    })

    const result = await getWorktreeStatus('/project', 'fail-status')

    expect(result).toEqual({
      active: true,
      dirty: false,
      branch: 'task/fail-status',
      ahead: 1,
      behind: 0,
    })
  })

  it('handles git rev-list failure gracefully (ahead/behind default to 0)', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree') {
        cb(null, 'worktree /project\n\nworktree /project/.worktrees/no-main\n\n', '')
      } else if (args[0] === 'status') cb(null, '', '')
      else if (args[0] === 'rev-list') cb(new Error('no main branch'))
    })

    const result = await getWorktreeStatus('/project', 'no-main')

    expect(result).toEqual({
      active: true,
      dirty: false,
      branch: 'task/no-main',
      ahead: 0,
      behind: 0,
    })
  })

  it('parses ahead/behind when values are non-zero', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree') {
        cb(null, 'worktree /project\n\nworktree /project/.worktrees/parse-test\n\n', '')
      } else if (args[0] === 'status') cb(null, '', '')
      else if (args[0] === 'rev-list') cb(null, '10\t3\n', '')
    })

    const result = await getWorktreeStatus('/project', 'parse-test')

    expect(result.behind).toBe(10)
    expect(result.ahead).toBe(3)
  })

  it('passes correct cwd to git commands', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'worktree') {
        cb(null, 'worktree /my/project\n\nworktree /my/project/.worktrees/slug\n\n', '')
      } else {
        cb(null, '', '')
      }
    })

    await getWorktreeStatus('/my/project', 'slug')

    // First call (worktree list) uses project root as cwd
    expect(execFileMock.mock.calls[0][2].cwd).toBe('/my/project')
    // Subsequent calls (status, rev-list) use the worktree path as cwd
    for (const call of execFileMock.mock.calls.slice(1)) {
      expect(call[2].cwd).toBe('/my/project/.worktrees/slug')
    }
  })

  it('handles realpathSync failure gracefully', async () => {
    existsSyncMock.mockReturnValue(true)
    realpathSyncMock.mockImplementation(() => { throw new Error('ENOENT') })
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, 'worktree /project\n\n', '')
    })

    const result = await getWorktreeStatus('/project', 'broken')

    expect(result).toEqual({
      active: false,
      dirty: false,
      branch: 'task/broken',
      ahead: 0,
      behind: 0,
    })
  })
})

// --- listRegisteredWorktrees ---

describe('listRegisteredWorktrees', () => {
  it('parses primary + linked worktrees, marking the first as primary', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, [
        'worktree /repo',
        'HEAD aaaaaaa0000000000000000000000000000000',
        'branch refs/heads/main',
        '',
        'worktree /repo/.worktrees/feat',
        'HEAD bbbbbbb1111111111111111111111111111111',
        'branch refs/heads/task/feat',
        '',
      ].join('\n'), '')
    })

    const entries = await listRegisteredWorktrees('/repo')

    expect(entries).toEqual([
      { path: '/repo', head: 'aaaaaaa', branch: 'main', isPrimary: true },
      { path: '/repo/.worktrees/feat', head: 'bbbbbbb', branch: 'task/feat', isPrimary: false },
    ])
    expect(execFileMock.mock.calls[0][1]).toEqual(['worktree', 'list', '--porcelain'])
    expect(execFileMock.mock.calls[0][2].cwd).toBe('/repo')
  })

  it('labels detached HEAD and bare entries', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, [
        'worktree /repo',
        'HEAD ccccccc2222222222222222222222222222222',
        'detached',
        '',
        'worktree /repo/bare',
        'bare',
        '',
      ].join('\n'), '')
    })

    const entries = await listRegisteredWorktrees('/repo')

    expect(entries[0].branch).toBe('(detached)')
    expect(entries[1].branch).toBe('(bare)')
    expect(entries[1].head).toBe('')
  })

  it('returns [] when git fails (not a repo)', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('not a git repository'))
    })

    expect(await listRegisteredWorktrees('/nope')).toEqual([])
  })
})

// --- worktreeStatus ---

describe('worktreeStatus', () => {
  it('reports dirty + ahead/behind from git status and rev-list', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'status') cb(null, ' M src/index.ts\n', '')
      else if (args[0] === 'rev-list') cb(null, '3\t4\n', '')
    })

    const result = await worktreeStatus('/repo/.worktrees/x', 'task/x')

    expect(result).toEqual({ active: true, dirty: true, branch: 'task/x', ahead: 4, behind: 3 })
  })

  it('defaults to clean 0/0 when both git calls fail', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('git failed'))
    })

    const result = await worktreeStatus('/x', 'task/x')

    expect(result).toEqual({ active: true, dirty: false, branch: 'task/x', ahead: 0, behind: 0 })
  })

  it('runs git in the worktree path', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '', '')
    })

    await worktreeStatus('/repo/.worktrees/x', 'task/x')

    for (const call of execFileMock.mock.calls) {
      expect(call[2].cwd).toBe('/repo/.worktrees/x')
    }
  })
})

// --- getWorktreeStatuses ---

describe('getWorktreeStatuses', () => {
  it('returns empty map when no tasks have worktree field', async () => {
    const tasks = {
      'T1': { title: 'task 1' },
      'T2': { title: 'task 2' },
    }

    const result = await getWorktreeStatuses('/project', tasks)

    expect(result.size).toBe(0)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('resolves statuses for tasks with worktree field', async () => {
    existsSyncMock.mockReturnValue(false) // all inactive

    const tasks = {
      'T1': { worktree: 'feat-a' },
      'T2': { title: 'no worktree' },
      'T3': { worktree: 'feat-b' },
    }

    const result = await getWorktreeStatuses('/project', tasks)

    expect(result.size).toBe(2)
    expect(result.get('feat-a')!.branch).toBe('task/feat-a')
    expect(result.get('feat-b')!.branch).toBe('task/feat-b')
  })

  it('deduplicates slugs when multiple tasks share the same worktree', async () => {
    existsSyncMock.mockReturnValue(false)

    const tasks = {
      'T1': { worktree: 'shared' },
      'T2': { worktree: 'shared' },
      'T3': { worktree: 'shared' },
    }

    const result = await getWorktreeStatuses('/project', tasks)

    // Only one unique slug, so only one entry
    expect(result.size).toBe(1)
    expect(result.has('shared')).toBe(true)
  })
})
