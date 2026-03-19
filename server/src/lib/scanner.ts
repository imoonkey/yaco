import { readFile, readdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { Project } from './projects'

export type WorkstreamStatus = 'active' | 'human_review' | 'blocked' | 'parked' | 'done'
export type ProgressType = 'info' | 'human_review' | 'blocked'
export type ProgressStatus = 'active' | 'dismissed'

export interface Checkpoint {
  label: string
  done: boolean
  need_human_review?: boolean
}

export interface WorkstreamData {
  status: WorkstreamStatus
  doc?: string
  checkpoints?: Checkpoint[]
}

export interface WorkstreamInfo {
  id: string
  name: string
  project: string
  projectPath: string
  status: WorkstreamStatus
  doc?: string
  checkpoints: Checkpoint[]
}

export interface ProgressEntry {
  id: string
  agent: 'claude' | 'codex'
  type: ProgressType
  message: string
  timestamp: string
  status: ProgressStatus
}

export interface ProgressEntryWithContext extends ProgressEntry {
  project: string
  workstream: string
}

// Simple per-file lock to prevent concurrent read-modify-write races
const fileLocks = new Map<string, Promise<void>>()

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
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

/** Scan a single project for workstreams */
async function scanProject(project: Project): Promise<WorkstreamInfo[]> {
  const todoDir = join(project.path, 'doc', 'todo')
  if (!existsSync(todoDir)) return []

  const entries = await readdir(todoDir, { withFileTypes: true })
  const results: WorkstreamInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const wsFile = join(todoDir, entry.name, 'workstream.json')
    if (!existsSync(wsFile)) continue

    try {
      const raw = await readFile(wsFile, 'utf-8')
      const data: WorkstreamData = JSON.parse(raw)
      results.push({
        id: entry.name,
        name: entry.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        project: project.name,
        projectPath: project.path,
        status: data.status,
        doc: data.doc,
        checkpoints: data.checkpoints ?? [],
      })
    } catch {
      // skip malformed workstream.json
    }
  }
  return results
}

/** Scan all projects for workstreams */
export async function scanWorkstreams(projects: Project[]): Promise<WorkstreamInfo[]> {
  const all = await Promise.all(projects.map(scanProject))
  return all.flat()
}

/** Read progress.json for a specific workstream */
async function readProgress(project: Project, workstreamId: string): Promise<ProgressEntryWithContext[]> {
  const file = join(project.path, 'doc', 'todo', workstreamId, 'progress.json')
  if (!existsSync(file)) return []

  try {
    const raw = await readFile(file, 'utf-8')
    const entries: ProgressEntry[] = JSON.parse(raw)
    return entries.map(e => ({
      ...e,
      project: project.name,
      workstream: workstreamId,
    }))
  } catch {
    return []
  }
}

/** Scan all projects for all progress entries */
export async function scanProgress(projects: Project[]): Promise<ProgressEntryWithContext[]> {
  const all: ProgressEntryWithContext[] = []

  for (const project of projects) {
    const todoDir = join(project.path, 'doc', 'todo')
    if (!existsSync(todoDir)) continue

    const entries = await readdir(todoDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const progressFile = join(todoDir, entry.name, 'progress.json')
      if (!existsSync(progressFile)) continue
      const items = await readProgress(project, entry.name)
      all.push(...items)
    }
  }

  all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return all
}

/** Update workstream status (with file lock) */
export async function updateWorkstreamStatus(
  projectPath: string,
  workstreamId: string,
  status: WorkstreamStatus
): Promise<void> {
  const wsFile = join(projectPath, 'doc', 'todo', workstreamId, 'workstream.json')
  await withFileLock(wsFile, async () => {
    const raw = await readFile(wsFile, 'utf-8')
    const data: WorkstreamData = JSON.parse(raw)
    data.status = status
    await writeFile(wsFile, JSON.stringify(data, null, 2), 'utf-8')
  })
}

/** Dismiss a progress entry (with file lock) */
export async function dismissProgress(
  projectPath: string,
  workstreamId: string,
  entryId: string
): Promise<void> {
  const file = join(projectPath, 'doc', 'todo', workstreamId, 'progress.json')
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
