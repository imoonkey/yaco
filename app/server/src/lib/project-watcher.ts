import { watch, existsSync, type FSWatcher, type Stats } from 'fs'
import { readFile, readdir } from 'fs/promises'
import { join, relative, sep } from 'path'
import chokidar from 'chokidar'
import type { FSWatcher as ChokidarWatcher } from 'chokidar'
import type { Ignore } from 'ignore'
import { loadProjects, type Project } from './projects'
import { emitRefresh } from './notify'
import { getProjectGitignore, clearGitignoreCache } from './gitignore'
import { AGENT_SESSIONS_DIR } from './constants'
import { isPathDescendantOrEqual } from './agent'
import { notifyAttentionSessionChange, notifyAttentionTaskChange } from './attention-runtime'
import { projectsFile as yacoProjectsFile, readYacoProjectPaths } from '@yaco/cli/core/paths'

const DEBOUNCE_MS = 200
/** How often to retry arming the sessions-dir watcher when the dir is absent at
 *  startup (the agent runtime creates it on first session — without re-arming,
 *  the change-driven engine would have a cold-start blind spot, R3). */
const SESSIONS_DIR_REARM_MS = 1_000
/** Upper bound on waiting for a project's chokidar initial scan to complete, so
 *  a slow or pathological tree can never hang server startup. */
const WATCHER_READY_TIMEOUT_MS = 10_000

// Small, high-value global watchers (projects.json, agent sessions dir).
const globalWatchers: FSWatcher[] = []
/** Pending retry to arm the sessions-dir watcher when it was absent at startup. */
let sessionsDirRearmTimer: ReturnType<typeof setTimeout> | null = null
// Per-project recursive watchers, keyed by project path so a project can be
// watched/unwatched incrementally as it is registered/removed at runtime.
const projectWatchers = new Map<string, ChokidarWatcher>()
// Generation per path whose watcher is mid-arming (gitignore load + initial scan
// in flight). A monotonic token lets a stale in-flight watchProject detect that a
// newer arm (or an unwatch) superseded it, so its `finally` never clears a newer
// arm's flag and a quick unwatch/re-watch can't leave the project unwatched.
const armGeneration = new Map<string, number>()
let armSeq = 0
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const projectIgnores = new Map<string, Ignore | null>()
// Per-project matcher for task-graph files, derived from each project's configured
// `yaco.toml [paths].tasks` (default `plan/tasks`) so custom task locations also
// drive the `tasks` channel — not just the default path.
const projectTaskFileRe = new Map<string, RegExp>()
const sessionPathCache = new Map<string, string>()

/** Ignore patterns — no refresh signal for these */
const IGNORE = [
  /^\.git\/objects\//,
  /^\.git\/logs\//,
  /node_modules\//,
  /\.DS_Store$/,
]

/** Repo-relative POSIX path of `absPath` under `projectPath`, or null when
 *  `absPath` is the project root itself (chokidar tests the root too). */
function toRel(projectPath: string, absPath: string): string | null {
  const rel = relative(projectPath, absPath)
  if (!rel || rel.startsWith('..')) return null
  return sep === '/' ? rel : rel.split(sep).join('/')
}

/** Stat-free prune verdict: `true` prune, `false` force-keep, `undefined` defer
 *  to the gitignore check. `node_modules` and git `objects/`/`logs/` are matched
 *  by path SEGMENT so nested copies (a worktree's own node_modules, a submodule's
 *  .git) are caught at any depth; `.git` metadata (HEAD/index/refs) is kept for
 *  the `git` channel. The whole `.worktrees` subtree is force-kept — it is
 *  gitignored, but the app serves per-worktree filetree/git, so it must stay
 *  watched (its node_modules/.git are still pruned by the rules above). */
export function hardVerdict(rel: string): boolean | undefined {
  const segs = rel.split('/')
  if (segs.includes('node_modules')) return true
  if (rel.endsWith('.DS_Store')) return true
  const gitIdx = segs.indexOf('.git')
  if (gitIdx !== -1) {
    const sub = segs[gitIdx + 1]
    return sub === 'objects' || sub === 'logs'
  }
  if (rel === '.worktrees' || rel.startsWith('.worktrees/')) return false
  return undefined
}

