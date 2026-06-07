/** `yaco agent hooks install` — install provider hook configs and the wrapper.
 *
 *  Writes ${YACO_HOME}/agent-wrapper.sh, then merges yaco-owned entries into
 *  ~/.claude/settings.json and ~/.codex/hooks.json. All pre-existing entries
 *  authored by the user (or other tools) are preserved; legacy multmux hooks
 *  are dropped on the way through.
 */
import { ok, type Result } from "../../../lib/core/result.ts";
import { dual } from "../../../lib/core/render.ts";
import { ensureHooks } from "../../../lib/core/agent/lifecycle.ts";
import { listProviders } from "../../../lib/core/agent/providers/index.ts";

const HELP = `yaco agent hooks install [--json]

Install or refresh the YACO agent hooks for Claude and Codex. Writes the
agent-wrapper.sh helper under \${YACO_HOME} and merges yaco-owned entries into
~/.claude/settings.json and ~/.codex/hooks.json (other entries preserved).
`;

export async function handleHooksInstall(
  argv: string[],
  json = false,
): Promise<Result<unknown>> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return ok({ help: HELP });
  }
  const installed: string[] = [];
  for (const provider of listProviders()) {
    if (!provider.hooks) continue;
    ensureHooks(provider.id);
    installed.push(provider.id);
  }
  return dual(json || argv.includes("--json"), { installed }, () =>
    `installed hooks: ${installed.join(", ") || "(none)"}\n`,
  );
}
