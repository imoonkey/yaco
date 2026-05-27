import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const { homeDir } = vi.hoisted(() => ({ homeDir: { value: '' } }))

vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => homeDir.value, tmpdir: actual.tmpdir }
})

// Fix homeDir before module import (PROJECTS_FILE is resolved at load time)
homeDir.value = await mkdtemp(join(tmpdir(), 'workflow-projects-test-'))
await mkdir(join(homeDir.value, '.yaco'), { recursive: true })

const { loadProjects, saveProjects } = await import('../projects')
const projectsFile = join(homeDir.value, '.yaco', 'projects.json')

describe('projects: trailing-slash normalization', () => {
  beforeEach(async () => {
    await rm(projectsFile, { force: true })
  })
  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  it('strips trailing slashes when loading', async () => {
    await writeFile(projectsFile, JSON.stringify([
      { name: 'a', path: '/tmp/a/' },
      { name: 'b', path: '/tmp/b///' },
      { name: 'c', path: '/tmp/c' },
    ]), 'utf-8')

    expect(await loadProjects()).toEqual([
      { name: 'a', path: '/tmp/a' },
      { name: 'b', path: '/tmp/b' },
      { name: 'c', path: '/tmp/c' },
    ])
  })

  it('strips trailing slashes when saving', async () => {
    await saveProjects([{ name: 'x', path: '/tmp/x/' }])
    expect(JSON.parse(await readFile(projectsFile, 'utf-8'))).toEqual([{ name: 'x', path: '/tmp/x' }])
  })
})
