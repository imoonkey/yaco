import { watch, existsSync, type FSWatcher } from 'fs'
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import type { Ignore } from 'ignore'
import { loadProjects, type Project } from './projects'
import { emitRefresh } from './notify'
import { getProjectGitignore, clearGitignoreCache } from './gitignore'
import { AGENT_SESSIONS_DIR } from './constants'
import { isPathDescendantOrEqual } from './agent'
import { notifyAttentionSessionChange, notifyAttentionTaskChange } from './attention-runtime'
import { projectsFile as yacoProjectsFile } from '@yaco/cli/core/paths'

const DEBOUNCE_MS = 200
/** How often to retry arming the sessions-dir watcher when the dir is absent at
 *  startup (the agent runtime creates it on first session — without re-arming,
 *  the change-driven engine would have a cold-start blind spot, R3). */
const SESSIONS_DIR_REARM_MS = 1_000

// Small, high-value global watchers (projects.json, agent sessions dir).
const globalWatchers: FSWatcher[] = []
/** Pending retry to arm the sessions-dir watcher when it was absent at startup. */
let sessionsDirRearmTimer: ReturnType<typeof setTimeout> | null = null
// Per-project recursive watchers, keyed by project path so a project can be
// watched/unwatched incrementally as it is registered/removed at runtime.
const projectWatchers = new Map<string, FSWatcher>()
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

/** True when a changed repo-relative filename is a task-graph file (default
 *  `plan/tasks/**`). A task-state write must wake the attention engine so
 *  `task_done`/`task_blocked` edges are change-driven (not 60s-sampled). The
 *  default path is matched directly; a yaco.toml `[paths].tasks` override is
 *  covered by the engine's 60s safety tick. */
function isTaskFile(filename: string): boolean {
  return /(^|\/)plan\/tasks\/.*\.json$/.test(filename)
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
    // Change-driven attention: a session state-file write may be a status edge
    // (idle/blocked/crashed). The engine debounces + projects + pushes.
    notifyAttentionSessionChange()
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
      globalWatchers.push(watcher)
    } catch (e) { console.warn(`[project-watcher] failed to watch projects.json:`, e) }
  }
}

async function watchAgentSessionsDir(): Promise<void> {
  if (!existsSync(AGENT_SESSIONS_DIR)) {
    // The agent runtime creates the sessions dir on the first session. Without
    // re-arming, a server started before any agent ran would never watch it and
    // the change-driven engine would miss every first write (R3 blind spot).
    // Poll until the dir appears, then arm the real watcher.
    sessionsDirRearmTimer = setTimeout(() => { void watchAgentSessionsDir() }, SESSIONS_DIR_REARM_MS)
    sessionsDirRearmTimer.unref?.()
    return
  }

  if (sessionsDirRearmTimer) { clearTimeout(sessionsDirRearmTimer); sessionsDirRearmTimer = null }
  const wasPrimed = sessionPathCache.size > 0
  await primeSessionPathCache()
  try {
    const watcher = watch(AGENT_SESSIONS_DIR, (_event, filename) => {
      if (!filename) {
        // macOS FSEvents may deliver null filename on deletion — emit blanket refresh
        debouncedEmit('sessions')
        notifyAttentionSessionChange()
        return
      }
      void handleGlobalSessionChange(String(filename)).catch(err => {
        console.warn(`[project-watcher] failed to handle agent session change ${String(filename)}:`, err)
      })
    })
    watcher.on('error', (err) => {
      console.warn(`[project-watcher] sessions watcher error:`, err)
    })
    globalWatchers.push(watcher)
    // A dir armed late (created after startup) may already hold sessions written
    // before fs.watch attached — those writes won't fire an event. Kick a refresh
    // + engine recompute so they aren't missed (the cold-start blind spot, R3).
    if (!wasPrimed && sessionPathCache.size > 0) {
      debouncedEmit('sessions')
      notifyAttentionSessionChange()
    }
  } catch (e) {
    console.warn(`[project-watcher] failed to watch ${AGENT_SESSIONS_DIR}:`, e)
  }
}

/** Start a recursive fs.watch for a single project (idempotent per path). Lets
 *  a project registered at runtime get live file-tree/git SSE without a server
 *  restart. The watcher is installed SYNCHRONOUSLY (before any await) so a
 *  concurrent unwatchProject / duplicate watchProject can't race the gitignore
 *  load and leak a watcher. */
export async function watchProject(project: Project): Promise<void> {
  if (projectWatchers.has(project.path) || !existsSync(project.path)) return

  // No ignore loaded yet → no filtering until the async load below resolves
  // (a few extra refresh events at most, never missed ones).
  projectIgnores.set(project.path, null)

  let watcher: FSWatcher
  try {
    watcher = watch(project.path, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const channel = routeChange(filename)
      if (!channel) return

      // Reload gitignore when .gitignore itself changes
      if (filename === '.gitignore') {
        clearGitignoreCache(project.path)
        void getProjectGitignore(project.path).then(newIg => {
          if (projectWatchers.has(project.path)) projectIgnores.set(project.path, newIg)
        })
      }

      // Skip SSE for filetree changes inside gitignored paths
      const currentIg = projectIgnores.get(project.path)
      if (currentIg && channel === 'filetree' && currentIg.ignores(filename)) return

      debouncedEmit(channel)
      if (channel === 'filetree') debouncedEmit('git')

      // Task-graph writes get a dedicated 'tasks' channel so the Task Graph view
      // refreshes on task edits only — not on every unrelated file write, which
      // would refetch the full task payload and rebuild the whole graph. It also
      // wakes the change-driven attention engine (a write may be a task_done /
      // task_blocked state edge). plan/tasks/** is not gitignored, so both fire
      // regardless of the ignore check above.
      if (isTaskFile(filename)) {
        debouncedEmit('tasks')
        notifyAttentionTaskChange()
      }
    })
  } catch (err) {
    console.error(`[project-watcher] failed to watch ${project.path}:`, err)
    projectIgnores.delete(project.path)
    return
  }
  watcher.on('error', (err) => {
    console.warn(`[project-watcher] watcher error for ${project.path}:`, err)
  })
  projectWatchers.set(project.path, watcher)

  // Load the real gitignore after install; skip if unwatched meanwhile.
  void getProjectGitignore(project.path)
    .then((ig) => { if (projectWatchers.has(project.path)) projectIgnores.set(project.path, ig) })
    .catch(() => undefined)
}

/** Stop watching a single project (e.g. when it is removed from the registry). */
export function unwatchProject(path: string): void {
  const watcher = projectWatchers.get(path)
  if (watcher) {
    watcher.close()
    projectWatchers.delete(path)
  }
  projectIgnores.delete(path)
}

/** Start recursive fs.watch for each project */
export async function startProjectWatchers(projects: Project[]): Promise<void> {
  stopProjectWatchers()

  // Register small, high-value global watchers before recursive project
  // watchers, which can consume many inotify slots in large workspaces.
  watchProjectsFile()
  await watchAgentSessionsDir()

  for (const project of projects) {
    await watchProject(project)
  }
}

export function stopProjectWatchers(): void {
  if (sessionsDirRearmTimer) { clearTimeout(sessionsDirRearmTimer); sessionsDirRearmTimer = null }
  for (const w of globalWatchers) w.close()
  globalWatchers.length = 0
  for (const w of projectWatchers.values()) w.close()
  projectWatchers.clear()
  for (const timer of debounceTimers.values()) clearTimeout(timer)
  debounceTimers.clear()
  projectIgnores.clear()
  sessionPathCache.clear()
}
