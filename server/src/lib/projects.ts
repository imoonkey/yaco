import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { getYacoHome, projectsFile } from './yacoHome'

export interface Project {
  name: string
  path: string
}

const PROJECTS_FILE = projectsFile()

function normalizeProject(p: Project): Project {
  return { ...p, path: p.path.replace(/\/+$/, '') || '/' }
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
  const parsed = JSON.parse(raw) as Project[]
  return parsed.map(normalizeProject)
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await ensureYacoHome()
  const normalized = projects.map(normalizeProject)
  await writeFile(PROJECTS_FILE, JSON.stringify(normalized, null, 2), 'utf-8')
}
