import { readFile, readdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { Project } from './projects'

export type ProgressType = 'info' | 'human_review' | 'blocked' | 'session_idle'
export type ProgressStatus = 'active' | 'dismissed'

export interface ProgressEntry {
  id: string
  agent: 'claude' | 'codex'
  type: ProgressType
  message: string
  timestamp: string
  status: ProgressStatus
  sessionName?: string
}

export interface ProgressEntryWithContext extends ProgressEntry {
  project: string
  workstream: string
}

// Simple per-file lock to prevent concurrent read-modify-write races
const fileLocks = new Map<string, Promise<void>>()

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(path) ?? Promise.resolve()
  let resolve: () => void
  const next = new Promise<void>(r => { resolve = r })
  fileLocks.set(path, next)
  await prev
  try {
    return await fn()
  } finally {
    resolve!()
  }
}

/** Read a progress.json file and attach context */
async function readProgressFile(file: string, projectName: string, workstreamId: string): Promise<ProgressEntryWithContext[]> {
  try {
    const raw = await readFile(file, 'utf-8')
    const entries: ProgressEntry[] = JSON.parse(raw)
    return entries.map(e => ({
      ...e,
      project: projectName,
      workstream: workstreamId,
    }))
  } catch (e) {
    console.warn(`[scanner] failed to read progress file ${file}:`, e)
    return []
  }
}

/** Scan all projects for all progress entries */
export async function scanProgress(projects: Project[]): Promise<ProgressEntryWithContext[]> {
  const all: ProgressEntryWithContext[] = []

  for (const project of projects) {
    const projectsDir = join(project.path, 'projects')
    const activeDir = join(projectsDir, 'active')

    // Project-level progress.json (at projects/ root)
    const projectProgress = join(projectsDir, 'progress.json')
    if (existsSync(projectProgress)) {
      const items = await readProgressFile(projectProgress, project.name, '')
      all.push(...items)
    }

    // Bundle-level progress.json files under projects/active/<bundle>/
    if (!existsSync(activeDir)) continue
    const entries = await readdir(activeDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const progressFile = join(activeDir, entry.name, 'progress.json')
      if (!existsSync(progressFile)) continue
      const items = await readProgressFile(progressFile, project.name, entry.name)
      all.push(...items)
    }
  }

  all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return all
}

/** Dismiss a progress entry (with file lock). Empty workstreamId = project-level. */
export async function dismissProgress(
  projectPath: string,
  workstreamId: string,
  entryId: string
): Promise<void> {
  const file = workstreamId
    ? join(projectPath, 'projects', 'active', workstreamId, 'progress.json')
    : join(projectPath, 'projects', 'progress.json')
  await withFileLock(file, async () => {
    const raw = await readFile(file, 'utf-8')
    const entries: ProgressEntry[] = JSON.parse(raw)
    const entry = entries.find(e => e.id === entryId)
    if (entry) {
      entry.status = 'dismissed'
      await writeFile(file, JSON.stringify(entries, null, 2), 'utf-8')
    }
  })
}
