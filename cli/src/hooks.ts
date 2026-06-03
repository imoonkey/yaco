import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, unlinkSync, rmdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getYacoHome, hookV2ScriptPath, wrapperV2ScriptPath } from "./yacoHome.ts";

// Managed scripts live under ${YACO_HOME:-~/.yaco}/ — see yacoHome.ts.
// The script bodies derive their session-state directory at run time using the
// same precedence as state.ts: MULTMUX_STATE_DIR first (explicit override),
// then ${YACO_HOME:-$HOME/.yaco}/sessions.
const HOOK_V2_SCRIPT_PATH = hookV2ScriptPath();
const WRAPPER_V2_SCRIPT_PATH = wrapperV2ScriptPath();

// Marker comment to identify multmux-managed hook entries
const HOOK_MARKER = "multmux-hook";

// V2 hook script — no env vars (other than the state-dir override), hardcoded
// global path under YACO_HOME, handle = tmux session name.
const HOOK_V2_SCRIPT = `#!/bin/bash
# multmux hook handler v2 — handle = tmux session name, global state dir
handle=$(tmux display-message -p '#{session_name}' 2>/dev/null)
[ -z "$handle" ] && exit 0
sd="\${MULTMUX_STATE_DIR:-\${YACO_HOME:-$HOME/.yaco}/sessions}"
f="$sd/$handle.json"
[ ! -f "$f" ] && exit 0

input=$(cat)
event=$(printf '%s' "$input" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')

set_field() {
  sed "s/\\"$1\\":\\"[^\\"]*\\"/\\"$1\\":\\"$2\\"/" "$f" > "$f.$$.tmp" && mv "$f.$$.tmp" "$f"
}

case "$event" in
  SessionStart)
    current=$(sed -n 's/.*"status":"\\([^"]*\\)".*/\\1/p' "$f")
    [ "$current" = "processing" ] && exit 0
    sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
    if [ -n "$sid" ]; then
      safe_sid=$(printf '%s' "$sid" | sed 's/[&/\\\\]/\\\\&/g')
      sed -e 's/"status":"[^"]*"/"status":"idle"/' -e "s/\\"sessionId\\":\\"[^\\"]*\\"/\\"sessionId\\":\\"$safe_sid\\"/" "$f" > "$f.$$.tmp" && mv "$f.$$.tmp" "$f"
    else
      set_field status idle
    fi
    ;;
  UserPromptSubmit)
    current_sid=$(sed -n 's/.*"sessionId":"\\([^"]*\\)".*/\\1/p' "$f")
    if [ -z "$current_sid" ] || [ "$current_sid" = "pending:awaiting-first-prompt" ]; then
      sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
      if [ -n "$sid" ]; then
        safe_sid=$(printf '%s' "$sid" | sed 's/[&/\\\\]/\\\\&/g')
        sed -e 's/"status":"[^"]*"/"status":"processing"/' -e "s/\\"sessionId\\":\\"[^\\"]*\\"/\\"sessionId\\":\\"$safe_sid\\"/" "$f" > "$f.$$.tmp" && mv "$f.$$.tmp" "$f"
        exit 0
      fi
    fi
    set_field status processing
    ;;
  Stop|StopFailure)
    # Debounce: if UserPromptSubmit just wrote the file (async race between
    # turn N Stop and turn N+1 UserPromptSubmit), back off.
    before=$(cat "$f")
    sleep 0.3
    after=$(cat "$f")
    [ "$before" != "$after" ] && exit 0
    set_field status idle
    ;;
  PreToolUse|PostToolUse|PostToolUseFailure|PreCompact|PostCompact)
    # Tool call or compaction in progress — agent is still processing.
    set_field status processing
    ;;
  PermissionRequest)
    # Waiting for user approval — effectively idle.
    set_field status idle
    ;;
  Notification)
    # Notification carries semantic state. idle_prompt and permission_prompt
    # both mean the agent is waiting (idle); other types don't change status.
    ntype=$(printf '%s' "$input" | sed -n 's/.*"notification_type"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
    case "$ntype" in
      idle_prompt|permission_prompt) set_field status idle ;;
    esac
    ;;
  SessionEnd)
    tmux has-session -t "=$handle" 2>/dev/null && set_field status idle
    ;;
esac
`;

