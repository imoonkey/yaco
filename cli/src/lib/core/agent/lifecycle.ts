/** Agent lifecycle: install the wrapper script and merge provider hook configs.
 *
 *  Hooks are now wired directly at the TS entry point — provider configs point
 *  at `yaco agent hook-event <Event>`, which reads stdin JSON and updates the
 *  state file. The only shell artifact is `agent-wrapper.sh`, which has to be
 *  shell so its EXIT trap fires even if the tmux pane dies abruptly (the design
 *  Shell Boundary exception).
 *
 *  The wrapper body is shipped as a real file under `cli/scripts/`; this module
 *  reads it from disk and writes it to `${YACO_HOME}/agent-wrapper.sh` on
 *  install. No embedded shell strings.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, unlinkSync, rmdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { execSync } from "child_process";
import { homedir } from "os";
import { getYacoHome, agentWrapperPath } from "../paths/yaco-home.ts";

/** Honor $HOME at call time. Bun's os.homedir() caches at process start,
 *  which breaks tests that swap HOME between invocations. */
function userHome(): string {
  const env = process.env["HOME"];
  return env && env.length > 0 ? env : homedir();
}

// Marker comment to identify yaco-managed hook entries.
const HOOK_MARKER = "yaco-agent-hook";

/** Locate cli/src/main.ts shipped with this package. */
function packagedMainPath(): string {
  // import.meta.url → .../cli/src/lib/core/agent/lifecycle.ts
  // resolve(..., "../../../main.ts") → cli/src/main.ts
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../main.ts");
}

/** Locate the slim hook-event entry point shipped with this package. */
function packagedHookEventBin(): string {
  // import.meta.url → .../cli/src/lib/core/agent/lifecycle.ts
  // resolve(..., "../../../hook-event-bin.ts") → cli/src/hook-event-bin.ts
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../hook-event-bin.ts");
}

/** Resolve the hook entry command. Always returns an absolute invocation so
 *  the hook works even if PATH at hook-fire time differs from PATH at install
 *  time (tmux server env, interactive vs login shell, etc.). Uses the slim
 *  bun entry to keep the per-event cold-start under control. */
let _cachedHookBinary: string | null = null;
function hookBinary(): string {
  if (_cachedHookBinary !== null) return _cachedHookBinary;
  _cachedHookBinary = `bun ${packagedHookEventBin()}`;
  return _cachedHookBinary;
}

// Hook command points at the canonical TS entry. Provider hook runners spawn
// this with the event name as the argv.
function hookCommand(event: string): string {
  return `${hookBinary()} ${event}`;
}

/** Locate the on-disk agent-wrapper.sh shipped with the cli package. */
function packagedAgentWrapperPath(): string {
  // import.meta.url → .../cli/src/lib/core/agent/lifecycle.ts
  // resolve(..., "../../../../scripts/agent-wrapper.sh") → cli/scripts/agent-wrapper.sh
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/agent-wrapper.sh");
}

/** Read the packaged wrapper script body. */
export function readAgentWrapperScript(): string {
  return readFileSync(packagedAgentWrapperPath(), "utf-8");
}

function makeHookEntry(event: string, async_: boolean, timeout?: number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: "command",
    command: hookCommand(event),
    async: async_,
  };
  if (timeout !== undefined) entry.timeout = timeout;
  return entry;
}

function yacoHookGroup(event: string, async_ = true): Record<string, unknown> {
  return {
    matcher: HOOK_MARKER,
    hooks: [makeHookEntry(event, async_)],
  };
}

/** Tool-scoped hooks (PreToolUse, PostToolUse, ...) interpret `matcher` as a
 *  tool-name filter, not a label. Use "*" to match all tools. */
function yacoToolHookGroup(event: string, async_ = true): Record<string, unknown> {
  return {
    matcher: "*",
    hooks: [makeHookEntry(event, async_)],
  };
}

