import { watch, type FSWatcher } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import type { Project } from './projects'
import { emitNotification } from './notify'
import type { ProgressEntry, ProgressType } from './scanner'

type ChangeCallback = (project: string, workstream: string, entries: ProgressEntry[]) => void

const watchers: FSWatcher[] = []

/** Track last known entry count per file to detect new entries */
const lastCounts = new Map<string, number>()

const TYPE_LABELS: Record<ProgressType, string> = {
  blocked: 'BLOCKED',
  human_review: 'REVIEW',
  info: 'INFO',
  session_idle: 'IDLE',
}

/** Start watching all progress.json files across projects */
export async function startWatching(projects: Project[], onChange: ChangeCallback): Promise<void> {
  stopWatching()

  for (const project of projects) {
    const todoDir = join(project.path, 'doc', 'todo')
    if (!existsSync(todoDir)) continue

    // Watch project-level progress.json
    const projectProgress = join(todoDir, 'progress.json')
    watchProgressFile(projectProgress, project.name, '', onChange)

    // Watch workstream-level progress.json files
    const entries = await readdir(todoDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const progressFile = join(todoDir, entry.name, 'progress.json')
      watchProgressFile(progressFile, project.name, entry.name, onChange)
    }
  }
}

function watchProgressFile(
  progressFile: string,
  projectName: string,
  workstream: string,
  onChange: ChangeCallback,
): void {
  if (!existsSync(progressFile)) {
    // For project-level files that don't exist yet, watch the parent dir
    // so we detect when the poller creates it
    if (!workstream) {
      const todoDir = progressFile.replace(/\/progress\.json$/, '')
      if (existsSync(todoDir)) {
        const dirWatcher = watch(todoDir, (_, filename) => {
          if (filename === 'progress.json' && existsSync(progressFile)) {
            dirWatcher.close()
            const idx = watchers.indexOf(dirWatcher)
            if (idx >= 0) watchers.splice(idx, 1)
            initAndWatch(progressFile, projectName, workstream, onChange)
          }
        })
        watchers.push(dirWatcher)
      }
    }
    return
  }

  initAndWatch(progressFile, projectName, workstream, onChange)
}

async function initAndWatch(
  progressFile: string,
  projectName: string,
  workstream: string,
  onChange: ChangeCallback,
): Promise<void> {
  // Initialize count BEFORE installing the watcher to avoid re-notifying old entries
  try {
    const raw = await readFile(progressFile, 'utf-8')
    const data: ProgressEntry[] = JSON.parse(raw)
    lastCounts.set(progressFile, data.length)
  } catch {
    lastCounts.set(progressFile, 0)
  }

  const label = workstream ? `${projectName}/${workstream}` : projectName

  const watcher = watch(progressFile, async () => {
    try {
      const raw = await readFile(progressFile, 'utf-8')
      const data: ProgressEntry[] = JSON.parse(raw)
      const prevCount = lastCounts.get(progressFile) ?? 0

      if (data.length > prevCount) {
        const newEntries = data.slice(prevCount)
        lastCounts.set(progressFile, data.length)

        for (const e of newEntries) {
          if (e.status === 'active') {
            const typeLabel = TYPE_LABELS[e.type] ?? e.type.toUpperCase()
            emitNotification({
              id: `progress:${projectName}:${workstream}:${e.id}`,
              kind: 'progress',
              title: `[${typeLabel}] ${label}`,
              message: e.message,
              timestamp: e.timestamp,
              project: projectName,
              workstream,
              progressType: e.type,
            })
          }
        }

        onChange(projectName, workstream, data)
      } else {
        lastCounts.set(progressFile, data.length)
        onChange(projectName, workstream, data)
      }
    } catch {
      // file might be mid-write
    }
  })

  watchers.push(watcher)
}

export function stopWatching(): void {
  for (const w of watchers) w.close()
  watchers.length = 0
  lastCounts.clear()
}
