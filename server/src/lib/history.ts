import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { encodeProjectPath, getCodexDb } from './session-summary'
import { PENDING_SESSION_ID } from './constants'
import type { MultmuxSession } from './multmux'

export interface HistorySession {
  id: string
  provider: 'claude' | 'codex'
  title: string | null
  summary: string
  created: string
  modified: string
  messageCount: number | null
  gitBranch: string | null
  liveSessionName: string | null
}

const HISTORY_CAP = 200

// -- Slash-command normalization --

/** Extract <command-args> content from a <command-message> wrapper.
 *  Returns null if not a command-message or args are empty. */
function extractCommandArgs(text: string): string | null {
  if (!text.includes('<command-message>')) return null
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/)
  if (argsMatch) {
    const args = argsMatch[1].trim()
    if (args) return args
  }
  return null
}

/** Extract the command name from a <command-message> wrapper (e.g. "/design"). */
function extractCommandName(text: string): string | null {
  const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/)
  return nameMatch ? nameMatch[1].trim() || null : null
}

/** Check if text is a <command-message> wrapper. */
function isCommandMessage(text: string): boolean {
  return text.includes('<command-message>')
}

/** Extract text content from a JSONL user message entry's content field. */
function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b: { text?: string }) => b.text ?? '').join(' ')
  }
  return ''
}

// -- Claude history --

interface ClaudeIndexEntry {
  sessionId: string
  summary?: string
  messageCount?: number
  gitBranch?: string
  created?: string
  modified?: string
  isSidechain?: boolean
}

/** Max bytes to read from head of each JSONL for first user message. */
const HEAD_BYTES = 16384
/** Max bytes to read from tail of each JSONL for last custom-title. */
const TAIL_BYTES = 8192

/** Read Claude session history from JSONL files + optional sessions-index.json.
 *  Optimized: reads only head (summary) + tail (title) of each file. */
export function getClaudeHistory(projectPath: string): HistorySession[] {
  const encoded = encodeProjectPath(projectPath)
  const projectDir = join(homedir(), '.claude', 'projects', encoded)
  if (!existsSync(projectDir)) return []

  let jsonlFiles: string[]
  try {
    jsonlFiles = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
  } catch { return [] }
  if (jsonlFiles.length === 0) return []

  const indexMap = loadClaudeIndex(projectDir)
  const sessions: HistorySession[] = []

  const headBuf = Buffer.alloc(HEAD_BYTES)
  const tailBuf = Buffer.alloc(TAIL_BYTES)

  for (const file of jsonlFiles) {
    const sessionId = file.replace(/\.jsonl$/, '')
    const indexEntry = indexMap.get(sessionId)
    if (indexEntry?.isSidechain) continue

    const filePath = join(projectDir, file)
    let created: string
    let modified: string
    let size: number
    try {
      const stat = statSync(filePath)
      created = (stat.birthtime ?? stat.ctime).toISOString()
      modified = stat.mtime.toISOString()
      size = stat.size
    } catch { continue }

    // Read head (first user message) and tail (last custom-title) in two reads
    let title: string | null = null
    let summary: string | null = null
    try {
      const fd = openSync(filePath, 'r')
      const headRead = readSync(fd, headBuf, 0, Math.min(HEAD_BYTES, size), 0)
      const head = headBuf.toString('utf-8', 0, headRead)
      summary = parseFirstUserMessage(head)

      // Read tail for custom-title (last-wins)
      if (size > TAIL_BYTES) {
        const tailRead = readSync(fd, tailBuf, 0, TAIL_BYTES, size - TAIL_BYTES)
        title = parseLastTitle(tailBuf.toString('utf-8', 0, tailRead))
      }
      // For small files, head already has everything
      if (!title) title = parseLastTitle(head)
      closeSync(fd)
    } catch { /* skip unreadable files */ }

    sessions.push({
      id: sessionId,
      provider: 'claude',
      title,
      summary: indexEntry?.summary || summary || '(no prompt)',
      created: indexEntry?.created || created,
      modified: indexEntry?.modified || modified,
      messageCount: indexEntry?.messageCount ?? null,
      gitBranch: indexEntry?.gitBranch ?? null,
      liveSessionName: null,
    })
  }

  return sessions
}

/** Parse the last custom-title from a chunk of JSONL text. */
function parseLastTitle(text: string): string | null {
  let title: string | null = null
  for (const line of text.split('\n')) {
    if (!line || !line.includes('custom-title')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle
    } catch { /* partial line at boundary — skip */ }
  }
  return title
}

