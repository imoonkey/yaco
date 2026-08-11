import { promises as fs } from 'node:fs'
import { resolve as resolvePath, sep as pathSep } from 'node:path'
import { loadProjects, type Project } from '../projects'
import {
  readSessionsFromStateFiles,
  sendToSession,
  startAgentSession,
  captureSession,
  inspectSessionMessages,
  type AgentSession,
} from '../agent'
import { lastAssistantMessages } from './agent-messages'
import type { BindingStore } from './state'
import { acquireTap, releaseTap, recordOffset, sliceFromOffset, waitForQuiet, hasTap } from './pty-tap'
import { startTurn, streamAgentReply, queueHandleStream } from './agent-output'
import { sendEscape } from './keys'

export type ChannelReply =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string; filename: string; caption?: string }

export type ReplyCallback = (reply: ChannelReply) => Promise<void>

export const textReply = (text: string): ChannelReply => ({ kind: 'text', text })
export interface CommandContext {
  conversationId: string
}

export interface ParsedCommand {
  name: string
  args: string[]
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  return { name: parts[0].toLowerCase(), args: parts.slice(1) }
}

const KNOWN_COMMANDS = new Set([
  'help', 'h', 'projects', 'p', 'use', 'sessions', 's', 'who', 'exit',
  'last', 'messages', 'm', 'capture', 'cap', 'new', 'file', 'f',
])

// State-changing commands mutate the per-conversation binding (currentProject
// map or BindingStore). They must stay ordered relative to passthroughs so
// that "/use s X" followed by a message reliably targets X. Read-only
// commands may bypass the conversation queue for instant response.
const STATE_CHANGING_COMMANDS = new Set(['use', 'new', 'exit'])

const HELP_TEXT = [
  'Available commands:',
  '/projects (/p)        list all projects',
  '/use <n|name>         select current project',
  '/sessions (/s)        list sessions of current project',
  '/use s <n|name>       subscribe a session + make it active',
  '/new <provider> [name]  start a session, subscribe + activate',
  '/who                  list subscribed sessions (* active)',
  '/exit [n|name|all]    unsubscribe active / one / all (does not kill)',
  '/last [n]             last n assistant messages (default 1, max 20)',
  '/messages (/m) [args] pass through to `yaco agent messages` (--summary, --index i, --role, --range, --preview)',
  '/capture (/cap) [n]   raw pane capture (debug; default 100, max 2000)',
  '/file (/f) [-t] <relative-path>  file → attachment (≤5MB); -t inlines as text (≤32KB); directory → listing',
  '/help (/h)            show this help',
].join('\n')

const PASSTHROUGH_QUIET_MS = 1500
const PASSTHROUGH_TIMEOUT_MS = 60_000

const LAST_DEFAULT_MESSAGES = 1
const LAST_MAX_MESSAGES = 20

const CAPTURE_DEFAULT_LINES = 100
const CAPTURE_MAX_LINES = 2000

const MESSAGES_MAX_CHARS = 8000

const FILE_MAX_BYTES = 5 * 1024 * 1024
const FILE_TEXT_MAX_BYTES = 32 * 1024
const DIR_MAX_ENTRIES = 200

async function formatDirListing(absPath: string, rel: string): Promise<string> {
  const entries = await fs.readdir(absPath, { withFileTypes: true })
  const sorted = entries.sort((a, b) =>
    (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name)
  )
  const shown = sorted.slice(0, DIR_MAX_ENTRIES)
  const lines = shown.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
  const more = sorted.length > DIR_MAX_ENTRIES
    ? [`[…${sorted.length - DIR_MAX_ENTRIES} more]`]
    : []
  return [`${rel || '.'}/  (${entries.length} entries)`, ...lines, ...more].join('\n')
}

function looksBinary(buf: Buffer): boolean {
  // Null byte in the first 8KB is a strong binary signal — works for images,
  // archives, executables; produces no false positives on UTF-8 text.
  const sample = buf.subarray(0, Math.min(buf.length, 8192))
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) return true
  return false
}

async function projectByName(name: string): Promise<Project | undefined> {
  return (await loadProjects()).find(p => p.name === name)
}

