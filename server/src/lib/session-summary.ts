import { existsSync, readFileSync, readdirSync } from 'fs'
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

/** Read Claude sessions-index.json once, return a map of sessionId → SummaryResult */
function loadClaudeIndex(projectPath: string): Map<string, SummaryResult> {
  const map = new Map<string, SummaryResult>()
  if (!projectPath) return map

  const encoded = encodeProjectPath(projectPath)
  const indexPath = join(homedir(), '.claude', 'projects', encoded, 'sessions-index.json')
  if (!existsSync(indexPath)) return map

  try {
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'))
    for (const entry of data.entries ?? []) {
      if (!entry.sessionId) continue
      const summary = entry.firstPrompt || entry.summary || ''
      if (summary) {
        map.set(entry.sessionId, { summary, messageCount: entry.messageCount })
      }
    }
  } catch { /* ignore */ }
  return map
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
  let pidMap: Map<number, string> | null = null
  if (needsPidFallback.length > 0) {
    pidMap = loadClaudePidMap()
    for (const s of needsPidFallback) {
      const resolved = pidMap.get(s.pid)
      if (resolved) {
        const list = claudeByProject.get(s.project) ?? []
        list.push({ ...s, sessionId: resolved })
        claudeByProject.set(s.project, list)
      }
    }
  }

  // Resolve Claude summaries: one index read per project
  for (const [project, projectSessions] of claudeByProject) {
    const path = projectPaths.get(project)
    if (!path) continue
    const index = loadClaudeIndex(path)
    for (const s of projectSessions) {
      const r = index.get(s.sessionId)
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