/** Events whose `matcher` field is a content filter (tool name, notification type,
 *  compaction trigger, etc.) rather than a label. These need "*" to match all. */
const TOOL_SCOPED_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "PreCompact",
  "PostCompact",
]);

function yacoSessionEndHookGroup(event: string): Record<string, unknown> {
  return {
    matcher: HOOK_MARKER,
    hooks: [makeHookEntry(event, true, 1)],
  };
}

const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;
const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "Stop",
] as const;

/** Write a managed script to the YACO runtime root if missing or outdated. */
function ensureManagedScript(path: string, content: string): void {
  const yacoHome = getYacoHome();
  if (!existsSync(yacoHome)) mkdirSync(yacoHome, { recursive: true });
  const needsWrite = !existsSync(path) || readFileSync(path, "utf-8") !== content;
  if (needsWrite) {
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
}

/** True if any hook in this group is a yaco-managed entry. Matches both the
 *  slim hook-event-bin invocation and the (alternative) main.ts dispatch form. */
function isYacoHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return /hook-event-bin\.ts\b|\bagent\s+hook-event\b/.test(command);
}

/** True if a hook group was authored by yaco (marker matcher OR yaco-shaped
 *  command). We need both signals because tool-scoped entries use matcher
 *  "*" (a user could legitimately author the same matcher), so the marker
 *  alone is not enough to disambiguate ownership. */
function isYacoOwnedGroup(group: any): boolean {
  if (group?.matcher === HOOK_MARKER) return true;
  if (!Array.isArray(group?.hooks)) return false;
  return group.hooks.some((h: any) => isYacoHookCommand(h?.command));
}

function hasYacoHook(hookGroups: unknown[]): boolean {
  return hookGroups.some((g) => isYacoOwnedGroup(g));
}

/** Deep-equal a yaco hook group against the target shape so install can
 *  detect drift (stale command from a prior version) and overwrite in place
 *  without disturbing the entry's array position. */
function hookGroupEqual(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a.matcher !== b.matcher) return false;
  const ah = Array.isArray(a.hooks) ? a.hooks : [];
  const bh = Array.isArray(b.hooks) ? b.hooks : [];
  if (ah.length !== bh.length) return false;
  for (let i = 0; i < ah.length; i++) {
    if (ah[i]?.command !== bh[i]?.command) return false;
    if (ah[i]?.async !== bh[i]?.async) return false;
    if (ah[i]?.timeout !== bh[i]?.timeout) return false;
    if (ah[i]?.type !== bh[i]?.type) return false;
  }
  return true;
}

/** Idempotent merge: add the target yaco group when absent; if a yaco-owned
 *  group is already present but differs (stale command after upgrade), replace
 *  it in place. Returns true when the array changed. */
function upsertYacoGroup(
  groups: any[],
  targetGroup: Record<string, unknown>,
): boolean {
  const existingIdx = groups.findIndex((g) => isYacoOwnedGroup(g));
  if (existingIdx === -1) {
    groups.push(targetGroup);
    return true;
  }
  if (!hookGroupEqual(groups[existingIdx], targetGroup)) {
    groups[existingIdx] = targetGroup;
    return true;
  }
  return false;
}

/** Remove deprecated on-stop.sh entries from a settings object and delete the hook file.
 *  Extracted for testability — ensureClaudeHooks delegates to this. */
export function cleanupDeprecatedHooks(settings: Record<string, any>, claudeDir: string): boolean {
  let changed = false;

  if (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)) {
    for (const event of Object.keys(settings.hooks)) {
      const groups = settings.hooks[event];
      if (!Array.isArray(groups)) continue;
      const before = groups.length;
      settings.hooks[event] = groups.filter((group: any) => {
        if (group.matcher) return true;
        return !group.hooks?.some((h: any) =>
          typeof h.command === "string" && h.command.includes("on-stop.sh"),
        );
      });
      if (settings.hooks[event].length !== before) changed = true;
    }
  }

  const deprecatedHook = join(claudeDir, "hooks", "on-stop.sh");
  if (existsSync(deprecatedHook)) {
    try {
      unlinkSync(deprecatedHook);
      const hooksDir = join(claudeDir, "hooks");
      if (existsSync(hooksDir) && readdirSync(hooksDir).length === 0) {
        rmdirSync(hooksDir);
      }
    } catch { /* best effort */ }
  }

  return changed;
}

