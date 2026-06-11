import { describe, it, expect, vi, beforeAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Real git + real fs (no child_process mock) — proves the baseline endpoint
// reads a symlink target's HEAD blob, not the link text. Only the project
// registry is stubbed so the route resolves our temp repo.
let repo: string
let outside: string
vi.mock('../../lib/projects', () => ({
  loadProjects: () => Promise.resolve([{ name: 'p', path: repo }]),
}))

const { gitRoutes } = await import('../git')

function baseline(path: string) {
  return gitRoutes.request(`/p/baseline?path=${encodeURIComponent(path)}`)
}

describe('GET /:project/baseline — real git, symlinks', () => {
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'baseline-repo-'))
    outside = mkdtempSync(join(tmpdir(), 'baseline-outside-'))
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo })
    g('init', '-q')
    g('config', 'user.email', 't@t')
    g('config', 'user.name', 't')

    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'real.txt'), 'line1\nline2\nline3\n')
    symlinkSync(join('src', 'real.txt'), join(repo, 'in-repo.txt'))

    // Symlink to a file that exists but lives outside any git repo.
    writeFileSync(join(outside, 'stray.txt'), 'stray\n')
    symlinkSync(join(outside, 'stray.txt'), join(repo, 'out-of-repo.txt'))

    g('add', '-A')
    g('commit', '-qm', 'init')
  })

  it('returns the symlink target content, not the link text', async () => {
    const res = await baseline('in-repo.txt')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ content: 'line1\nline2\nline3\n', exists: true })
  })

  it('still returns real content for a plain tracked file', async () => {
    const res = await baseline('src/real.txt')
    expect(await res.json()).toEqual({ content: 'line1\nline2\nline3\n', exists: true })
  })

  it('reports a missing baseline when the target is outside any git repo', async () => {
    const res = await baseline('out-of-repo.txt')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ content: '', exists: false })
  })
})
