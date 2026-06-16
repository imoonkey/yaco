/** Resolve the YACO runtime root.
 *
 *  Order of precedence:
 *    1. process.env.YACO_HOME (honored verbatim when non-empty)
 *    2. ~/.yaco
 *
 *  YACO consolidates the runtime roots that used to live at ~/.workflow and
 *  ~/.multmux. Vendor roots (~/.claude, ~/.codex) stay out of scope.
 *
 *  Bun/Node neutral: uses only node:os and node:path so the same TypeScript
 *  source can be consumed from cli (Bun) and app/server (Node via tsx/vitest).
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function getYacoHome(): string {
  const env = process.env["YACO_HOME"];
  if (env && env.length > 0) return env;
  return join(homedir(), ".yaco");
}

/** ${YACO_HOME}/projects.json — YACO project registry. */
export function projectsFile(): string {
  return join(getYacoHome(), "projects.json");
}

/** ${YACO_HOME}/sessions — multmux agent session-state directory. */
export function sessionsDir(): string {
  return join(getYacoHome(), "sessions");
}

/** ${YACO_HOME}/agent/origins — durable per-provider-session origin records. */
export function originsDir(): string {
  return join(getYacoHome(), "agent", "origins");
}

/** ${YACO_HOME}/ui-state — notification inbox, pinned sessions, watermarks. */
export function uiStateDir(): string {
  return join(getYacoHome(), "ui-state");
}

/** ${YACO_HOME}/shell-sessions — YACO-managed tmux shell records. */
export function shellSessionsDir(): string {
  return join(getYacoHome(), "shell-sessions");
}

/** ${YACO_HOME}/channels — messaging channel state root. */
export function channelsDir(): string {
  return join(getYacoHome(), "channels");
}

/** ${YACO_HOME}/channels/<scope> — per-channel state directory. */
export function channelScopeDir(scope: string): string {
  return join(channelsDir(), scope);
}

/** ${YACO_HOME}/projects/<id>/events.jsonl — append-only event stream. */
export function projectEventsFile(projectId: string): string {
  return join(getYacoHome(), "projects", projectId, "events.jsonl");
}

/** ${YACO_HOME}/agent-wrapper.sh — managed agent session wrapper script. */
export function agentWrapperPath(): string {
  return join(getYacoHome(), "agent-wrapper.sh");
}