// V2 wrapper — handle passed as $1 by buildWrappedCommand (no tmux query at startup)
const WRAPPER_V2_SCRIPT = `#!/bin/bash
# multmux session wrapper v2 — handle + createdAt passed explicitly, global state dir
sd="\${MULTMUX_STATE_DIR:-\${YACO_HOME:-$HOME/.yaco}/sessions}"
sn="\${1:?wrapper requires handle as first arg}"
created_at="\${2:?wrapper requires createdAt as second arg}"
shift 2
trap '
  should_delete=1
  # Only re-read session name if tmux session is still alive (rename case).
  # Do NOT query display-message on a dead session — tmux falls back to a
  # random other session, causing deletion of the wrong state file.
  name="$sn"
  if tmux has-session -t "=$sn" 2>/dev/null; then
    cn=$(tmux display-message -p -t "=$sn" "#{session_name}" 2>/dev/null)
    [ -n "$cn" ] && name="$cn"
  elif [ -f "$sd/.renamed-$sn" ]; then
    name=$(cat "$sd/.renamed-$sn")
  fi
  # Clean up breadcrumb regardless of how we resolved the name
  rm -f "$sd/.renamed-$sn"
  if [ -n "$name" ] && [ -f "$sd/$name.json" ]; then
    current_created_at=$(sed -n "s/.*\\"createdAt\\":\\"\\([^\\"]*\\)\\".*/\\1/p" "$sd/$name.json")
    if [ -n "$current_created_at" ] && [ "$current_created_at" != "$created_at" ]; then
      should_delete=0
    fi
  fi
  [ -n "$name" ] && [ "$should_delete" = "1" ] && {
    rm -f "$sd/$name.json" "$sd/$name".json.*.tmp
    sleep 0.3
    rm -f "$sd/$name.json" "$sd/$name".json.*.tmp
  }
' EXIT
# Strip npm_config_* / npm_lifecycle_* / npm_package_* leaked when the parent
# was launched via \`npm run\`; nvm refuses to initialize otherwise. The tmux
# server caches its initial env, so this can persist even when the immediate
# parent already stripped them.
unset $(env | awk -F= '/^npm_(config|lifecycle|package)_/{print $1}')
# Run the agent through a login + interactive bash so it sees the same env as
# if launched from a terminal (sources /etc/profile, ~/.profile, ~/.bashrc) —
# this is what makes SSH_AUTH_SOCK / PATH / etc behave the same in workflow
# as in a hand-opened terminal. \`_\` becomes \$0; original args become \$@.
bash -lic 'exec "$@"' _ "$@"
`;

// Use v2 hook command for new sessions
function hookCommand(): string {
  return `bash "${HOOK_V2_SCRIPT_PATH}"`;
}

function makeHookEntry(async_: boolean, timeout?: number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: "command",
    command: hookCommand(),
    async: async_,
  };
  if (timeout !== undefined) entry.timeout = timeout;
  return entry;
}

function multmuxHookGroup(async_: boolean = true): Record<string, unknown> {
  return {
    matcher: HOOK_MARKER,
    hooks: [makeHookEntry(async_)],
  };
}

/** Tool-scoped hooks (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest)
 *  interpret `matcher` as a tool-name filter, not a label. Use "*" to match all tools. */
function multmuxToolHookGroup(async_: boolean = true): Record<string, unknown> {
  return {
    matcher: "*",
    hooks: [makeHookEntry(async_)],
  };
}

/** Events whose `matcher` field is a content filter (tool name, notification type,
 *  compaction trigger, etc.) rather than a label. These need "*" to match all. */
const TOOL_SCOPED_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "PreCompact", "PostCompact"]);

function multmuxSessionEndHookGroup(): Record<string, unknown> {
  return {
    matcher: HOOK_MARKER,
    hooks: [makeHookEntry(true, 1)],
  };
}

const CLAUDE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "PreCompact", "PostCompact", "SessionEnd"] as const;
const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "PreCompact", "PostCompact", "Stop"] as const;

