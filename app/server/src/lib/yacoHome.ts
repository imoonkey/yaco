import { homedir } from 'os'
import { join } from 'path'

/** Resolve the YACO runtime root.
 *
 *  Order of precedence:
 *    1. process.env.YACO_HOME (absolute path expected; honored verbatim)
 *    2. ~/.yaco
 *
 *  This consolidates the runtime roots that used to live at `~/.workflow`
 *  and `~/.multmux`. Vendor roots (`~/.claude`, `~/.codex`) are out of scope.
 *  See projects/active/yaco-core/final/design.md (Canonical Path Layout).
 */
export function getYacoHome(): string {
  return process.env.YACO_HOME || join(homedir(), '.yaco')
}

/** ${YACO_HOME}/projects.json — YACO project registry */
export function projectsFile(): string {
  return join(getYacoHome(), 'projects.json')
}

/** ${YACO_HOME}/sessions — multmux agent session-state directory.
 *
 *  YACO reads this dir to project multmux state files into the session
 *  list and to drive SSE invalidation. Multmux owns writes. The resolver
 *  mirrors `multmux/src/yacoHome.ts#sessionsDir()` — keep them aligned. */
export function sessionsDir(): string {
  return join(getYacoHome(), 'sessions')
}

/** ${YACO_HOME}/ui-state — notification inbox, pinned sessions, watermarks */
export function uiStateDir(): string {
  return join(getYacoHome(), 'ui-state')
}

/** ${YACO_HOME}/shell-sessions — YACO-managed tmux shell records */
export function shellSessionsDir(): string {
  return join(getYacoHome(), 'shell-sessions')
}

/** ${YACO_HOME}/channels — wechat/whatsapp/etc. messaging channel state */
export function channelsDir(): string {
  return join(getYacoHome(), 'channels')
}

/** ${YACO_HOME}/channels/<scope> — per-channel state directory */
export function channelScopeDir(scope: string): string {
  return join(channelsDir(), scope)
}

/** ${YACO_HOME}/projects/<id>/events.jsonl — append-only event stream */
export function projectEventsFile(projectId: string): string {
  return join(getYacoHome(), 'projects', projectId, 'events.jsonl')
}
