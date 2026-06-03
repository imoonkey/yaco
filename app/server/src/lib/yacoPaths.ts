import { readFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { parse as parseToml } from 'smol-toml'

export interface YacoPaths {
  tasks: string
  active: string
  archive: string
  worktrees: string
}

const DEFAULTS: YacoPaths = {
  tasks: 'projects/tasks.json',
  active: 'projects/active',
  archive: 'projects/archive',
  worktrees: '.worktrees',
}

const KEYS: (keyof YacoPaths)[] = ['tasks', 'active', 'archive', 'worktrees']

export function readYacoPaths(repoRoot: string): YacoPaths {
  let raw: string
  try {
    raw = readFileSync(join(repoRoot, 'yaco.toml'), 'utf-8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ...DEFAULTS }
    throw err
  }

  const parsed = parseToml(raw) as Record<string, unknown>
  const paths = (parsed.paths ?? {}) as Record<string, unknown>
  const result: YacoPaths = { ...DEFAULTS }

  for (const key of KEYS) {
    const v = paths[key]
    if (v === undefined) continue
    if (typeof v !== 'string') {
      throw new Error(`yaco.toml: [paths].${key} must be a string`)
    }
    if (isAbsolute(v)) {
      throw new Error(`yaco.toml: [paths].${key} must be repo-relative, got absolute path "${v}"`)
    }
    if (v.split('/').includes('..')) {
      throw new Error(`yaco.toml: [paths].${key} must be repo-relative, got path with ".." segment "${v}"`)
    }
    result[key] = v
  }

  return result
}
