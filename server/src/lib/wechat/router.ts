import { loadProjects, type Project } from '../projects'
import { readSessionsFromStateFiles, sendToSession, startMultmuxSession, type MultmuxSession } from '../multmux'
import { getBinding, setBinding, clearBinding } from './state'
import { acquireTap, releaseTap, recordOffset, sliceFromOffset, tailSlice, waitForQuiet, hasTap } from './pty-tap'

/** Mutable per-conversation context for the command flow.
 *  Persists only in memory — currentProject is a stepping-stone before binding. */
const currentProjectByConversation = new Map<string, string>()

interface CommandContext {
  conversationId: string
}

interface ParsedCommand {
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

const HELP_TEXT = [
  '可用命令:',
  '/projects (/p)        列出所有 projects',
  '/use <n|name>         选择当前 project',
  '/sessions (/s)        列出当前 project 的 sessions',
  '/use s <n|name>       绑定到该 session',
  '/new <claude|codex>   新建 session 并自动 bind',
  '/exit                 解绑（不杀 session）',
  '/who                  查看当前 binding',
  '/last                 拉取最近输出',
  '/help                 显示本帮助',
].join('\n')

const TAIL_BYTES = 8 * 1024
const PASSTHROUGH_QUIET_MS = 1500
const PASSTHROUGH_TIMEOUT_MS = 60_000

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

async function resolveCurrentProject(conversationId: string): Promise<Project | undefined> {
  const explicit = currentProjectByConversation.get(conversationId)
  if (explicit) return projectByName(explicit)
  const binding = await getBinding(conversationId)
  if (binding) return projectByName(binding.project)
  return undefined
}

async function handleProjects(): Promise<string> {
  const projects = await loadProjects()
  if (projects.length === 0) return '(no projects configured)'
  return projects.map((p, i) => `${i + 1}. ${p.name}`).join('\n')
}

async function pickSessionByArg(project: Project, arg: string): Promise<MultmuxSession | undefined> {
  const sessions = await listSessions(project)
  if (/^\d+$/.test(arg)) return sessions[Number(arg) - 1]
  return sessions.find(s => s.name === arg)
}

async function handleUseSession(ctx: CommandContext, args: string[]): Promise<string> {
  if (args.length === 0) return '用法: /use s <n|name>'
  const project = await resolveCurrentProject(ctx.conversationId)
  if (!project) return 'no current project — run /use <name> first'

  const session = await pickSessionByArg(project, args[0])
  if (!session) return `session not found: ${args[0]}`

  // Acquire the new tap BEFORE releasing the old one, so a failed acquire
  // doesn't strand the binding without a tap.
  try {
    await acquireTap(session.name)
  } catch (e) {
    return `failed to tap session ${session.name}: ${(e as Error).message}`
  }

  const prior = await getBinding(ctx.conversationId)
  if (prior && prior.session !== session.name) {
    await releaseTap(prior.session).catch(() => {})
  }

  await setBinding(ctx.conversationId, {
    project: project.name,
    session: session.name,
    boundAt: new Date().toISOString(),
  })
  return `bound to ${project.name}/${session.name} [${session.status}]`
}

async function handleUse(ctx: CommandContext, args: string[]): Promise<string> {
  if (args.length === 0) return '用法: /use <n|name> 或 /use s <n>'

  if (args[0] === 's' || args[0] === 'session') {
    return handleUseSession(ctx, args.slice(1))
  }

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
  const binding = await getBinding(ctx.conversationId)
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
  const binding = await getBinding(ctx.conversationId)
  if (!binding) return 'not bound'
  await releaseTap(binding.session).catch(() => {})
  await clearBinding(ctx.conversationId)
  currentProjectByConversation.delete(ctx.conversationId)
  return `unbound from ${binding.project}/${binding.session} (session not killed)`
}

async function handleLast(ctx: CommandContext): Promise<string> {
  const binding = await getBinding(ctx.conversationId)
  if (!binding) return 'not bound — run /sessions and /use s <n>'

  if (!hasTap(binding.session)) {
    try { await acquireTap(binding.session) }
    catch (e) { return `cannot tap ${binding.session}: ${(e as Error).message}` }
  }

  const { text, truncated } = tailSlice(binding.session, TAIL_BYTES)
  const out = text.trim() || '(no output captured yet)'
  return truncated ? `${out}\n[…buffer may be truncated…]` : out
}

/** Forward plain text to the bound session, capture the response via tap. */
export async function passthroughText(ctx: CommandContext, text: string): Promise<string> {
  const binding = await getBinding(ctx.conversationId)
  if (!binding) return 'unbound — run /help to see commands'

  // Verify session by acquiring tap (fails if tmux session is gone)
  if (!hasTap(binding.session)) {
    try { await acquireTap(binding.session) }
    catch {
      await clearBinding(ctx.conversationId)
      return `previous session '${binding.session}' is no longer running — run /sessions to choose another`
    }
  }

  const offset = recordOffset(binding.session)

  try {
    await sendToSession(binding.session, text)
  } catch {
    await releaseTap(binding.session).catch(() => {})
    await clearBinding(ctx.conversationId)
    return `previous session '${binding.session}' is no longer running — run /sessions to choose another`
  }

  const { quiet } = await waitForQuiet(binding.session, {
    quietMs: PASSTHROUGH_QUIET_MS,
    timeoutMs: PASSTHROUGH_TIMEOUT_MS,
  })

  const slice = sliceFromOffset(binding.session, offset)
  let reply = slice.text.trim() || '(no output captured — try /last)'
  if (slice.truncated) reply = `[…older output truncated…]\n${reply}`
  if (!quiet) reply = `${reply}\n[turn may still be in progress — /last to retry]`
  return reply
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

  const prior = await getBinding(ctx.conversationId)
  if (prior && prior.session !== handle) {
    await releaseTap(prior.session).catch(() => {})
  }

  await setBinding(ctx.conversationId, {
    project: project.name,
    session: handle,
    boundAt: new Date().toISOString(),
  })
  return `started + bound to ${project.name}/${handle} [${provider}]`
}

export async function dispatch(ctx: CommandContext, command: ParsedCommand): Promise<string> {
  switch (command.name) {
    case 'help':
    case 'h':
      return HELP_TEXT
    case 'projects':
    case 'p':
      return handleProjects()
    case 'use':
      return handleUse(ctx, command.args)
    case 'sessions':
    case 's':
      return handleSessions(ctx)
    case 'who':
      return handleWho(ctx)
    case 'exit':
      return handleExit(ctx)
    case 'last':
      return handleLast(ctx)
    case 'new':
      return handleNew(ctx, command.args)
    default:
      return `unknown command: /${command.name} — run /help`
  }
}

export function getCurrentProject(conversationId: string): string | undefined {
  return currentProjectByConversation.get(conversationId)
}

/** Test/maintenance hook: clear all in-memory per-conversation state */
export function _resetRouterState(): void {
  currentProjectByConversation.clear()
}
