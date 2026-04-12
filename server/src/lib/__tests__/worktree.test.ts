import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
const existsSyncMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({ existsSync: existsSyncMock }))

import { extractWorktreeSlug, getWorktreeStatus, getWorktreeStatuses } from '../worktree'

beforeEach(() => {
  vi.clearAllMocks()
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

// --- parseAheadBehind (tested indirectly via getWorktreeStatus) ---
// parseAheadBehind is not exported, so we test it through getWorktreeStatus's behavior

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

  it('returns inactive when directory exists but is not a git worktree', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'rev-parse') cb(new Error('not a git repo'))
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
      if (args[0] === 'rev-parse') cb(null, 'true\n', '')
      else if (args[0] === 'status') cb(null, '', '')
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
      if (args[0] === 'rev-parse') cb(null, 'true\n', '')
      else if (args[0] === 'status') cb(null, ' M src/index.ts\n', '')
      else if (args[0] === 'rev-list') cb(null, '0\t0\n', '')
    })

    const result = await getWorktreeStatus('/project', 'dirty-task')

    expect(result.active).toBe(true)
    expect(result.dirty).toBe(true)
  })

  it('handles git status failure gracefully (dirty defaults to false)', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === 'rev-parse') cb(null, 'true\n', '')
      else if (args[0] === 'status') cb(new Error('git failed'))
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
      if (args[0] === 'rev-parse') cb(null, 'true\n', '')
      else if (args[0] === 'status') cb(null, '', '')
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
      if (args[0] === 'rev-parse') cb(null, 'true\n', '')
      else if (args[0] === 'status') cb(null, '', '')
      else if (args[0] === 'rev-list') cb(null, '10\t3\n', '')
    })

    const result = await getWorktreeStatus('/project', 'parse-test')

    expect(result.behind).toBe(10)
    expect(result.ahead).toBe(3)
  })

  it('passes correct cwd to git commands', async () => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '', '')
    })

    await getWorktreeStatus('/my/project', 'slug')

    // Both calls should use the worktree path as cwd
    for (const call of execFileMock.mock.calls) {
      expect(call[2].cwd).toBe('/my/project/.worktrees/slug')
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
