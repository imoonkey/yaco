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

describe('projects: on-disk format + trailing-slash normalization', () => {
  beforeEach(async () => {
    await rm(projectsFile, { force: true })
  })
  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  it('reads the new {id, path} on-disk format and surfaces it as Project.name', async () => {
    await writeFile(projectsFile, JSON.stringify([
      { id: 'a', path: '/tmp/a/' },
      { id: 'b', path: '/tmp/b///' },
      { id: 'c', path: '/tmp/c' },
    ]), 'utf-8')

    expect(await loadProjects()).toEqual([
      { name: 'a', path: '/tmp/a' },
      { name: 'b', path: '/tmp/b' },
      { name: 'c', path: '/tmp/c' },
    ])
  })

  it('writes {id, path} to disk (API keeps Project.name)', async () => {
    await saveProjects([{ name: 'x', path: '/tmp/x/' }])
    expect(JSON.parse(await readFile(projectsFile, 'utf-8'))).toEqual([{ id: 'x', path: '/tmp/x' }])
  })

  it('round-trips through save → load with the new on-disk format', async () => {
    await saveProjects([
      { name: 'a', path: '/tmp/a/' },
      { name: 'b', path: '/tmp/b' },
    ])
    expect(await loadProjects()).toEqual([
      { name: 'a', path: '/tmp/a' },
      { name: 'b', path: '/tmp/b' },
    ])
  })
})