async function pickProjectByArg(arg: string): Promise<Project | undefined> {
  const projects = await loadProjects()
  if (/^\d+$/.test(arg)) {
    const idx = Number(arg) - 1
    return projects[idx]
  }
  return projects.find(p => p.name === arg)
}

async function listSessions(project: Project): Promise<AgentSession[]> {
  return readSessionsFromStateFiles(project)
}

interface SessionMarks {
  active?: string
  subscribed: Set<string>
}

function formatSessions(sessions: AgentSession[], marks: SessionMarks = { subscribed: new Set() }): string {
  if (sessions.length === 0) return '(no sessions)'
  return sessions
    .map((s, i) => {
      const mark = s.name === marks.active ? '*' : marks.subscribed.has(s.name) ? '+' : ' '
      return `${i + 1}. ${mark} ${s.name} [${s.provider}, ${s.status}]`
    })
    .join('\n')
}

async function pickSessionByArg(project: Project, arg: string): Promise<AgentSession | undefined> {
  const sessions = await listSessions(project)
  if (/^\d+$/.test(arg)) return sessions[Number(arg) - 1]
  return sessions.find(s => s.name === arg)
}

/** Channel-agnostic command router + plain-text passthrough. Each channel
 *  (wechat, whatsapp) creates its own router with its own binding store.
 *
 *  A conversation subscribes to a SET of sessions with one `active` send
 *  target (BindingStore). Plain text goes to the active session; replies stream
 *  from every subscribed session a turn was sent to, each labeled `[name]` so
 *  concurrent turns across sessions stay unambiguous. Switching active (/use s)
 *  never drops the others. */