/** chokidar `ignored` predicate: prunes a directory from the recursive walk so
 *  it never receives an inotify watch. This is the fix for inotify exhaustion —
 *  `node_modules`, git internals, and every gitignored tree (build output, logs,
 *  data dumps) are skipped at the OS level, not merely filtered out of events.
 *
 *  chokidar calls this with (path) then (path, stats). Gitignore semantics need
 *  directory-vs-file (a `dir/` pattern and a `!dir/` negation only resolve with
 *  a trailing slash), so the gitignore decision is deferred to the stats-bearing
 *  call rather than pruning a path that may be an explicitly unignored directory.
 *  The stat-free hard rules still prune the heavy trees immediately.
 */
function makeIgnored(projectPath: string): (absPath: string, stats?: Stats) => boolean {
  return (absPath: string, stats?: Stats): boolean => {
    const rel = toRel(projectPath, absPath)
    if (rel === null) return false // the project root — always walk it
    const hard = hardVerdict(rel)
    if (hard !== undefined) return hard
    if (!stats) return false // defer the gitignore decision to the stats call
    const ig = projectIgnores.get(projectPath)
    return !!ig && ig.ignores(stats.isDirectory() ? rel + '/' : rel)
  }
}

/** Route a filename to a refresh channel */
function routeChange(filename: string): string | null {
  if (IGNORE.some(re => re.test(filename))) return null

  if (/^\.worktrees\/[^/]+$/.test(filename)) return 'worktrees'
  if (/^\.worktrees\//.test(filename)) return 'filetree'
  if (/^\.git\//.test(filename)) return 'git'

  return 'filetree'
}

/** Build a matcher for a project's repo-relative tasks path. A configured tasks
 *  *directory* matches nested `*.json`; a `*.json` file path matches itself. The
 *  `(^|/)` anchor also catches the same path nested inside a worktree. */
function taskFileMatcher(tasksRel: string): RegExp {
  const escaped = tasksRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return tasksRel.endsWith('.json')
    ? new RegExp(`(^|/)${escaped}$`)
    : new RegExp(`(^|/)${escaped}/.*\\.json$`)
}

/** Fallback matcher for the default `plan/tasks` location. */
const DEFAULT_TASK_FILE_RE = taskFileMatcher('plan/tasks')

/** Resolve and cache a project's task-file matcher from its `yaco.toml`. Synchronous
 *  + guarded so a missing/malformed config never aborts watcher setup. */
function armTaskFileMatcher(projectPath: string): void {
  try {
    projectTaskFileRe.set(projectPath, taskFileMatcher(readYacoProjectPaths(projectPath).tasks))
  } catch (e) {
    console.warn(`[project-watcher] failed to read tasks path for ${projectPath}, using default:`, e)
    projectTaskFileRe.set(projectPath, DEFAULT_TASK_FILE_RE)
  }
}

/** True when a changed repo-relative filename is a task-graph file for `projectPath`
 *  (its configured `[paths].tasks`, default `plan/tasks/**`). A task-state write must
 *  wake the attention engine so `task_done`/`task_blocked` edges are change-driven
 *  (not 60s-sampled), and drives the dedicated `tasks` SSE channel. */
function isTaskFile(filename: string, projectPath: string): boolean {
  return (projectTaskFileRe.get(projectPath) ?? DEFAULT_TASK_FILE_RE).test(filename)
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

/** Resolve once chokidar finishes its initial scan, or after a bounded timeout
 *  so a slow tree never hangs startup. Until 'ready', chokidar reports nothing —
 *  awaiting it gives callers the old fs.watch guarantee: once watchProject
 *  resolves, subsequent writes are observed. Both paths tear down their own
 *  listener/timer so neither leaks. */
function awaitWatcherReady(watcher: ChokidarWatcher): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const onReady = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      watcher.removeListener('ready', onReady)
      resolve()
    }, WATCHER_READY_TIMEOUT_MS)
    timer.unref?.()
    watcher.once('ready', onReady)
  })
}

