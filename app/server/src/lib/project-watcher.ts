import { watch, existsSync, type FSWatcher } from 'fs'
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import type { Ignore } from 'ignore'
import { loadProjects, type Project } from './projects'
import { emitRefresh } from './notify'
import { getProjectGitignore, clearGitignoreCache } from './gitignore'
import { AGENT_SESSIONS_DIR } from './constants'
import { isPathDescendantOrEqual } from './agent'
import { projectsFile as yacoProjectsFile } from '@yaco/cli/core/paths'

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

async function readSessionPath(stateFile: string): Promise<string | null> {
  try {
    const raw = await readFile(stateFile, 'utf-8')
    const state = JSON.parse(raw) as { sessionPath?: unknown }
    return typeof state.sessionPath === 'string' && state.sessionPath
      ? state.sessionPath
      : null
  } catch {
    return null
  }
}

async function primeSessionPathCache(): Promise<void> {
  sessionPathCache.clear()

  let files: string[]
  try {
    files = (await readdir(AGENT_SESSIONS_DIR)).filter(name => name.endsWith('.json'))
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[project-watcher] failed to prime agent session cache:', e)
    }
    return
  }

  await Promise.all(files.map(async (file) => {
    const sessionPath = await readSessionPath(join(AGENT_SESSIONS_DIR, file))
    if (sessionPath) sessionPathCache.set(file, sessionPath)
  }))
}

async function handleGlobalSessionChange(filename: string): Promise<void> {
  if (!filename.endsWith('.json')) return

  const stateFile = join(AGENT_SESSIONS_DIR, filename)
  const currentSessionPath = await readSessionPath(stateFile)
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

function watchProjectsFile(): void {
  const projectsFile = yacoProjectsFile()
  if (existsSync(projectsFile)) {
    try {
      const watcher = watch(projectsFile, () => debouncedEmit('projects'))
      watcher.on('error', (err) => {
        console.warn(`[project-watcher] projects.json watcher error:`, err)
      })
      watchers.push(watcher)
    } catch (e) { console.warn(`[project-watcher] failed to watch projects.json:`, e) }
  }
}

async function watchAgentSessionsDir(): Promise<void> {
  if (existsSync(AGENT_SESSIONS_DIR)) {
    await primeSessionPathCache()
    try {
      const watcher = watch(AGENT_SESSIONS_DIR, (_event, filename) => {
        if (!filename) {
          // macOS FSEvents may deliver null filename on deletion — emit blanket refresh
          debouncedEmit('sessions')
          return
        }
        void handleGlobalSessionChange(String(filename)).catch(err => {
          console.warn(`[project-watcher] failed to handle agent session change ${String(filename)}:`, err)
        })
      })
      watcher.on('error', (err) => {
        console.warn(`[project-watcher] sessions watcher error:`, err)
      })
      watchers.push(watcher)
    } catch (e) {
      console.warn(`[project-watcher] failed to watch ${AGENT_SESSIONS_DIR}:`, e)
    }
  }
}

/** Start recursive fs.watch for each project */
export async function startProjectWatchers(projects: Project[]): Promise<void> {
  stopProjectWatchers()

  // Register small, high-value global watchers before recursive project
  // watchers, which can consume many inotify slots in large workspaces.
  watchProjectsFile()
  await watchAgentSessionsDir()

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
      watcher.on('error', (err) => {
        console.warn(`[project-watcher] watcher error for ${project.path}:`, err)
      })
      watchers.push(watcher)
    } catch (err) {
      console.error(`[project-watcher] failed to watch ${project.path}:`, err)
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
