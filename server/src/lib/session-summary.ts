import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import Database from 'better-sqlite3'

export interface SummaryResult {
  summary: string
  messageCount?: number
}

/** Encode a project path the same way Claude Code does: replace `/` with `-` */
function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-')
}

/** Resolve session summary from Claude's sessions-index.json */
function resolveClaudeSummary(sessionId: string, projectPath: string): SummaryResult | null {
  const encoded = encodeProjectPath(projectPath)
  const indexPath = join(homedir(), '.claude', 'projects', encoded, 'sessions-index.json')
  if (!existsSync(indexPath)) return null

  try {
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'))
    const entries: { sessionId: string; firstPrompt?: string; summary?: string; messageCount?: number }[] = data.entries ?? []
    const entry = entries.find(e => e.sessionId === sessionId)
    if (!entry) return null
    const summary = entry.firstPrompt || entry.summary || ''
    if (!summary) return null
    return { summary, messageCount: entry.messageCount }
  } catch {
    return null
  }
}

/** Resolve session summary from Codex's SQLite database */
function resolveCodexSummary(sessionId: string): SummaryResult | null {
  const dbPath = join(homedir(), '.codex', 'state_5.sqlite')
  if (!existsSync(dbPath)) return null

  try {
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare('SELECT title, first_user_message FROM threads WHERE id = ?').get(sessionId) as
      { title: string | null; first_user_message: string | null } | undefined
    db.close()
    if (!row) return null
    const summary = row.title || row.first_user_message || ''
    if (!summary) return null
    return { summary }
  } catch {
    return null
  }
}

/** PID fallback for Claude: scan ~/.claude/sessions/*.json to find sessionId by PID */
function resolveClaudeSessionIdByPid(pid: number): string | null {
  const sessionsDir = join(homedir(), '.claude', 'sessions')
  if (!existsSync(sessionsDir)) return null

  try {
    for (const file of readdirSync(sessionsDir).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'))
        if (data.pid === pid && data.sessionId) return data.sessionId
      } catch { continue }
    }
  } catch { /* ignore */ }
  return null
}

/** Resolve a session summary given session metadata */
export function resolveSessionSummary(
  sessionId: string,
  pid: number,
  provider: 'claude' | 'codex',
  projectPath: string,
): SummaryResult | null {
  let id = sessionId

  // PID fallback for Claude when sessionId is empty
  if (!id && provider === 'claude') {
    id = resolveClaudeSessionIdByPid(pid) ?? ''
  }
  if (!id) return null

  const result = provider === 'claude'
    ? resolveClaudeSummary(id, projectPath)
    : resolveCodexSummary(id)

  if (!result) return null

  // Truncate to 120 chars
  if (result.summary.length > 120) {
    result.summary = result.summary.slice(0, 117) + '...'
  }
  return result
}
