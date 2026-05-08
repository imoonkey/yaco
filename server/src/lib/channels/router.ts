import { promises as fs } from 'node:fs'
import { resolve as resolvePath, sep as pathSep } from 'node:path'
import { loadProjects, type Project } from '../projects'
import { readSessionsFromStateFiles, sendToSession, startMultmuxSession, captureSession, type MultmuxSession } from '../multmux'
import type { BindingStore } from './state'
import { acquireTap, releaseTap, recordOffset, sliceFromOffset, waitForQuiet, hasTap } from './pty-tap'
import { startTurn, streamAgentReply } from './agent-output'
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

const KNOWN_COMMANDS = new Set(['help', 'h', 'projects', 'p', 'use', 'sessions', 's', 'who', 'exit', 'last', 'new', 'file', 'f'])

const HELP_TEXT = [
  '可用命令:',
  '/projects (/p)        列出所有 projects',
  '/use <n|name>         选择当前 project',
  '/sessions (/s)        列出当前 project 的 sessions',
  '/use s <n|name>       绑定到该 session',
  '/new <claude|codex>   新建 session 并自动 bind',
  '/exit                 解绑（不杀 session）',
  '/who                  查看当前 binding',
  '/last [n]             抓最近 n 行 pane（默认 100，上限 2000）',
  '/file [-t] <path>     文件→附件（≤5MB）；-t 改成内联文本（≤32KB）；目录→列表',
  '/help                 显示本帮助',
].join('\n')

const PASSTHROUGH_QUIET_MS = 1500
const PASSTHROUGH_TIMEOUT_MS = 60_000

const LAST_DEFAULT_LINES = 100
const LAST_MAX_LINES = 2000

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

async function listSessions(project: Project): Promise<MultmuxSession[]> {
  return readSessionsFromStateFiles(project)
}

function formatSessions(sessions: MultmuxSession[]): string {
  if (sessions.length === 0) return '(no sessions)'
  return sessions
    .map((s, i) => `${i + 1}. ${s.name} [${s.provider}, ${s.status}]`)
    .join('\n')
}

async function pickSessionByArg(project: Project, arg: string): Promise<MultmuxSession | undefined> {
  const sessions = await listSessions(project)
  if (/^\d+$/.test(arg)) return sessions[Number(arg) - 1]
  return sessions.find(s => s.name === arg)
}

/** Channel-agnostic command router + plain-text passthrough. Each channel
 *  (wechat, whatsapp) creates its own router with its own binding store. */
