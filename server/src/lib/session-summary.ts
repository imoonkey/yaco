import { existsSync, readFileSync, readdirSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import Database from 'better-sqlite3'
import type { MultmuxSession } from './multmux'

export interface SummaryResult {
  summary: string
  messageCount?: number
}

/** Encode a project path the same way Claude Code does: replace `/` with `-` */
function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-')
}

/** Read first user message from Claude session JSONL files.
 *  Returns a resolver function that reads a specific sessionId on demand. */
function makeClaudeResolver(projectPath: string): (sessionId: string) => SummaryResult | null {
  if (!projectPath) return () => null
  const encoded = encodeProjectPath(projectPath)
  const projectDir = join(homedir(), '.claude', 'projects', encoded)
  if (!existsSync(projectDir)) return () => null

  return (sessionId: string) => {
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`)
    if (!existsSync(jsonlPath)) return null

    try {
      // Read file line by line, find first user message
      const content = readFileSync(jsonlPath, 'utf-8')
      for (const line of content.split('\n')) {
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          if (entry.type === 'user' && entry.message?.content) {
            // Extract text from content (can be string or array of blocks)
            const raw = typeof entry.message.content === 'string'
              ? entry.message.content
              : Array.isArray(entry.message.content)
                ? entry.message.content.map((b: { text?: string }) => b.text ?? '').join(' ')
                : ''
            const summary = raw.replace(/\s+/g, ' ').trim()
            if (summary) return { summary }
          }
        } catch { continue }
      }
    } catch { /* ignore */ }
    return null
  }
}

/** Cached Codex database handle (opened once per server lifecycle) */
let codexDb: InstanceType<typeof Database> | null = null
let codexDbPath = ''

function getCodexDb(): InstanceType<typeof Database> | null {
  const dbPath = join(homedir(), '.codex', 'state_5.sqlite')
  if (!existsSync(dbPath)) return null

  // Reuse cached handle, reopen if path changed (shouldn't happen)
  if (codexDb && codexDbPath === dbPath) return codexDb

  try {
    codexDb?.close()
  } catch { /* ignore */ }

  try {
    codexDb = new Database(dbPath, { readonly: true })
    codexDbPath = dbPath
    return codexDb
  } catch {
    return null
  }
}

function resolveCodexSummary(sessionId: string): SummaryResult | null {
  const db = getCodexDb()
  if (!db) return null

  try {
    const row = db.prepare('SELECT title, first_user_message FROM threads WHERE id = ?').get(sessionId) as
      { title: string | null; first_user_message: string | null } | undefined
    if (!row) return null
    const summary = row.title || row.first_user_message || ''
    if (!summary) return null
    return { summary }
  } catch {
    // DB may be stale or locked — drop cached handle and retry next time
    try { codexDb?.close() } catch { /* ignore */ }
    codexDb = null
    return null
  }
}

/** Build a parent→children map from ps output (called once per batch) */
function buildProcessTree(): Map<number, number[]> {
  try {
    const output = execSync('ps -eo pid,ppid', { encoding: 'utf-8' })
    const children = new Map<number, number[]>()
    for (const line of output.trim().split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 2) continue
      const childPid = Number(parts[0])
      const parentPid = Number(parts[1])
      if (!childPid || !parentPid) continue
      const list = children.get(parentPid) ?? []
      list.push(childPid)
      children.set(parentPid, list)
    }
    return children
  } catch {
    return new Map()
  }
}

/** Find all descendant PIDs using a pre-built process tree */
function getDescendants(pid: number, tree: Map<number, number[]>): number[] {
  const result: number[] = []
  const queue = tree.get(pid) ?? []
  while (queue.length > 0) {
    const p = queue.shift()!
    result.push(p)
    queue.push(...(tree.get(p) ?? []))
  }
  return result
}

/** Batch PID fallback for Claude: scan ~/.claude/sessions/*.json once, return pid → sessionId map */
function loadClaudePidMap(): Map<number, string> {
  const map = new Map<number, string>()
  const sessionsDir = join(homedir(), '.claude', 'sessions')
  if (!existsSync(sessionsDir)) return map

  try {
    for (const file of readdirSync(sessionsDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'))
        if (typeof data.pid === 'number' && typeof data.sessionId === 'string' && data.sessionId) {
          map.set(data.pid, data.sessionId)
        }
      } catch { continue }
    }
  } catch { /* ignore */ }
  return map
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s
}

/** Resolve summaries for all sessions in a single batch.
 *  Reads each data source at most once. */
export function resolveSessionSummaries(
  sessions: MultmuxSession[],
  projectPaths: Map<string, string>,
): Map<string, string> {
  const result = new Map<string, string>()
  if (sessions.length === 0) return result

  // Group sessions by project for Claude index reads
  const claudeByProject = new Map<string, MultmuxSession[]>()
  const codexSessions: MultmuxSession[] = []
  const needsPidFallback: MultmuxSession[] = []

  for (const s of sessions) {
    if (s.provider === 'codex') {
      codexSessions.push(s)
    } else {
      if (s.sessionId) {
        const list = claudeByProject.get(s.project) ?? []
        list.push(s)
        claudeByProject.set(s.project, list)
      } else if (typeof s.pid === 'number') {
        needsPidFallback.push(s)
      }
    }
  }

  // PID fallback: scan once for all Claude sessions missing sessionId
  if (needsPidFallback.length > 0) {
    const pidMap = loadClaudePidMap()
    const procTree = buildProcessTree()
    for (const s of needsPidFallback) {
      // Try direct match first, then check descendant processes
      let resolved = pidMap.get(s.pid)
      if (!resolved) {
        for (const descendant of getDescendants(s.pid, procTree)) {
          resolved = pidMap.get(descendant)
          if (resolved) break
        }
      }
      if (resolved) {
        const list = claudeByProject.get(s.project) ?? []
        list.push({ ...s, sessionId: resolved })
        claudeByProject.set(s.project, list)
      }
    }
  }

  // Resolve Claude summaries: one resolver per project
  for (const [project, projectSessions] of claudeByProject) {
    const path = projectPaths.get(project)
    if (!path) continue
    const resolve = makeClaudeResolver(path)
    for (const s of projectSessions) {
      const r = resolve(s.sessionId)
      if (r) result.set(s.name, truncate(r.summary, 120))
    }
  }

  // Resolve Codex summaries
  for (const s of codexSessions) {
    if (!s.sessionId) continue
    const r = resolveCodexSummary(s.sessionId)
    if (r) result.set(s.name, truncate(r.summary, 120))
  }

  return result
}
