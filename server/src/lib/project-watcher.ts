import { watch, existsSync, readFileSync, readdirSync, type FSWatcher } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Ignore } from 'ignore'
import { loadProjects, type Project } from './projects'
import { emitRefresh } from './notify'
import { getProjectGitignore, clearGitignoreCache } from './gitignore'
import { MULTMUX_SESSIONS_DIR } from './constants'
import { isPathDescendantOrEqual } from './multmux'

const DEBOUNCE_MS = 200

const watchers: FSWatcher[] = []
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const projectIgnores = new Map<string, Ignore | null>()
const sessionPathCache = new Map<string, string>()

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

  if (/^doc\/todo\/[^/]+\/workstream\.json$/.test(filename)) return 'workstreams'
  if (/^\.worktrees\/[^/]+$/.test(filename)) return 'worktrees'
  if (/^\.worktrees\//.test(filename)) return 'filetree'
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

function readSessionPath(stateFile: string): string | null {
  try {
    const raw = readFileSync(stateFile, 'utf-8')
    const state = JSON.parse(raw) as { sessionPath?: unknown }
    return typeof state.sessionPath === 'string' && state.sessionPath
      ? state.sessionPath
      : null
  } catch {
    return null
  }
}

function primeSessionPathCache(): void {
  sessionPathCache.clear()
  if (!existsSync(MULTMUX_SESSIONS_DIR)) return

  try {
    for (const file of readdirSync(MULTMUX_SESSIONS_DIR).filter(name => name.endsWith('.json'))) {
      const sessionPath = readSessionPath(join(MULTMUX_SESSIONS_DIR, file))
      if (sessionPath) sessionPathCache.set(file, sessionPath)
    }
  } catch (e) {
    console.warn('[project-watcher] failed to prime multmux session cache:', e)
  }
}

async function handleGlobalSessionChange(filename: string): Promise<void> {
  if (!filename.endsWith('.json')) return

  const stateFile = join(MULTMUX_SESSIONS_DIR, filename)
  const currentSessionPath = existsSync(stateFile) ? readSessionPath(stateFile) : null
  const previousSessionPath = sessionPathCache.get(filename) ?? null

  if (currentSessionPath) {
    sessionPathCache.set(filename, currentSessionPath)
  } else {
    sessionPathCache.delete(filename)
  }

  const sessionPath = currentSessionPath ?? previousSessionPath
  if (!sessionPath) return

  const projects = await loadProjects()
  if (projects.some(project => isPathDescendantOrEqual(sessionPath, project.path))) {
    debouncedEmit('sessions')
  }
}

/** Start recursive fs.watch for each project */
export async function startProjectWatchers(projects: Project[]): Promise<void> {
  stopProjectWatchers()

  for (const project of projects) {
    if (!existsSync(project.path)) continue

    const ig = await getProjectGitignore(project.path)
    projectIgnores.set(project.path, ig)

    try {
      const watcher = watch(project.path, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const channel = routeChange(filename)
        if (!channel) return

        // Reload gitignore when .gitignore itself changes
        if (filename === '.gitignore') {
          clearGitignoreCache(project.path)
          void getProjectGitignore(project.path).then(newIg => {
            projectIgnores.set(project.path, newIg)
          })
        }

        // Skip SSE for filetree changes inside gitignored paths
        const currentIg = projectIgnores.get(project.path)
        if (currentIg && channel === 'filetree' && currentIg.ignores(filename)) return

        debouncedEmit(channel)
        if (channel === 'filetree') debouncedEmit('git')
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
    } catch (e) { console.warn(`[project-watcher] failed to watch projects.json:`, e) }
  }

  if (existsSync(MULTMUX_SESSIONS_DIR)) {
    primeSessionPathCache()
    try {
      const watcher = watch(MULTMUX_SESSIONS_DIR, (_event, filename) => {
        if (!filename) {
          // macOS FSEvents may deliver null filename on deletion — emit blanket refresh
          debouncedEmit('sessions')
          return
        }
        void handleGlobalSessionChange(String(filename)).catch(err => {
          console.warn(`[project-watcher] failed to handle multmux session change ${String(filename)}:`, err)
        })
      })
      watchers.push(watcher)
    } catch (e) {
      console.warn(`[project-watcher] failed to watch ${MULTMUX_SESSIONS_DIR}:`, e)
    }
  }
}

export function stopProjectWatchers(): void {
  for (const w of watchers) w.close()
  watchers.length = 0
  for (const timer of debounceTimers.values()) clearTimeout(timer)
  debounceTimers.clear()
  projectIgnores.clear()
  sessionPathCache.clear()
}