export function createRouter(store: BindingStore) {
  const currentProjectByConversation = new Map<string, string>()

  async function resolveCurrentProject(conversationId: string): Promise<Project | undefined> {
    const explicit = currentProjectByConversation.get(conversationId)
    if (explicit) return projectByName(explicit)
    const binding = await store.getBinding(conversationId)
    if (binding) return projectByName(binding.project)
    return undefined
  }

  async function handleProjects(): Promise<string> {
    const projects = await loadProjects()
    if (projects.length === 0) return '(no projects configured)'
    return projects.map((p, i) => `${i + 1}. ${p.name}`).join('\n')
  }

  async function handleUseSession(ctx: CommandContext, args: string[]): Promise<string> {
    if (args.length === 0) return '用法: /use s <n|name>'
    const project = await resolveCurrentProject(ctx.conversationId)
    if (!project) return 'no current project — run /use <name> first'

    const session = await pickSessionByArg(project, args[0])
    if (!session) return `session not found: ${args[0]}`

    // Acquire new tap BEFORE releasing old to avoid stranding the binding.
    try {
      await acquireTap(session.name)
    } catch (e) {
      return `failed to tap session ${session.name}: ${(e as Error).message}`
    }

    const prior = await store.getBinding(ctx.conversationId)
    if (prior && prior.session !== session.name) {
      await releaseTap(prior.session).catch(() => {})
    }

    await store.setBinding(ctx.conversationId, {
      project: project.name,
      session: session.name,
      boundAt: new Date().toISOString(),
    })
    return `bound to ${project.name}/${session.name} [${session.status}]`
  }

  async function handleUse(ctx: CommandContext, args: string[]): Promise<string> {
    if (args.length === 0) return '用法: /use <n|name> 或 /use s <n>'
    if (args[0] === 's' || args[0] === 'session') return handleUseSession(ctx, args.slice(1))

    const project = await pickProjectByArg(args[0])
    if (!project) return `project not found: ${args[0]}`
    currentProjectByConversation.set(ctx.conversationId, project.name)

    const sessions = await listSessions(project)
    return [`current project: ${project.name}`, '', formatSessions(sessions)].join('\n')
  }

  async function handleSessions(ctx: CommandContext): Promise<string> {
    const project = await resolveCurrentProject(ctx.conversationId)
    if (!project) return 'no current project — run /projects then /use <n|name>'
    const sessions = await listSessions(project)
    return [`project: ${project.name}`, '', formatSessions(sessions)].join('\n')
  }

  async function handleWho(ctx: CommandContext): Promise<string> {
    const binding = await store.getBinding(ctx.conversationId)
    if (!binding) {
      const current = currentProjectByConversation.get(ctx.conversationId)
      return current
        ? `unbound (current project: ${current}) — run /sessions and /use s <n>`
        : 'unbound — run /help to see commands'
    }
    const project = await projectByName(binding.project)
    if (!project) return `bound to ${binding.project}/${binding.session} (project no longer exists)`
    const sessions = await listSessions(project)
    const session = sessions.find(s => s.name === binding.session)
    if (!session) return `bound to ${binding.project}/${binding.session} (session no longer exists — run /sessions)`
    return `bound to ${binding.project}/${binding.session} [${session.status}]`
  }

  async function handleExit(ctx: CommandContext): Promise<string> {
    const binding = await store.getBinding(ctx.conversationId)
    if (!binding) return 'not bound'
    await releaseTap(binding.session).catch(() => {})
    await store.clearBinding(ctx.conversationId)
    currentProjectByConversation.delete(ctx.conversationId)
    return `unbound from ${binding.project}/${binding.session} (session not killed)`
  }

  async function handleLast(ctx: CommandContext, args: string[]): Promise<string> {
    const binding = await store.getBinding(ctx.conversationId)
    if (!binding) return 'not bound — run /sessions and /use s <n>'

    const requested = Number(args[0])
    const lines = Number.isFinite(requested) && requested > 0
      ? Math.min(LAST_MAX_LINES, Math.floor(requested))
      : LAST_DEFAULT_LINES

    try {
      const text = (await captureSession(binding.session, lines)).trim()
      return text || '(empty)'
    } catch (e) {
      return `capture failed: ${(e as Error).message}`
    }
  }

  async function handleNew(ctx: CommandContext, args: string[]): Promise<string> {
    if (args.length === 0) return '用法: /new <claude|codex> [name]'
    const providerArg = args[0].toLowerCase()
    if (providerArg !== 'claude' && providerArg !== 'codex') {
      return `provider must be claude or codex, got: ${args[0]}`
    }
    const provider: 'claude' | 'codex' = providerArg
    const project = await resolveCurrentProject(ctx.conversationId)
    if (!project) return 'no current project — run /use <name> first'

    const name = args[1]
    let handle: string
    try {
      const result = await startMultmuxSession(provider, name, project.path)
      handle = result.handle
    } catch (e) {
      return `failed to start ${provider} session: ${(e as Error).message}`
    }

    try {
      await acquireTap(handle)
    } catch (e) {
      return `started session ${handle} but failed to tap it: ${(e as Error).message}`
    }

    const prior = await store.getBinding(ctx.conversationId)
    if (prior && prior.session !== handle) {
      await releaseTap(prior.session).catch(() => {})
    }

    await store.setBinding(ctx.conversationId, {
      project: project.name,
      session: handle,
      boundAt: new Date().toISOString(),
    })
    return `started + bound to ${project.name}/${handle} [${provider}]`
  }

  // Tolerate phone-keyboard autocorrect: -, –, —, − (any of these as the
  // leading dash); -t, -T, --text. The smart-dash substitution on iOS/Android
  // turns "-t" into "–t" silently and the user sees "not found: -t <path>".
  const TEXT_FLAG_RE = /^(?:[-–—−]){1,2}t(?:ext)?$/i

  async function handleFile(ctx: CommandContext, args: string[]): Promise<ChannelReply> {
    const asText = args.some(a => TEXT_FLAG_RE.test(a))
    const pathArgs = args.filter(a => !TEXT_FLAG_RE.test(a))
    if (pathArgs.length === 0) return textReply('用法: /file [-t] <relative-path>')

    const project = await resolveCurrentProject(ctx.conversationId)
    if (!project) return textReply('no current project — run /use <name> first or bind a session')

    // Prefer the bound session's cwd (worktree-aware); fall back to project root.
    let root = project.path
    const binding = await store.getBinding(ctx.conversationId)
    if (binding) {
      const session = (await listSessions(project)).find(s => s.name === binding.session)
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

  /** Forward plain text to the bound session and stream the agent's reply
   *  events (interim text, AskUserQuestion prompt, final answer) to the
   *  channel via the onReply callback. Reads the agent's structured JSONL
   *  session log — no TUI chrome, no tool noise, no input echo.
   *
   *  Falls back to the tap-buffer slice (single reply) if the JSONL log
   *  can't be located (e.g. session just started, sessionId not yet written). */
  async function passthroughText(
    ctx: CommandContext,
    text: string,
    onReply: ReplyCallback,
  ): Promise<void> {
    const binding = await store.getBinding(ctx.conversationId)
    if (!binding) { await onReply(textReply('unbound — run /help to see commands')); return }

    // Find the session metadata so we know which JSONL to tail.
    const project = await projectByName(binding.project)
    const sessions = project ? await listSessions(project) : []
    const session = sessions.find(s => s.name === binding.session)
    if (!session) {
      await store.clearBinding(ctx.conversationId)
      await onReply(textReply(`previous session '${binding.session}' is no longer running — run /sessions to choose another`))
      return
    }

    // Open a JSONL turn marker BEFORE sending — captures the file's current
    // size so streamAgentReply only considers entries appended after our send.
    const turn = await startTurn(session)

    try {
      await sendToSession(binding.session, text)
    } catch {
      await store.clearBinding(ctx.conversationId)
      await onReply(textReply(`previous session '${binding.session}' is no longer running — run /sessions to choose another`))
      return
    }

    if (!turn) {
      // No JSONL available (e.g. session not yet emitted any events). Fall
      // back to tap-based capture so the user still gets *something*.
      await passthroughViaTap(ctx, binding.session, onReply)
      return
    }

    let sentAny = false
    for await (const ev of streamAgentReply(turn, {
      timeoutMs: PASSTHROUGH_TIMEOUT_MS,
      onAskUserQuestion: async () => sendEscape(binding.session),
    })) {
      if (ev.kind === 'timeout') {
        await onReply(textReply(sentAny
          ? '[turn may still be in progress — /last for raw buffer]'
          : '(no answer within 2 min — try /last for the raw pane buffer)'))
        return
      }
      if (!ev.text) continue
      await onReply(textReply(ev.text))
      sentAny = true
    }

    if (!sentAny) await onReply(textReply('(no answer captured)'))
  }

  /** Legacy tap-based passthrough — only used when the JSONL log can't be
   *  found. Kept as a safety net so a freshly-started session that hasn't
   *  written a sessionId yet still produces some output. */
  async function passthroughViaTap(
    ctx: CommandContext,
    handle: string,
    onReply: ReplyCallback,
  ): Promise<void> {
    if (!hasTap(handle)) {
      try { await acquireTap(handle) }
      catch {
        await store.clearBinding(ctx.conversationId)
        await onReply(textReply(`previous session '${handle}' is no longer running — run /sessions to choose another`))
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
    let reply = slice.text.trim() || '(no output captured — try /last)'
    if (slice.truncated) reply = `[…older output truncated…]\n${reply}`
    if (!quiet) reply = `${reply}\n[turn may still be in progress — /last to retry]`
    await onReply(textReply(reply))
  }

  async function dispatch(ctx: CommandContext, command: ParsedCommand): Promise<ChannelReply> {
    switch (command.name) {
      case 'help':
      case 'h':
        return textReply(HELP_TEXT)
      case 'projects':
      case 'p':
        return textReply(await handleProjects())
      case 'use':
        return textReply(await handleUse(ctx, command.args))
      case 'sessions':
      case 's':
        return textReply(await handleSessions(ctx))
      case 'who':
        return textReply(await handleWho(ctx))
      case 'exit':
        return textReply(await handleExit(ctx))
      case 'last':
        return textReply(await handleLast(ctx, command.args))
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
    getCurrentProject,
    _resetState,
  }
}

export type ChannelRouter = ReturnType<typeof createRouter>
