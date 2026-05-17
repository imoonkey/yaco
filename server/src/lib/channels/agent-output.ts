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

export type AgentEvent =
  | { kind: 'interim', text: string }
  | { kind: 'question', text: string }
  | { kind: 'final', text: string }
  | { kind: 'timeout' }

export interface StreamOptions {
  timeoutMs?: number
  /** Called once when an AskUserQuestion is detected, BEFORE the 'question'
   *  event is yielded. Should send Escape to the multmux session to cancel
   *  the TUI dialog so the agent unblocks. Errors are swallowed + logged. */
  onAskUserQuestion?: () => Promise<void>
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

/** Stream agent reply events as they're appended to the JSONL log. Yields
 *  interim text blocks during a tool-use turn, surfaces AskUserQuestion as
 *  a 'question' event (after invoking onAskUserQuestion to cancel the TUI
 *  dialog), and ends with 'final' when the agent's turn closes — or
 *  'timeout' if nothing finalizes within timeoutMs. */
export async function* streamAgentReply(
  turn: PendingTurn,
  opts: StreamOptions = {},
): AsyncGenerator<AgentEvent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const start = Date.now()
  let lastSize = turn.startSize
  let buffer = ''

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, POLL_MS))

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
      const events = classifyLine(raw, turn.provider)
      for (const ev of events) {
        if (ev.kind === 'question' && opts.onAskUserQuestion) {
          try { await opts.onAskUserQuestion() }
          catch (e) { console.error('[agent-output] onAskUserQuestion failed:', e) }
        }
        yield ev
        if (ev.kind === 'final') return
      }
    }
  }

  yield { kind: 'timeout' }
}

/** Back-compat shim: collapse the stream into a single final reply.
 *  Returns the last text seen (interim, question, or final) plus a
 *  timedOut flag. Prefer streamAgentReply for new callers. */
export async function awaitFinalReply(
  turn: PendingTurn,
  timeoutMs?: number,
): Promise<{ text: string, timedOut: boolean }> {
  let last = ''
  let timedOut = false
  for await (const ev of streamAgentReply(turn, { timeoutMs })) {
    if (ev.kind === 'timeout') { timedOut = true; break }
    last = ev.text
    if (ev.kind === 'final') break
  }
  return { text: last, timedOut }
}

interface ClaudeMessage {
  stop_reason?: string
  content?: unknown
}

interface ClaudeBlock {
  type?: string
  text?: string
  name?: string
  input?: { questions?: ClaudeQuestion[] }
}

interface ClaudeQuestion {
  question?: string
  header?: string
  options?: { label?: string, description?: string }[]
}

function classifyLine(line: string, provider: 'claude' | 'codex'): AgentEvent[] {
  let entry: unknown
  try { entry = JSON.parse(line) } catch { return [] }
  if (!entry || typeof entry !== 'object') return []

  return provider === 'codex' ? classifyCodex(entry) : classifyClaude(entry)
}

function classifyCodex(entry: unknown): AgentEvent[] {
  const e = entry as { type?: string, payload?: { type?: string, phase?: string, message?: unknown } }
  if (e.type !== 'event_msg') return []
  const p = e.payload
  if (p?.type !== 'agent_message') return []
  if (typeof p.message !== 'string') return []
  const text = p.message.trim()
  if (!text) return []
  if (p.phase === 'final_answer') return [{ kind: 'final', text }]
  if (p.phase === 'commentary') return [{ kind: 'interim', text }]
  return []
}

function classifyClaude(entry: unknown): AgentEvent[] {
  const e = entry as { type?: string, message?: ClaudeMessage }
  if (e.type !== 'assistant') return []
  const msg = e.message
  if (!msg || !Array.isArray(msg.content)) return []
  const blocks = msg.content as ClaudeBlock[]

  const textParts: string[] = []
  const questions: ClaudeQuestion[] = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text)
    } else if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
      const qs = b.input?.questions
      if (Array.isArray(qs)) questions.push(...qs)
    }
    // skip thinking, tool_use (other tools), tool_result
  }

  const events: AgentEvent[] = []
  const text = textParts.join('\n').trim()

  if (questions.length > 0) {
    if (text) events.push({ kind: 'interim', text })
    events.push({ kind: 'question', text: formatQuestion(questions) })
    return events
  }

  if (!text) return []
  if (msg.stop_reason === 'end_turn') return [{ kind: 'final', text }]
  return [{ kind: 'interim', text }]
}

function formatQuestion(questions: ClaudeQuestion[]): string {
  const blocks = questions.map(q => {
    const head = q.question?.trim() || q.header?.trim() || '(no question text)'
    const opts = (q.options ?? [])
      .map((o, i) => {
        const label = o.label?.trim() || `option ${i + 1}`
        const desc = o.description?.trim()
        return desc ? `${i + 1}) ${label} — ${desc}` : `${i + 1}) ${label}`
      })
      .join('\n')
    return opts ? `🤔 Agent asks: ${head}\n\n${opts}` : `🤔 Agent asks: ${head}`
  })
  return `${blocks.join('\n\n')}\n\nDialog auto-cancelled — just reply with your answer.`
}
