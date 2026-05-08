import { stat, open, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { encodeProjectPath } from '../session-summary'
import type { MultmuxSession } from '../multmux'

/** A pending agent turn: the JSONL file we're tailing and the byte offset
 *  we started watching from. */
export interface PendingTurn {
  jsonlPath: string
  startSize: number
  provider: 'claude' | 'codex'
}

export interface AgentReply {
  text: string
  /** True if we hit the timeout before the final answer arrived. */
  timedOut: boolean
}

const POLL_MS = 250
const DEFAULT_TIMEOUT_MS = 120_000

/** Resolve the path to a multmux session's structured JSONL log:
 *   - claude: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *   - codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-...-<sessionId>.jsonl */
export async function resolveSessionLog(session: MultmuxSession): Promise<string | null> {
  if (!session.sessionId || session.sessionId.startsWith('pending:')) return null

  if (session.provider === 'claude') {
    const encoded = encodeProjectPath(session.sessionPath)
    const path = join(homedir(), '.claude', 'projects', encoded, `${session.sessionId}.jsonl`)
    return existsSync(path) ? path : null
  }

  // codex: walk YYYY/MM/DD newest-first looking for a file containing the sessionId.
  const root = join(homedir(), '.codex', 'sessions')
  if (!existsSync(root)) return null
  try {
    const years = (await readdir(root)).filter(s => /^\d{4}$/.test(s)).sort().reverse()
    for (const year of years) {
      const yearDir = join(root, year)
      const months = (await readdir(yearDir)).filter(s => /^\d{2}$/.test(s)).sort().reverse()
      for (const month of months) {
        const monthDir = join(yearDir, month)
        const days = (await readdir(monthDir)).filter(s => /^\d{2}$/.test(s)).sort().reverse()
        for (const day of days) {
          const dayDir = join(monthDir, day)
          const files = await readdir(dayDir)
          const hit = files.find(f => f.includes(session.sessionId) && f.endsWith('.jsonl'))
          if (hit) return join(dayDir, hit)
        }
      }
    }
  } catch { /* fall through */ }
  return null
}

/** Record the current size of the session's JSONL — call BEFORE multmux send. */
export async function startTurn(session: MultmuxSession): Promise<PendingTurn | null> {
  const jsonlPath = await resolveSessionLog(session)
  if (!jsonlPath) return null
  let stats
  try { stats = await stat(jsonlPath) } catch { return null }
  return { jsonlPath, startSize: stats.size, provider: session.provider }
}

/** Wait for the session's final assistant answer to be appended to the JSONL,
 *  bounded by timeoutMs. Returns the answer text + whether we timed out. */
export async function awaitFinalReply(
  turn: PendingTurn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<AgentReply> {
  const start = Date.now()
  let lastSize = turn.startSize
  let buffer = ''

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, POLL_MS))

    let stats
    try { stats = await stat(turn.jsonlPath) } catch { continue }
    if (stats.size <= lastSize) continue

    const fh = await open(turn.jsonlPath, 'r')
    try {
      const len = stats.size - lastSize
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, lastSize)
      buffer += buf.toString('utf-8')
    } finally {
      await fh.close()
    }
    lastSize = stats.size

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      if (!raw.trim()) continue
      const text = extractFinalAnswer(raw, turn.provider)
      if (text) return { text, timedOut: false }
    }
  }

  return { text: '', timedOut: true }
}

function extractFinalAnswer(line: string, provider: 'claude' | 'codex'): string | null {
  let entry: unknown
  try { entry = JSON.parse(line) } catch { return null }
  if (!entry || typeof entry !== 'object') return null

  if (provider === 'codex') {
    const e = entry as { type?: string, payload?: { type?: string, phase?: string, message?: unknown } }
    const p = e.payload
    if (e.type === 'event_msg' && p?.type === 'agent_message' && p.phase === 'final_answer') {
      return typeof p.message === 'string' ? p.message.trim() || null : null
    }
    return null
  }

  // claude: top-level type='assistant', message.stop_reason='end_turn',
  // message.content is array of {type:'text'|'tool_use', text?, ...}.
  const e = entry as { type?: string, message?: { stop_reason?: string, content?: unknown } }
  if (e.type !== 'assistant') return null
  const msg = e.message
  if (msg?.stop_reason !== 'end_turn') return null
  if (!Array.isArray(msg.content)) return null
  const text = msg.content
    .filter((b): b is { type: string, text: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim()
  return text || null
}
