import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface Project {
  name: string
  path: string
}

const WORKFLOW_DIR = join(homedir(), '.workflow')
const PROJECTS_FILE = join(WORKFLOW_DIR, 'projects.json')

function normalizeProject(p: Project): Project {
  return { ...p, path: p.path.replace(/\/+$/, '') || '/' }
}

export async function ensureWorkflowDir(): Promise<void> {
  if (!existsSync(WORKFLOW_DIR)) {
    await mkdir(WORKFLOW_DIR, { recursive: true })
  }
}

export async function loadProjects(): Promise<Project[]> {
  await ensureWorkflowDir()
  if (!existsSync(PROJECTS_FILE)) {
    await writeFile(PROJECTS_FILE, '[]', 'utf-8')
    return []
  }
  const raw = await readFile(PROJECTS_FILE, 'utf-8')
  const parsed = JSON.parse(raw) as Project[]
  return parsed.map(normalizeProject)
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await ensureWorkflowDir()
  const normalized = projects.map(normalizeProject)
  await writeFile(PROJECTS_FILE, JSON.stringify(normalized, null, 2), 'utf-8')
}