/** Start a pruned recursive watcher for a single project (idempotent per path).
 *  Lets a project registered at runtime get live file-tree/git SSE without a
 *  server restart. The project's gitignore is loaded BEFORE the watcher is
 *  created so chokidar's `ignored` predicate can prune gitignored + heavy dirs
 *  during the initial walk — they never consume an inotify watch. Resolves only
 *  after the initial scan completes, so callers can rely on later writes firing. */
export async function watchProject(project: Project): Promise<void> {
  const path = project.path
  if (projectWatchers.has(path) || armGeneration.has(path) || !existsSync(path)) return
  const gen = ++armSeq
  armGeneration.set(path, gen)

  try {
    armTaskFileMatcher(path)
    // Load the gitignore first so the `ignored` predicate prunes from the very
    // first walk. A failed load → no gitignore filtering (heavy hard-coded dirs
    // are still pruned), never a missed watch.
    const ig = await getProjectGitignore(path).catch(() => null)
    // Superseded by a newer arm / unwatch, or already watching, while we awaited.
    if (armGeneration.get(path) !== gen || projectWatchers.has(path)) return
    projectIgnores.set(path, ig)

    let watcher: ChokidarWatcher
    try {
      watcher = chokidar.watch(path, {
        ignored: makeIgnored(path),
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        ignorePermissionErrors: true,
      })
    } catch (err) {
      console.error(`[project-watcher] failed to watch ${path}:`, err)
      projectIgnores.delete(path)
      return
    }

    watcher.on('all', (_event, absPath) => {
      const filename = toRel(path, String(absPath))
      if (!filename) return
      const channel = routeChange(filename)
      if (!channel) return

      // Reload gitignore when .gitignore itself changes (affects future pruning
      // decisions + the event filter below). Note: already-pruned dirs that a
      // change unignores are not retroactively watched until the next restart.
      if (filename === '.gitignore') {
        clearGitignoreCache(path)
        void getProjectGitignore(path).then(newIg => {
          if (projectWatchers.has(path)) projectIgnores.set(path, newIg)
        }).catch(() => undefined)
      }

      // Defense in depth: a gitignored file inside a watched dir still gets no SSE.
      const currentIg = projectIgnores.get(path)
      if (currentIg && channel === 'filetree' && currentIg.ignores(filename)) return

      debouncedEmit(channel)
      if (channel === 'filetree') debouncedEmit('git')

      // Task-graph writes get a dedicated 'tasks' channel so the Task Graph view
      // refreshes on task edits only — not on every unrelated file write, which
      // would refetch the full task payload and rebuild the whole graph. It also
      // wakes the change-driven attention engine (a write may be a task_done /
      // task_blocked state edge). plan/tasks/** is not gitignored, so both fire
      // regardless of the ignore check above.
      if (isTaskFile(filename, path)) {
        debouncedEmit('tasks')
        notifyAttentionTaskChange()
      }
    })
    watcher.on('error', (err) => {
      console.warn(`[project-watcher] watcher error for ${path}:`, err)
    })
    projectWatchers.set(path, watcher)
    await awaitWatcherReady(watcher)
  } finally {
    if (armGeneration.get(path) === gen) armGeneration.delete(path)
  }
}

/** Stop watching a single project (e.g. when it is removed from the registry). */
export function unwatchProject(path: string): void {
  armGeneration.delete(path) // abort an in-flight arm
  const watcher = projectWatchers.get(path)
  if (watcher) {
    void watcher.close()
    projectWatchers.delete(path)
  }
  projectIgnores.delete(path)
  projectTaskFileRe.delete(path)
}

/** Start pruned recursive watchers for each project */
export async function startProjectWatchers(projects: Project[]): Promise<void> {
  stopProjectWatchers()

  // Register small, high-value global watchers before per-project watchers.
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
  armGeneration.clear()
  for (const w of projectWatchers.values()) void w.close()
  projectWatchers.clear()
  for (const timer of debounceTimers.values()) clearTimeout(timer)
  debounceTimers.clear()
  projectIgnores.clear()
  projectTaskFileRe.clear()
  sessionPathCache.clear()
}
