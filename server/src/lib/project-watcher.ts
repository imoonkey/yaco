import { watch, existsSync, type FSWatcher } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Project } from './projects'
import { emitRefresh } from './notify'

const DEBOUNCE_MS = 200

const watchers: FSWatcher[] = []
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Ignore patterns — no refresh signal for these */
const IGNORE = [
  /^\.git\/objects\//,
  /^\.git\/logs\//,
  /node_modules\//,
  /\.DS_Store$/,
]

/** Route a filename to a refresh channel */
function routeChange(filename: string): string | null {
  if (IGNORE.some(re => re.test(filename))) return null

  if (/^\.multmux\/[^/]+\.json$/.test(filename)) return 'sessions'
  if (/^doc\/todo\/[^/]+\/workstream\.json$/.test(filename)) return 'workstreams'
  if (/^\.git\//.test(filename)) return 'git'

  return 'filetree'
}

function debouncedEmit(channel: string): void {
  const existing = debounceTimers.get(channel)
  if (existing) clearTimeout(existing)
  debounceTimers.set(channel, setTimeout(() => {
    debounceTimers.delete(channel)
    emitRefresh(channel)
  }, DEBOUNCE_MS))
}

/** Start recursive fs.watch for each project */
export function startProjectWatchers(projects: Project[]): void {
  stopProjectWatchers()

  for (const project of projects) {
    if (!existsSync(project.path)) continue
    try {
      const watcher = watch(project.path, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const channel = routeChange(filename)
        if (channel) {
          debouncedEmit(channel)
          if (channel === 'filetree') debouncedEmit('git')
        }
      })
      watchers.push(watcher)
    } catch (err) {
      console.error(`[project-watcher] failed to watch ${project.path}:`, err)
    }
  }

  // Watch ~/.workflow/projects.json for project list changes
  const projectsFile = join(homedir(), '.workflow', 'projects.json')
  if (existsSync(projectsFile)) {
    try {
      const watcher = watch(projectsFile, () => debouncedEmit('projects'))
      watchers.push(watcher)
    } catch { /* ignore */ }
  }
}

export function stopProjectWatchers(): void {
  for (const w of watchers) w.close()
  watchers.length = 0
  for (const timer of debounceTimers.values()) clearTimeout(timer)
  debounceTimers.clear()
}