/** Merge yaco hooks into ~/.claude/settings.json. Preserves all unrelated entries. */
export function ensureClaudeHooks(): void {
  const claudeDir = join(userHome(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error("Warning: could not parse ~/.claude/settings.json — hooks not installed");
      return;
    }
  }

  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  let changed = false;

  for (const event of CLAUDE_HOOK_EVENTS) {
    settings.hooks[event] = settings.hooks[event] || [];
    const targetGroup = event === "SessionEnd" ? yacoSessionEndHookGroup(event)
      : TOOL_SCOPED_EVENTS.has(event) ? yacoToolHookGroup(event)
      : yacoHookGroup(event);
    if (upsertYacoGroup(settings.hooks[event], targetGroup)) changed = true;
  }

  if (cleanupDeprecatedHooks(settings, claudeDir)) changed = true;

  if (changed) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
}

/** Merge yaco hooks into ~/.codex/hooks.json (best-effort, experimental). */
export function ensureCodexHooks(): void {
  const hooksDir = join(userHome(), ".codex");
  const hooksPath = join(hooksDir, "hooks.json");
  const configPath = join(hooksDir, "config.toml");

  let hooks: Record<string, any> = {};
  if (existsSync(hooksPath)) {
    try {
      hooks = JSON.parse(readFileSync(hooksPath, "utf-8"));
    } catch {
      return;
    }
  }

  if (!hooks.hooks || typeof hooks.hooks !== "object" || Array.isArray(hooks.hooks)) {
    hooks.hooks = {};
  }
  let changed = false;

  for (const event of CODEX_HOOK_EVENTS) {
    hooks.hooks[event] = hooks.hooks[event] || [];
    // Codex doesn't support async hooks — use sync
    const targetGroup = TOOL_SCOPED_EVENTS.has(event)
      ? yacoToolHookGroup(event, false)
      : yacoHookGroup(event, false);
    if (upsertYacoGroup(hooks.hooks[event], targetGroup)) changed = true;
  }

  if (changed) {
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + "\n");
  }

  // Keep old Codex versions quiet when hooks are still treated as unstable.
  if (existsSync(configPath)) {
    const config = readFileSync(configPath, "utf-8");
    if (!config.includes("suppress_unstable_features_warning")) {
      writeFileSync(configPath, "suppress_unstable_features_warning = true\n" + config);
    }
  } else {
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
    writeFileSync(configPath, "suppress_unstable_features_warning = true\n");
  }
}

/** Ensure the wrapper script and the provider hook configs are in place. */
export function ensureHooks(provider: string): void {
  ensureManagedScript(agentWrapperPath(), readAgentWrapperScript());
  if (provider === "claude") {
    ensureClaudeHooks();
  } else if (provider === "codex") {
    ensureCodexHooks();
  }
}

/** Wrap a command string so it runs inside the exit-trap wrapper. */
export function buildWrappedCommand(handle: string, createdAt: string, command: string, startupDelaySeconds = 0): string {
  const delayedCommand = startupDelaySeconds > 0
    ? `bash -lc 'sleep ${startupDelaySeconds}; exec "$@"' _ ${command}`
    : command;
  return `bash "${agentWrapperPath()}" "${handle}" "${createdAt}" ${delayedCommand}`;
}

export {
  HOOK_MARKER,
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  TOOL_SCOPED_EVENTS,
  hasYacoHook,
  isYacoHookCommand,
  yacoHookGroup,
  yacoToolHookGroup,
  hookCommand,
};
