import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir, realpath } from 'fs/promises'
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

const { loadProjects, saveProjects, addProject, removeProject } = await import('../projects')
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

describe('projects: shared add/remove behavior', () => {
  beforeEach(async () => {
    await rm(projectsFile, { force: true })
  })
  afterAll(async () => {
    await rm(homeDir.value, { recursive: true, force: true })
  })

  async function realDir(name: string): Promise<string> {
    const dir = join(homeDir.value, name)
    await mkdir(dir, { recursive: true })
    return realpath(dir)
  }

  it('add registers a name -> absolute existing directory', async () => {
    const dir = await realDir('alpha')
    expect(addProject({ name: 'alpha', path: dir })).toEqual({ name: 'alpha', path: dir })
    expect(await loadProjects()).toEqual([{ name: 'alpha', path: dir }])
  })

  it('add rejects a non URL-safe name (INVALID)', async () => {
    const dir = await realDir('alpha')
    expect(() => addProject({ name: 'bad name', path: dir })).toThrow(
      expect.objectContaining({ code: 'INVALID' }),
    )
  })

  it('add rejects a non-absolute path (INVALID)', () => {
    expect(() => addProject({ name: 'alpha', path: 'relative/dir' })).toThrow(
      expect.objectContaining({ code: 'INVALID' }),
    )
  })

  it('add rejects a non-existent directory (INVALID)', () => {
    expect(() => addProject({ name: 'alpha', path: join(homeDir.value, 'missing') })).toThrow(
      expect.objectContaining({ code: 'INVALID' }),
    )
  })

  it('add rejects a duplicate name (CONFLICT)', async () => {
    addProject({ name: 'alpha', path: await realDir('a') })
    const dirB = await realDir('b')
    expect(() => addProject({ name: 'alpha', path: dirB })).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
  })

  it('add rejects a duplicate normalized path (CONFLICT)', async () => {
    const dir = await realDir('alpha')
    addProject({ name: 'alpha', path: dir })
    expect(() => addProject({ name: 'beta', path: dir + '/' })).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
  })

  it('add rejects an equivalent absolute path with .. segments (CONFLICT)', async () => {
    const dir = await realDir('alpha')
    addProject({ name: 'alpha', path: dir })
    expect(() => addProject({ name: 'beta', path: join(dir, '..', 'alpha') })).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
  })

  it('add rejects the bare . and .. names (INVALID)', async () => {
    const dir = await realDir('alpha')
    expect(() => addProject({ name: '.', path: dir })).toThrow(
      expect.objectContaining({ code: 'INVALID' }),
    )
    expect(() => addProject({ name: '..', path: dir })).toThrow(
      expect.objectContaining({ code: 'INVALID' }),
    )
  })

  it('add rejects names with leading/trailing whitespace (INVALID, no mutation)', async () => {
    const dir = await realDir('alpha')
    expect(() => addProject({ name: ' alpha ', path: dir })).toThrow(
      expect.objectContaining({ code: 'INVALID' }),
    )
    expect(() => addProject({ name: 'alpha ', path: dir })).toThrow(
      expect.objectContaining({ code: 'INVALID' }),
    )
    expect(await loadProjects()).toEqual([])
  })

  it('add is defensive against non-string name/path (INVALID, not a thrown 500)', async () => {
    const dir = await realDir('alpha')
    expect(() => addProject({ name: 123 as unknown as string, path: dir })).toThrow(
      expect.objectContaining({ code: 'INVALID' }),
    )
    expect(() => addProject({ name: 'alpha', path: 123 as unknown as string })).toThrow(
      expect.objectContaining({ code: 'INVALID' }),
    )
  })

  it('remove removes by name', async () => {
    const alpha = await realDir('a')
    addProject({ name: 'alpha', path: alpha })
    addProject({ name: 'beta', path: await realDir('b') })
    expect(removeProject('alpha')).toEqual({ name: 'alpha', path: alpha })
    expect((await loadProjects()).map((p) => p.name)).toEqual(['beta'])
  })

  it('remove throws NOT_FOUND when the name is missing', () => {
    expect(() => removeProject('ghost')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
  })
})
