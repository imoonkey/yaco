import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { getYacoHome, projectsFile } from '@yaco/cli/core/paths'

export interface Project {
  name: string
  path: string
}

const PROJECTS_FILE = projectsFile()

interface ProjectRecord {
  id: string
  path: string
}

function normalizeProject(p: ProjectRecord): Project {
  return { name: p.id, path: p.path.replace(/\/+$/, '') || '/' }
}

export async function ensureYacoHome(): Promise<void> {
  const yacoHome = getYacoHome()
  if (!existsSync(yacoHome)) {
    await mkdir(yacoHome, { recursive: true })
  }
}

export async function loadProjects(): Promise<Project[]> {
  await ensureYacoHome()
  if (!existsSync(PROJECTS_FILE)) {
    await writeFile(PROJECTS_FILE, '[]', 'utf-8')
    return []
  }
  const raw = await readFile(PROJECTS_FILE, 'utf-8')
  const parsed = JSON.parse(raw) as ProjectRecord[]
  return parsed.map(normalizeProject)
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await ensureYacoHome()
  const onDisk = projects.map(p => ({
    id: p.name,
    path: p.path.replace(/\/+$/, '') || '/',
  }))
  await writeFile(PROJECTS_FILE, JSON.stringify(onDisk, null, 2), 'utf-8')
}
