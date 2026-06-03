import { homedir } from "os";
import { join } from "path";

/** Resolve the YACO runtime root.
 *
 *  Order of precedence:
 *    1. process.env.YACO_HOME (honored verbatim — absolute path expected)
 *    2. ~/.yaco
 *
 *  YACO consolidates the runtime roots that used to live at ~/.workflow and
 *  ~/.multmux. Multmux owns the agent session-state directory and the
 *  hook/wrapper scripts within that root.
 */
export function getYacoHome(): string {
  return process.env.YACO_HOME || join(homedir(), ".yaco");
}

/** ${YACO_HOME}/hook-v2.sh — managed Claude/Codex hook handler script. */
export function hookV2ScriptPath(): string {
  return join(getYacoHome(), "hook-v2.sh");
}

/** ${YACO_HOME}/wrapper-v2.sh — managed agent session wrapper script. */
export function wrapperV2ScriptPath(): string {
  return join(getYacoHome(), "wrapper-v2.sh");
}

/** ${YACO_HOME}/sessions — multmux agent session-state directory.
 *
 *  This is the default sessions root used by state.ts and referenced from the
 *  hook/wrapper script bodies. The MULTMUX_STATE_DIR env var is an explicit
 *  override applied on top of this default (see state.ts sessionsRoot). */
export function sessionsDir(): string {
  return join(getYacoHome(), "sessions");
}
