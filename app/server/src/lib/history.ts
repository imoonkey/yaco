import { readdir, readFile, stat, open } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { encodeProjectPath, getCodexDb } from './session-summary'
import { PENDING_SESSION_ID } from './constants'
import type { MultmuxSession } from './agent'

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
/** Max bytes to read from tail of each JSONL for last custom-title / timestamp. */
const TAIL_BYTES = 65536

/** Read Claude session history from JSONL files + optional sessions-index.json.
 *  Optimized: reads only head (summary) + tail (title) of each file. */
export async function getClaudeHistory(projectPath: string): Promise<HistorySession[]> {
  const encoded = encodeProjectPath(projectPath)
  const projectDir = join(homedir(), '.claude', 'projects', encoded)

  let jsonlFiles: string[]
  try {
    jsonlFiles = (await readdir(projectDir)).filter(f => f.endsWith('.jsonl'))
  } catch { return [] }
  if (jsonlFiles.length === 0) return []

  const indexMap = await loadClaudeIndex(projectDir)

  const sessions = await Promise.all(jsonlFiles.map(async (file): Promise<HistorySession | null> => {
    const sessionId = file.replace(/\.jsonl$/, '')
    const indexEntry = indexMap.get(sessionId)
    if (indexEntry?.isSidechain) return null

    const filePath = join(projectDir, file)
    let created: string
    let modified: string
    let size: number
    try {
      const st = await stat(filePath)
      created = (st.birthtime ?? st.ctime).toISOString()
      modified = st.mtime.toISOString()
      size = st.size
    } catch { return null }

    let title: string | null = null
    let summary: string | null = null
    let createdFromLog: string | null = null
    let modifiedFromLog: string | null = null
    try {
      const fh = await open(filePath, 'r')
      try {
        const headBuf = Buffer.alloc(HEAD_BYTES)
        const headRes = await fh.read(headBuf, 0, Math.min(HEAD_BYTES, size), 0)
        const head = headBuf.toString('utf-8', 0, headRes.bytesRead)
        summary = parseFirstUserMessage(head)
        createdFromLog = parseFirstTimestamp(head)
        modifiedFromLog = parseLastTimestamp(head)

        if (size > TAIL_BYTES) {
          const tailBuf = Buffer.alloc(TAIL_BYTES)
          const tailRes = await fh.read(tailBuf, 0, TAIL_BYTES, size - TAIL_BYTES)
          const tail = tailBuf.toString('utf-8', 0, tailRes.bytesRead)
          title = parseLastTitle(tail)
          modifiedFromLog = parseLastTimestamp(tail) ?? modifiedFromLog
        }
        if (!title) title = parseLastTitle(head)
      } finally {
        await fh.close()
      }
    } catch { /* skip unreadable files */ }

    return {
      id: sessionId,
      provider: 'claude' as const,
      title,
      summary: indexEntry?.summary || summary || '(no prompt)',
      created: indexEntry?.created || createdFromLog || created,
      modified: indexEntry?.modified || modifiedFromLog || modified,
      messageCount: indexEntry?.messageCount ?? null,
      gitBranch: indexEntry?.gitBranch ?? null,
      liveSessionName: null,
    }
  }))

  return sessions.filter((s): s is HistorySession => s !== null)
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

function parseEntryTimestamp(line: string): string | null {
  if (!line.includes('"timestamp"')) return null
  try {
    const entry = JSON.parse(line)
    return typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp))
      ? entry.timestamp
      : null
  } catch { return null }
}

/** Parse the first top-level timestamp from a chunk of JSONL text. */
function parseFirstTimestamp(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!line) continue
    const timestamp = parseEntryTimestamp(line)
    if (timestamp) return timestamp
  }
  return null
}

/** Parse the last top-level timestamp from a chunk of JSONL text. */
function parseLastTimestamp(text: string): string | null {
  let timestamp: string | null = null
  for (const line of text.split('\n')) {
    if (!line) continue
    timestamp = parseEntryTimestamp(line) ?? timestamp
  }
  return timestamp
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
async function loadClaudeIndex(projectDir: string): Promise<Map<string, ClaudeIndexEntry>> {
  const map = new Map<string, ClaudeIndexEntry>()
  const indexPath = join(projectDir, 'sessions-index.json')

  let raw: string
  try {
    raw = await readFile(indexPath, 'utf-8')
  } catch { return map }

  try {
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
export async function getCodexHistory(projectPath: string): Promise<HistorySession[]> {
  projectPath = projectPath.replace(/\/+$/, '')
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
  const threadNameMap = await loadCodexThreadNames()

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
async function loadCodexThreadNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const indexPath = join(homedir(), '.codex', 'session_index.jsonl')

  let content: string
  try {
    content = await readFile(indexPath, 'utf-8')
  } catch { return map }

  for (const line of content.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      if (entry.id && entry.thread_name) {
        map.set(entry.id, entry.thread_name)
      }
    } catch { continue }
  }

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
export async function getHistory(
  projectPath: string,
  liveSessions: MultmuxSession[],
): Promise<HistorySession[]> {
  const [claude, codex] = await Promise.all([
    getClaudeHistory(projectPath),
    getCodexHistory(projectPath),
  ])
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
