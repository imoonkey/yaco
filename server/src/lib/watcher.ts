import { watch, type FSWatcher } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import type { Project } from './projects'
import { notify } from './notify'
import type { ProgressEntry } from './scanner'

type ChangeCallback = (project: string, workstream: string, entries: ProgressEntry[]) => void

const watchers: FSWatcher[] = []

/** Track last known entry count per file to detect new entries */
const lastCounts = new Map<string, number>()

/** Start watching all progress.json files across projects */
export async function startWatching(projects: Project[], onChange: ChangeCallback): Promise<void> {
  stopWatching()

  for (const project of projects) {
    const todoDir = join(project.path, 'doc', 'todo')
    if (!existsSync(todoDir)) continue

    const entries = await readdir(todoDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const progressFile = join(todoDir, entry.name, 'progress.json')
      if (!existsSync(progressFile)) continue

      // Initialize count
      try {
        const raw = await readFile(progressFile, 'utf-8')
        const data: ProgressEntry[] = JSON.parse(raw)
        lastCounts.set(progressFile, data.length)
      } catch {
        lastCounts.set(progressFile, 0)
      }

      const watcher = watch(progressFile, async () => {
        try {
          const raw = await readFile(progressFile, 'utf-8')
          const data: ProgressEntry[] = JSON.parse(raw)
          const prevCount = lastCounts.get(progressFile) ?? 0

          if (data.length > prevCount) {
            // New entries added
            const newEntries = data.slice(prevCount)
            lastCounts.set(progressFile, data.length)

            for (const e of newEntries) {
              if (e.status === 'active') {
                const typeLabel = e.type === 'blocked' ? 'BLOCKED' : e.type === 'human_review' ? 'REVIEW' : 'INFO'
                notify(`[${typeLabel}] ${project.name}/${entry.name}`, e.message)
              }
            }

            onChange(project.name, entry.name, data)
          } else {
            lastCounts.set(progressFile, data.length)
            onChange(project.name, entry.name, data)
          }
        } catch {
          // file might be mid-write
        }
      })

      watchers.push(watcher)
    }
  }
}

export function stopWatching(): void {
  for (const w of watchers) w.close()
  watchers.length = 0
  lastCounts.clear()
}