export function createRouter(store: BindingStore) {
  const currentProjectByConversation = new Map<string, string>()

  // Reply-stream serialization is per session handle and lives in shared module
  // state (queueHandleStream), NOT per-router. Sends to *different* sessions
  // stream in parallel, but two rapid sends to the *same* session — even from a
  // different channel router bound to it — queue so there is at most one live
  // output-follow child per handle and the older turn's stream finishes first.

  async function resolveCurrentProject(conversationId: string): Promise<Project | undefined> {
    const explicit = currentProjectByConversation.get(conversationId)
    if (explicit) return projectByName(explicit)
    const active = await store.getActive(conversationId)
    if (active) return projectByName(active.project)
    return undefined
  }

  /** Markers for the given project's session list: which are subscribed, and
   *  which (if any) is the active send target. */
  async function sessionMarks(conversationId: string, projectName: string): Promise<SessionMarks> {
    const subs = await store.listSessions(conversationId)
    const subscribed = new Set(subs.filter(b => b.project === projectName).map(b => b.session))
    const active = await store.getActive(conversationId)
    return { active: active?.project === projectName ? active.session : undefined, subscribed }
  }

  async function handleProjects(ctx: CommandContext): Promise<string> {
    const projects = await loadProjects()
    if (projects.length === 0) return '(no projects configured)'
    const current = (await resolveCurrentProject(ctx.conversationId))?.name
    return projects
      .map((p, i) => `${i + 1}. ${p.name === current ? '* ' : '  '}${p.name}`)
      .join('\n')
  }

  async function handleUseSession(ctx: CommandContext, args: string[]): Promise<string> {
    if (args.length === 0) return 'usage: /use s <n|name>'
    const project = await resolveCurrentProject(ctx.conversationId)
    if (!project) return 'no current project — run /use <name> first'

    const session = await pickSessionByArg(project, args[0])
    if (!session) return `session not found: ${args[0]}`

    // Already subscribed → just promote to active (no extra tap).
    if (await store.setActive(ctx.conversationId, session.name)) {
      return `active: ${project.name}/${session.name} [${session.status}]`
    }

    try {
      await acquireTap(session.name)
    } catch (e) {
      return `failed to tap session ${session.name}: ${(e as Error).message}`
    }

    await store.addSession(ctx.conversationId, {
      project: project.name,
      session: session.name,
      boundAt: new Date().toISOString(),
    })
    return `subscribed + active: ${project.name}/${session.name} [${session.status}]`
  }

  async function handleUse(ctx: CommandContext, args: string[]): Promise<string> {
    if (args.length === 0) return 'usage: /use <n|name> or /use s <n>'
    if (args[0] === 's' || args[0] === 'session') return handleUseSession(ctx, args.slice(1))

    const project = await pickProjectByArg(args[0])
    if (!project) return `project not found: ${args[0]}`
    currentProjectByConversation.set(ctx.conversationId, project.name)

    const sessions = await listSessions(project)
    const marks = await sessionMarks(ctx.conversationId, project.name)
    return [`current project: ${project.name}`, '', formatSessions(sessions, marks)].join('\n')
  }

  async function handleSessions(ctx: CommandContext): Promise<string> {
    const project = await resolveCurrentProject(ctx.conversationId)
    if (!project) return 'no current project — run /projects then /use <n|name>'
    const sessions = await listSessions(project)
    const marks = await sessionMarks(ctx.conversationId, project.name)
    return [`project: ${project.name}`, '', formatSessions(sessions, marks)].join('\n')
  }

  async function handleWho(ctx: CommandContext): Promise<string> {
    const subs = await store.listSessions(ctx.conversationId)
    if (subs.length === 0) {
      const current = currentProjectByConversation.get(ctx.conversationId)
      return current
        ? `no sessions subscribed (current project: ${current}) — run /sessions and /use s <n>`
        : 'no sessions subscribed — run /help to see commands'
    }
    const active = await store.getActive(ctx.conversationId)
    const lines = await Promise.all(subs.map(async (b, i) => {
      const project = await projectByName(b.project)
      const session = project ? (await listSessions(project)).find(s => s.name === b.session) : undefined
      const mark = b.session === active?.session ? '*' : '+'
      const status = session ? session.status : 'not running'
      return `${i + 1}. ${mark} ${b.project}/${b.session} [${status}]`
    }))
    return ['subscribed sessions (* active):', ...lines].join('\n')
  }

  async function handleExit(ctx: CommandContext, args: string[]): Promise<string> {
    const subs = await store.listSessions(ctx.conversationId)
    if (subs.length === 0) return 'no sessions subscribed'

    if (args[0] === 'all') {
      await Promise.all(subs.map(b => releaseTap(b.session).catch(() => {})))
      await store.clearAll(ctx.conversationId)
      currentProjectByConversation.delete(ctx.conversationId)
      return `unsubscribed all ${subs.length} session(s) (not killed)`
    }

    let target: string | undefined
    if (args.length === 0) {
      target = (await store.getActive(ctx.conversationId))?.session
    } else if (/^\d+$/.test(args[0])) {
      target = subs[Number(args[0]) - 1]?.session
    } else {
      target = subs.find(b => b.session === args[0])?.session
    }
    if (!target) return `not subscribed: ${args[0] ?? '(no active session)'}`

    await releaseTap(target).catch(() => {})
    const removed = await store.removeSession(ctx.conversationId, target)
    const next = await store.getActive(ctx.conversationId)
    const tail = next ? ` — active now ${next.project}/${next.session}` : ''
    return `unsubscribed ${removed?.project ?? '?'}/${target} (not killed)${tail}`
  }

  async function handleLast(ctx: CommandContext, args: string[]): Promise<string> {
    const active = await store.getActive(ctx.conversationId)
    if (!active) return 'no active session — run /sessions and /use s <n>'

    const requested = Number(args[0])
    const n = Number.isFinite(requested) && requested > 0
      ? Math.min(LAST_MAX_MESSAGES, Math.floor(requested))
      : LAST_DEFAULT_MESSAGES

    let msgs: { index: number; text: string }[]
    try {
      msgs = await lastAssistantMessages(active.session, n)
    } catch (e) {
      return `messages failed: ${(e as Error).message}`
    }
    if (msgs.length === 0) return '(no assistant messages yet)'

    // One message: no label noise. Multiple: label oldest→newest as
    // [name-k]…[name] so the most recent reads cleanest.
    if (msgs.length === 1) return msgs[0].text.trim() || '(empty)'
    return msgs
      .map((m, i) => {
        const fromEnd = msgs.length - 1 - i
        const label = fromEnd === 0 ? `[${active.session}]` : `[${active.session}-${fromEnd}]`
        return `${label} ${m.text.trim()}`
      })
      .join('\n\n')
  }

  /** Flexible escape hatch: forward arbitrary `yaco agent messages` flags to the
   *  active session and return the CLI's own text rendering. */
  async function handleMessages(ctx: CommandContext, args: string[]): Promise<string> {
    const active = await store.getActive(ctx.conversationId)
    if (!active) return 'no active session — run /sessions and /use s <n>'
    let text: string
    try {
      text = await inspectSessionMessages(active.session, args)
    } catch (e) {
      // spawnOutput rejects as "exit <code>: <stderr>"; surface the stderr tail
      // (usually the CLI USAGE string on a bad flag).
      const msg = (e as Error).message ?? String(e)
      const m = msg.match(/exit \d+:\s*([\s\S]*)$/)
      return (m ? m[1].trim() : msg) || 'messages failed'
    }
    const trimmed = text.trimEnd()
    if (trimmed.length <= MESSAGES_MAX_CHARS) return trimmed || '(no output)'
    return `${trimmed.slice(0, MESSAGES_MAX_CHARS)}\n[…truncated — narrow with --range/--role or use --index]`
  }

  /** Debug-only raw pane capture (ANSI-stripped tmux scrollback). */
  async function handleCapture(ctx: CommandContext, args: string[]): Promise<string> {
    const active = await store.getActive(ctx.conversationId)
    if (!active) return 'no active session — run /sessions and /use s <n>'

    const requested = Number(args[0])
    const lines = Number.isFinite(requested) && requested > 0
      ? Math.min(CAPTURE_MAX_LINES, Math.floor(requested))
      : CAPTURE_DEFAULT_LINES

    try {
      const text = (await captureSession(active.session, lines)).trim()
      return text || '(empty)'
    } catch (e) {
      return `capture failed: ${(e as Error).message}`
    }
  }

  async function handleNew(ctx: CommandContext, args: string[]): Promise<string> {
    if (args.length === 0) return 'usage: /new <provider> [name]'
    // No hard-coded provider union here: startAgentSession validates against the
    // CLI provider catalog (`yaco agent providers --json`) and reports the known
    // ids on rejection, so new providers work without editing the channel.
    const provider = args[0].toLowerCase()
    const project = await resolveCurrentProject(ctx.conversationId)
    if (!project) return 'no current project — run /use <name> first'

    const name = args[1]
    let handle: string
    try {
      const result = await startAgentSession(provider, name, project.path)
      handle = result.handle
    } catch (e) {
      return `failed to start ${provider} session: ${(e as Error).message}`
    }

    try {
      await acquireTap(handle)
    } catch (e) {
      return `started session ${handle} but failed to tap it: ${(e as Error).message}`
    }

    await store.addSession(ctx.conversationId, {
      project: project.name,
      session: handle,
      boundAt: new Date().toISOString(),
    })
    return `started + active: ${project.name}/${handle} [${provider}]`
  }

  async function handleFile(ctx: CommandContext, args: string[]): Promise<ChannelReply> {
    const asText = args.includes('-t')
    const pathArgs = args.filter(a => a !== '-t')
    if (pathArgs.length === 0) return textReply('usage: /file [-t] <relative-path>')

    const project = await resolveCurrentProject(ctx.conversationId)
    if (!project) return textReply('no current project — run /use <name> first or bind a session')

    // Prefer the active session's cwd (worktree-aware); fall back to project root.
    let root = project.path
    const active = await store.getActive(ctx.conversationId)
    if (active) {
      const session = (await listSessions(project)).find(s => s.name === active.session)
      if (session) root = session.sessionPath
    }

    const rel = pathArgs.join(' ')
    const resolved = resolvePath(root, rel)
    if (resolved !== root && !resolved.startsWith(root + pathSep)) {
      return textReply(`path escapes session root: ${rel}`)
    }

    let st
    try { st = await fs.stat(resolved) } catch { return textReply(`not found: ${rel}`) }

    if (st.isDirectory()) return textReply(await formatDirListing(resolved, rel))
    if (!st.isFile()) return textReply(`not a file or directory: ${rel}`)

    if (asText) {
      if (st.size > FILE_TEXT_MAX_BYTES) {
        return textReply(`file too large for -t: ${st.size} bytes (limit ${FILE_TEXT_MAX_BYTES}; drop -t to send as attachment)`)
      }
      const buf = await fs.readFile(resolved)
      if (looksBinary(buf)) return textReply(`binary file (${st.size} bytes) — drop -t to send as attachment`)
      const text = buf.toString('utf-8')
      const lines = text.length === 0 ? 0 : text.split('\n').length
      return textReply(`--- ${rel} (${lines} lines, ${st.size} bytes) ---\n${text}`)
    }

    if (st.size > FILE_MAX_BYTES) {
      return textReply(`file too large: ${st.size} bytes (limit ${FILE_MAX_BYTES})`)
    }

    const filename = rel.split('/').pop() || rel
    return { kind: 'file', path: resolved, filename, caption: `${rel} (${st.size} bytes)` }
  }

  /** Forward plain text to the active session. Awaits only the SEND phase so
   *  the conversation queue drains immediately — agent reply streaming runs
   *  in the background under a per-session lock, calling onReply as events
   *  arrive. Every reply is prefixed `[session] ` so replies from different
   *  subscribed sessions (interleaved after /use s switches) stay attributable.
   *
   *  Falls back to the tap-buffer slice when the provider exposes no output
   *  cursor (e.g. session just started, sessionId not yet written, or a
   *  provider without an `output` adapter). */
  async function passthroughText(
    ctx: CommandContext,
    text: string,
    onReply: ReplyCallback,
  ): Promise<void> {
    const active = await store.getActive(ctx.conversationId)
    if (!active) { await onReply(textReply('no active session — run /help to see commands')); return }

    const project = await projectByName(active.project)
    const sessions = project ? await listSessions(project) : []
    const session = sessions.find(s => s.name === active.session)
    if (!session) {
      await store.removeSession(ctx.conversationId, active.session)
      await onReply(textReply(`session '${active.session}' is no longer running — run /sessions to choose another`))
      return
    }

    // Resolve the output cursor BEFORE sending — captures the provider log
    // position that predates the agent's reply, so streamAgentReply only sees
    // entries appended after our send. null means no output cursor (tap fallback).
    const turn = await startTurn(session)

    try {
      await sendToSession(active.session, text)
    } catch {
      await store.removeSession(ctx.conversationId, active.session)
      await onReply(textReply(`session '${active.session}' is no longer running — run /sessions to choose another`))
      return
    }

    // Fire-and-forget reply streaming under the shared per-handle lock.
    const sessionHandle = active.session
    const label = `[${sessionHandle}] `
    queueHandleStream(sessionHandle, async () => {
      if (!turn) {
        await passthroughViaTap(ctx, sessionHandle, onReply, label)
        return
      }

      let sentAny = false
      for await (const ev of streamAgentReply(turn, {
        timeoutMs: PASSTHROUGH_TIMEOUT_MS,
        onAskUserQuestion: async () => sendEscape(sessionHandle),
      })) {
        if (ev.kind === 'timeout') {
          await onReply(textReply(label + (sentAny
            ? '⌛ [turn may still be in progress — /last for the latest reply]'
            : '⌛ (no answer within 60s — try /capture for the raw pane buffer)')))
          return
        }
        if (!ev.text) continue
        // Visual prefix so the user can tell progress from completion at a
        // glance. A 'question' event already carries the 🤔 prefix from the
        // CLI classifier, so we don't double-mark it.
        const prefix = ev.kind === 'final' ? '✅ '
          : ev.kind === 'interim' ? '⏳ '
          : ''
        await onReply(textReply(`${label}${prefix}${ev.text}`))
        sentAny = true
      }

      if (!sentAny) await onReply(textReply(`${label}(no answer captured)`))
    })
  }

  /** Legacy tap-based passthrough — only used when the provider exposes no
   *  output cursor. Kept as a safety net so a freshly-started session that
   *  hasn't written a sessionId yet still produces some output. */
  async function passthroughViaTap(
    ctx: CommandContext,
    handle: string,
    onReply: ReplyCallback,
    label: string,
  ): Promise<void> {
    if (!hasTap(handle)) {
      try { await acquireTap(handle) }
      catch {
        await store.removeSession(ctx.conversationId, handle)
        await onReply(textReply(`session '${handle}' is no longer running — run /sessions to choose another`))
        return
      }
    }
    const offset = recordOffset(handle)
    // (send already happened in passthroughText)
    const { quiet } = await waitForQuiet(handle, {
      quietMs: PASSTHROUGH_QUIET_MS,
      timeoutMs: PASSTHROUGH_TIMEOUT_MS,
    })
    const slice = sliceFromOffset(handle, offset)
    let reply = slice.text.trim() || '(no output captured — try /capture)'
    if (slice.truncated) reply = `[…older output truncated…]\n${reply}`
    if (!quiet) reply = `${reply}\n[turn may still be in progress — /last to retry]`
    await onReply(textReply(`${label}${reply}`))
  }

  async function handleHelp(ctx: CommandContext): Promise<string> {
    const active = await store.getActive(ctx.conversationId)
    const subs = await store.listSessions(ctx.conversationId)
    const current = currentProjectByConversation.get(ctx.conversationId)
    let status: string
    if (active) {
      const extra = subs.length > 1 ? ` (+${subs.length - 1} more — /who)` : ''
      status = `active: ${active.project} / ${active.session}${extra}`
    } else if (current) {
      status = `current project: ${current} (no session bound — /s then /use s <n>)`
    } else {
      status = '(no project selected — start with /p)'
    }
    return [status, '', HELP_TEXT].join('\n')
  }

  async function dispatch(ctx: CommandContext, command: ParsedCommand): Promise<ChannelReply> {
    switch (command.name) {
      case 'help':
      case 'h':
        return textReply(await handleHelp(ctx))
      case 'projects':
      case 'p':
        return textReply(await handleProjects(ctx))
      case 'use':
        return textReply(await handleUse(ctx, command.args))
      case 'sessions':
      case 's':
        return textReply(await handleSessions(ctx))
      case 'who':
        return textReply(await handleWho(ctx))
      case 'exit':
        return textReply(await handleExit(ctx, command.args))
      case 'last':
        return textReply(await handleLast(ctx, command.args))
      case 'messages':
      case 'm':
        return textReply(await handleMessages(ctx, command.args))
      case 'capture':
      case 'cap':
        return textReply(await handleCapture(ctx, command.args))
      case 'new':
        return textReply(await handleNew(ctx, command.args))
      case 'file':
      case 'f':
        return handleFile(ctx, command.args)
      default:
        return textReply(`unknown command: /${command.name} — run /help`)
    }
  }

  /** Top-level message handler: parses + routes commands, otherwise
   *  forwards as plain text via passthroughText. Unknown slash commands
   *  (e.g. /scope-review) fall through to the agent verbatim. Each reply
   *  chunk is delivered through onReply (channels can stream multiple
   *  replies per turn — interim text, AskUserQuestion prompt, final answer). */
  async function handleMessage(
    ctx: CommandContext,
    text: string,
    onReply: ReplyCallback,
  ): Promise<void> {
    const command = parseCommand(text)
    if (command && KNOWN_COMMANDS.has(command.name)) {
      const reply = await dispatch(ctx, command)
      if (reply.kind !== 'text' || reply.text) await onReply(reply)
      return
    }
    await passthroughText(ctx, text, onReply)
  }

  function getCurrentProject(conversationId: string): string | undefined {
    return currentProjectByConversation.get(conversationId)
  }

  /** Test/maintenance hook */
  function _resetState(): void {
    currentProjectByConversation.clear()
  }

  return {
    handleMessage,
    dispatch,
    parseCommand,
    isReadOnlyCommand: (name: string) =>
      KNOWN_COMMANDS.has(name) && !STATE_CHANGING_COMMANDS.has(name),
    getCurrentProject,
    _resetState,
  }
}

export type ChannelRouter = ReturnType<typeof createRouter>