/** Parse the first user message from head of a JSONL file. */
function parseFirstUserMessage(head: string): string | null {
  let commandName: string | null = null
  for (const line of head.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'user' && entry.message?.content) {
        const raw = extractUserText(entry.message.content).replace(/\s+/g, ' ').trim()
        if (!raw) continue
        if (isCommandMessage(raw)) {
          const args = extractCommandArgs(raw)
          if (args) return args.replace(/\s+/g, ' ').trim()
          if (!commandName) commandName = extractCommandName(raw)
        } else {
          return raw
        }
      }
    } catch { continue }
  }
  return commandName
}

/** Load sessions-index.json as optional enrichment. */
function loadClaudeIndex(projectDir: string): Map<string, ClaudeIndexEntry> {
  const map = new Map<string, ClaudeIndexEntry>()
  const indexPath = join(projectDir, 'sessions-index.json')
  if (!existsSync(indexPath)) return map

  try {
    const raw = readFileSync(indexPath, 'utf-8')
    const data = JSON.parse(raw)
    // Real format: { version, entries: [...] } — but also accept raw array
    const entries = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : []
    for (const entry of entries) {
      if (entry.sessionId) map.set(entry.sessionId, entry)
    }
  } catch { /* index is unreliable, ignore errors */ }

  return map
}

// -- Codex history --

/** Read Codex session history from SQLite + session_index.jsonl. */
export function getCodexHistory(projectPath: string): HistorySession[] {
  const db = getCodexDb()
  if (!db) return []

  let rows: Array<{
    id: string
    title: string | null
    first_user_message: string | null
    created_at: number
    updated_at: number
    git_branch: string | null
  }>

  try {
    rows = db.prepare(
      `SELECT id, title, first_user_message, created_at, updated_at, git_branch
       FROM threads WHERE cwd = ? AND archived = 0
       ORDER BY updated_at DESC`,
    ).all(projectPath) as typeof rows
  } catch (e) {
    console.warn('[history] Codex DB query failed:', e)
    return []
  }

  if (rows.length === 0) return []

  // Load thread_name map from session_index.jsonl (last entry per id wins)
  const threadNameMap = loadCodexThreadNames()

  return rows.map(row => ({
    id: row.id,
    provider: 'codex' as const,
    title: threadNameMap.get(row.id) ?? null,
    summary: row.first_user_message || '(no prompt)',
    created: epochToISO(row.created_at),
    modified: epochToISO(row.updated_at),
    messageCount: null,
    gitBranch: row.git_branch ?? null,
    liveSessionName: null,
  }))
}

/** Load ~/.codex/session_index.jsonl — last entry per id wins (append-only with renames). */
function loadCodexThreadNames(): Map<string, string> {
  const map = new Map<string, string>()
  const indexPath = join(homedir(), '.codex', 'session_index.jsonl')
  if (!existsSync(indexPath)) return map

  try {
    const content = readFileSync(indexPath, 'utf-8')
    for (const line of content.split('\n')) {
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        if (entry.id && entry.thread_name) {
          map.set(entry.id, entry.thread_name)
        }
      } catch { continue }
    }
  } catch { /* file may not exist or be corrupt */ }

  return map
}

/** Convert unix epoch (seconds or milliseconds) to ISO 8601. */
function epochToISO(epoch: number): string {
  // Codex uses seconds (10 digits); detect and convert
  const ms = epoch < 1e12 ? epoch * 1000 : epoch
  return new Date(ms).toISOString()
}

// -- Merged history --

/** Get merged history from Claude + Codex, sorted by modified DESC, capped at 200.
 *  Tags live sessions via sessionId comparison against liveSessions. */
export function getHistory(
  projectPath: string,
  liveSessions: MultmuxSession[],
): HistorySession[] {
  const claude = getClaudeHistory(projectPath)
  const codex = getCodexHistory(projectPath)
  const all = [...claude, ...codex]

  // Sort by modified DESC
  all.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())

  // Cap at 200
  const capped = all.slice(0, HISTORY_CAP)

  // Tag live sessions
  const liveMap = new Map<string, string>()
  for (const s of liveSessions) {
    if (s.sessionId && s.sessionId !== PENDING_SESSION_ID) {
      liveMap.set(s.sessionId, s.name)
    }
  }
  for (const entry of capped) {
    entry.liveSessionName = liveMap.get(entry.id) ?? null
  }

  return capped
}
