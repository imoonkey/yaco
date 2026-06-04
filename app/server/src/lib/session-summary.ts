import { existsSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import Database from 'better-sqlite3'
import type { MultmuxSession } from './agent'
import { PENDING_SESSION_ID } from './constants'

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')

export interface SummaryResult {
  summary: string
  messageCount?: number
}

function isResolvableSessionId(id: string): boolean {
  return !!id && id !== PENDING_SESSION_ID
}

/** Encode a project path the same way Claude Code does: replace `/` with `-` */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\/+$/, '').replace(/\//g, '-')
}

type ClaudeResolver = (sessionId: string) => Promise<SummaryResult | null>

/** Read first user message from Claude session JSONL files.
 *  Returns a resolver function that reads a specific sessionId on demand. */
function makeClaudeResolver(projectPath: string): ClaudeResolver {
  if (!projectPath) return async () => null
  const encoded = encodeProjectPath(projectPath)
  const projectDir = join(homedir(), '.claude', 'projects', encoded)

  return async (sessionId: string) => {
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`)

    let content: string
    try {
      content = await readFile(jsonlPath, 'utf-8')
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(`[session-summary] failed to read Claude JSONL ${jsonlPath}:`, e)
      }
      return null
    }

    for (const line of content.split('\n')) {
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'user' && entry.message?.content) {
          const raw = typeof entry.message.content === 'string'
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content.map((b: { text?: string }) => b.text ?? '').join(' ')
              : ''
          const summary = raw.replace(/\s+/g, ' ').trim()
          if (summary) return { summary }
        }
      } catch (e) { console.warn(`[session-summary] failed to parse JSONL line in ${jsonlPath}:`, e); continue }
    }
    return null
  }
}

/** Cached Codex database handle (opened once per server lifecycle) */
let codexDb: InstanceType<typeof Database> | null = null
let codexDbPath = ''

export function getCodexDb(): InstanceType<typeof Database> | null {
  const dbPath = join(homedir(), '.codex', 'state_5.sqlite')
  if (!existsSync(dbPath)) return null

  // Reuse cached handle, reopen if path changed (shouldn't happen)
  if (codexDb && codexDbPath === dbPath) return codexDb

  try {
    codexDb?.close()
  } catch (e) { console.warn('[session-summary] failed to close previous Codex DB handle:', e) }

  try {
    codexDb = new Database(dbPath, { readonly: true })
    codexDbPath = dbPath
    return codexDb
  } catch (e) {
    console.warn('[session-summary] failed to open Codex DB:', e)
    return null
  }
}

async function resolveCodexSummary(sessionId: string): Promise<SummaryResult | null> {
  // Primary: SQLite threads table
  const db = getCodexDb()
  if (db) {
    try {
      const row = db.prepare('SELECT title, first_user_message FROM threads WHERE id = ?').get(sessionId) as
        { title: string | null; first_user_message: string | null } | undefined
      if (row) {
        const summary = row.title || row.first_user_message || ''
        if (summary) return { summary }
      }
    } catch (e) {
      console.warn('[session-summary] Codex DB query failed:', e)
      try { codexDb?.close() } catch (closeErr) { console.warn('[session-summary] failed to close Codex DB after error:', closeErr) }
      codexDb = null
    }
  }

  // Fallback: read first user message from rollout JSONL file
  return resolveCodexRolloutSummary(sessionId)
}

/** Find the rollout JSONL file for a Codex session and extract the first real user message. */
async function resolveCodexRolloutSummary(sessionId: string): Promise<SummaryResult | null> {
  // Rollout files: ~/.codex/sessions/YYYY/MM/DD/rollout-...-<sessionId>.jsonl
  // Scan recent date directories (today and 7 days back) to find the file
  const now = new Date()
  for (let daysBack = 0; daysBack <= 7; daysBack++) {
    const d = new Date(now.getTime() - daysBack * 86400000)
    const dayDir = join(CODEX_SESSIONS_DIR, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))

    let files: string[]
    try {
      files = await readdir(dayDir)
    } catch { continue }

    const match = files.find(f => f.includes(sessionId) && f.endsWith('.jsonl'))
    if (!match) continue

    let content: string
    try {
      content = await readFile(join(dayDir, match), 'utf-8')
    } catch { continue }

    // Find the last response_item with role=user — skip system/AGENTS.md context
    let lastUserText = ''
    for (const line of content.split('\n')) {
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        if (entry.type !== 'response_item' || entry.payload?.role !== 'user') continue
        for (const block of entry.payload.content ?? []) {
          if (block.type === 'input_text' && block.text && !block.text.startsWith('#') && !block.text.startsWith('<')) {
            lastUserText = block.text
          }
        }
      } catch { continue }
    }
    if (lastUserText) {
      return { summary: lastUserText.replace(/\s+/g, ' ').trim() }
    }
  }

  return null
}

/** Resolve summaries for all sessions in a single batch.
 *  Reads each data source at most once. */
export async function resolveSessionSummaries(
  sessions: MultmuxSession[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (sessions.length === 0) return result

  // Group Claude sessions by launch path for JSONL resolution.
  const claudeByPath = new Map<string, MultmuxSession[]>()
  const codexSessions: MultmuxSession[] = []

  for (const s of sessions) {
    if (!isResolvableSessionId(s.sessionId)) continue
    if (s.provider === 'codex') {
      codexSessions.push(s)
    } else {
      const list = claudeByPath.get(s.sessionPath) ?? []
      list.push(s)
      claudeByPath.set(s.sessionPath, list)
    }
  }

  // Resolve Claude + Codex summaries in parallel
  const claudeTasks = [...claudeByPath].flatMap(([sessionPath, pathSessions]) => {
    const resolve = makeClaudeResolver(sessionPath)
    return pathSessions.map(async (s) => {
      const r = await resolve(s.sessionId)
      if (r) result.set(s.name, r.summary)
    })
  })

  const codexTasks = codexSessions.map(async (s) => {
    const r = await resolveCodexSummary(s.sessionId)
    if (r) result.set(s.name, r.summary)
  })

  await Promise.all([...claudeTasks, ...codexTasks])
  return result
}
