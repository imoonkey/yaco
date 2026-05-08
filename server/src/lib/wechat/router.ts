import { loadProjects, type Project } from '../projects'
import { readSessionsFromStateFiles, type MultmuxSession } from '../multmux'
import { getBinding } from './state'

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
  '/use s <n>            绑定到该 session（passthrough phase 2 启用）',
  '/new <claude|codex>   新建 session（phase 3 启用）',
  '/exit                 解绑（phase 2 启用）',
  '/who                  查看当前 binding',
  '/last                 拉取最近输出（phase 2 启用）',
  '/help                 显示本帮助',
].join('\n')

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

async function handleUse(ctx: CommandContext, args: string[]): Promise<string> {
  if (args.length === 0) return '用法: /use <n|name> 或 /use s <n>'

  // /use s <n> — session bind (deferred to phase 2)
  if (args[0] === 's' || args[0] === 'session') {
    return 'session binding 在 phase 2 启用'
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
    case 'last':
    case 'new':
      return `${command.name} 在后续 phase 启用`
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