/** Write a managed script to the YACO runtime root if missing or outdated */
function ensureManagedScript(path: string, content: string): void {
  const yacoHome = getYacoHome();
  if (!existsSync(yacoHome)) mkdirSync(yacoHome, { recursive: true });
  const needsWrite = !existsSync(path) || readFileSync(path, "utf-8") !== content;
  if (needsWrite) {
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
}

/** Check if a hooks array already has a multmux entry */
function hasMultmuxHook(hookGroups: unknown[]): boolean {
  return hookGroups.some((group: any) =>
    group?.matcher === HOOK_MARKER ||
    group?.hooks?.some((h: any) => isMultmuxHookCommand(h?.command)),
  );
}

function isMultmuxHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return command.includes("multmux") || /(^|[/\\])hook-v2\.sh(["'\s]|$)/.test(command);
}

/** Update existing multmux hook entries to use v2 script path */
function upgradeHookToV2(hookGroups: unknown[]): boolean {
  let changed = false;
  for (const group of hookGroups) {
    const g = group as any;
    if (g?.matcher !== HOOK_MARKER && g?.matcher !== "*") continue;
    // Only touch groups that contain a multmux command
    const isOurs = g?.hooks?.some((h: any) => isMultmuxHookCommand(h?.command));
    if (!isOurs) continue;
    for (const hook of g.hooks ?? []) {
      if (typeof hook.command === "string" && isMultmuxHookCommand(hook.command) && hook.command !== hookCommand()) {
        hook.command = hookCommand();
        changed = true;
      }
    }
  }
  return changed;
}

/** Fix legacy matcher for tool-scoped events: change "multmux-hook" to "*".
 *  Claude Code interprets matcher as a tool-name filter for PreToolUse/PostToolUse/
 *  PostToolUseFailure/PermissionRequest — "multmux-hook" never matches any tool. */
function fixToolHookMatcher(hookGroups: unknown[]): boolean {
  let changed = false;
  for (const group of hookGroups) {
    const g = group as any;
    if (g?.matcher !== HOOK_MARKER) continue;
    const isOurs = g?.hooks?.some((h: any) => isMultmuxHookCommand(h?.command));
    if (!isOurs) continue;
    g.matcher = "*";
    changed = true;
  }
  return changed;
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

  // Delete deprecated on-stop.sh file
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

/** Merge multmux hooks into ~/.claude/settings.json */
export function ensureClaudeHooks(): void {
  const claudeDir = join(homedir(), ".claude");
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

  // Ensure hooks is an object, not array or other type
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  let changed = false;

  for (const event of CLAUDE_HOOK_EVENTS) {
    settings.hooks[event] = settings.hooks[event] || [];
    if (!hasMultmuxHook(settings.hooks[event])) {
      const group = event === "SessionEnd" ? multmuxSessionEndHookGroup()
        : TOOL_SCOPED_EVENTS.has(event) ? multmuxToolHookGroup()
        : multmuxHookGroup();
      settings.hooks[event].push(group);
      changed = true;
    } else {
      if (upgradeHookToV2(settings.hooks[event])) changed = true;
      // Fix legacy matcher for tool-scoped events (was "multmux-hook", should be "*")
      if (TOOL_SCOPED_EVENTS.has(event) && fixToolHookMatcher(settings.hooks[event])) changed = true;
    }
  }

  // Clean up deprecated on-stop.sh hook entries and file
  if (cleanupDeprecatedHooks(settings, claudeDir)) changed = true;

  if (changed) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
}

/** Merge multmux hooks into ~/.codex/hooks.json (best-effort, experimental) */
export function ensureCodexHooks(): void {
  const hooksDir = join(homedir(), ".codex");
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
    if (!hasMultmuxHook(hooks.hooks[event])) {
      // Codex doesn't support async hooks — use sync
      const group = TOOL_SCOPED_EVENTS.has(event) ? multmuxToolHookGroup(false) : multmuxHookGroup(false);
      hooks.hooks[event].push(group);
      changed = true;
    } else {
      if (upgradeHookToV2(hooks.hooks[event])) changed = true;
      if (TOOL_SCOPED_EVENTS.has(event) && fixToolHookMatcher(hooks.hooks[event])) changed = true;
    }
  }

  if (changed) {
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + "\n");
  }

  // Keep old Codex versions quiet when hooks are still treated as unstable.
  if (existsSync(configPath)) {
    const config = readFileSync(configPath, "utf-8");
    if (!config.includes("suppress_unstable_features_warning")) {
      // Prepend to keep it top-level (before any [section] headers)
      writeFileSync(configPath, "suppress_unstable_features_warning = true\n" + config);
    }
  } else {
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
    writeFileSync(configPath, "suppress_unstable_features_warning = true\n");
  }
}

/** Ensure hooks and wrapper are installed for the given provider */
export function ensureHooks(provider: string): void {
  ensureManagedScript(HOOK_V2_SCRIPT_PATH, HOOK_V2_SCRIPT);
  ensureManagedScript(WRAPPER_V2_SCRIPT_PATH, WRAPPER_V2_SCRIPT);
  if (provider === "claude") {
    ensureClaudeHooks();
  } else if (provider === "codex") {
    ensureCodexHooks();
  }
}

/** Wrap a command string so it runs inside the exit-trap wrapper (v2). */
export function buildWrappedCommand(handle: string, createdAt: string, command: string, startupDelaySeconds = 0): string {
  const delayedCommand = startupDelaySeconds > 0
    ? `bash -lc 'sleep ${startupDelaySeconds}; exec "$@"' _ ${command}`
    : command;
  return `bash "${WRAPPER_V2_SCRIPT_PATH}" "${handle}" "${createdAt}" ${delayedCommand}`;
}

// Exported for testing
export {
  HOOK_V2_SCRIPT,
  HOOK_V2_SCRIPT_PATH,
  WRAPPER_V2_SCRIPT,
  WRAPPER_V2_SCRIPT_PATH,
  HOOK_MARKER, CLAUDE_HOOK_EVENTS, CODEX_HOOK_EVENTS,
  TOOL_SCOPED_EVENTS, fixToolHookMatcher, hasMultmuxHook, multmuxToolHookGroup, multmuxHookGroup, upgradeHookToV2,
};
