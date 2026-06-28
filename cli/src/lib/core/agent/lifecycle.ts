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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, unlinkSync, rmdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { execSync } from "child_process";
import { homedir } from "os";
import { getYacoHome, agentWrapperPath } from "../paths/yaco-home.ts";
import { getProvider } from "./providers/index.ts";
import { CliError, ErrCode } from "../errors.ts";

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

/** Resolve the hook entry command. Canonical form per the install/distribution
 *  design: `<absolute-yaco-binary> agent hook-event <Event>` — points at the
 *  installed binary, NOT repo-local source. The previous `bun .../hook-event-bin.ts`
 *  form broke the moment yaco was installed without a checkout (no bun, no
 *  source files). Always returns an absolute invocation so the hook works even
 *  if PATH at hook-fire time is stripped (tmux server env, etc.).
 *
 *  Resolution order:
 *    1. $YACO_BIN_DIR/yaco — set by tools/install.sh during bootstrap
 *    2. process.argv[0] — when invoked from the compiled bun binary, this IS
 *       the yaco binary; reuse it so doctor + install produce identical hook
 *       commands.
 *    3. `which yaco` — fall back to PATH lookup at install time.
 *    4. literal "yaco" — last resort; the hook will fail at fire time but
 *       install still completes so the user can diagnose.
 *
 *  main.ts has a parallel fast-path for `argv[0:2] === ['agent','hook-event']`
 *  that lazy-imports only the hook-event handler, preserving the per-event
 *  cold-start budget that hook-event-bin.ts used to provide. */
let _cachedHookBinary: string | null = null;
function hookBinary(): string {
  if (_cachedHookBinary !== null) return _cachedHookBinary;
  _cachedHookBinary = resolveYacoBinary();
  return _cachedHookBinary;
}

function resolveYacoBinary(): string {
  const envBin = process.env["YACO_BIN_DIR"];
  if (envBin && envBin.length > 0) {
    const candidate = resolve(envBin, "yaco");
    if (existsSync(candidate)) return candidate;
  }
  // process.argv[0] is the bun-compiled binary itself when yaco runs as a
  // compiled artifact. Detect by checking the basename, which is always
  // "yaco" for the compiled output and "bun" otherwise.
  const arg0 = process.argv[0];
  if (arg0 && arg0.endsWith("/yaco")) return arg0;
  // PATH lookup at install time. Pass env explicitly so tests that override
  // PATH still find the right binary.
  try {
    const r = execSync("which yaco", { encoding: "utf-8" }).trim();
    if (r.length > 0) return r;
  } catch { /* fall through */ }
  return "yaco";
}

// Hook command points at the canonical TS entry. Provider hook runners spawn
// this with the event name as the argv.
function hookCommand(event: string): string {
  return `${hookBinary()} agent hook-event ${event}`;
}

/** Test helper: reset the hook binary resolution cache. The lifecycle module
 *  caches the resolved yaco path on first use; tests that change PATH or
 *  $YACO_BIN_DIR mid-process need to invalidate it. */
export function _resetHookBinaryCacheForTests(): void {
  _cachedHookBinary = null;
}

/** Locate the on-disk agent-wrapper.sh shipped with the cli package.
 *
 *  Under `bun run`, import.meta.url points at the real source file and
 *  the sibling `cli/scripts/agent-wrapper.sh` exists. Under a
 *  `bun build --compile` binary, import.meta.url resolves into the bun
 *  runtime's virtual fs (e.g. `/scripts/agent-wrapper.sh`) which has no
 *  file siblings on disk — this function returns that virtual path
 *  unconditionally; the caller is expected to existsSync() before reading
 *  and fall back via {@link findExistingWrapperPath}. */
function packagedAgentWrapperPath(): string {
  // import.meta.url → .../cli/src/lib/core/agent/lifecycle.ts
  // resolve(..., "../../../../scripts/agent-wrapper.sh") → cli/scripts/agent-wrapper.sh
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/agent-wrapper.sh");
}

/** Walk a fallback chain to find the on-disk agent-wrapper.sh. The packaged
 *  path wins when it exists (i.e. under `bun run`); otherwise the chain falls
 *  back to a yaco checkout located via the explicit `repoRoot` arg, then
 *  `$YACO_REPO_ROOT`, then `git rev-parse --show-toplevel` from cwd. Returns
 *  null when nothing matches — the caller surfaces a CliError.
 *
 *  Exported as `_findExistingWrapperPathForTests` so the fallback chain can be
 *  exercised under `bun run` (where the packaged path always wins and the
 *  branch would otherwise be dead code in tests). */
function findExistingWrapperPath(packaged: string, repoRoot?: string): string | null {
  if (existsSync(packaged)) return packaged;
  const candidates: string[] = [];
  if (repoRoot && repoRoot.length > 0) {
    candidates.push(join(repoRoot, "cli", "scripts", "agent-wrapper.sh"));
  }
  const envRoot = process.env["YACO_REPO_ROOT"];
  if (envRoot && envRoot.length > 0) {
    candidates.push(join(envRoot, "cli", "scripts", "agent-wrapper.sh"));
  }
  try {
    const gitTop = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (gitTop.length > 0) {
      candidates.push(join(gitTop, "cli", "scripts", "agent-wrapper.sh"));
    }
  } catch { /* not in a git repo, or no git — try cwd directly */ }
  candidates.push(join(process.cwd(), "cli", "scripts", "agent-wrapper.sh"));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export const _findExistingWrapperPathForTests = findExistingWrapperPath;

/** Resolve an on-disk agent-wrapper.sh path; throws INTERNAL when neither the
 *  bundled location nor any fallback exists. Optional `repoRoot` is the
 *  highest-priority fallback (used by install where the caller already knows
 *  the repo). */
function resolveAgentWrapperPath(repoRoot?: string): string {
  const found = findExistingWrapperPath(packagedAgentWrapperPath(), repoRoot);
  if (found === null) {
    throw new CliError(
      ErrCode.INTERNAL,
      "cannot locate agent-wrapper.sh — set YACO_REPO_ROOT to a yaco checkout or reinstall",
    );
  }
  return found;
}

/** Read the on-disk agent-wrapper.sh body. Under `bun run` this resolves to
 *  the packaged path; under a bun-compiled binary it falls back to a yaco
 *  checkout via `repoRoot` / `$YACO_REPO_ROOT` / `process.cwd()`. */
export function readAgentWrapperScript(repoRoot?: string): string {
  return readFileSync(resolveAgentWrapperPath(repoRoot), "utf-8");
}

/** Ensure the runtime wrapper exists under ${YACO_HOME}. Runtime starts should
 *  not require the source checkout: after `yaco install`, the managed wrapper is
 *  already the deployable artifact. When the source script is discoverable we
 *  refresh it; otherwise we trust the installed copy and only fail if it is
 *  missing or not a file. */
function ensureAgentWrapperScriptFrom(packaged: string, repoRoot?: string): void {
  const managedPath = agentWrapperPath();
  const sourcePath = findExistingWrapperPath(packaged, repoRoot);
  if (sourcePath !== null) {
    ensureManagedScript(managedPath, readFileSync(sourcePath, "utf-8"));
    return;
  }

  if (!existsSync(managedPath)) {
    throw new CliError(
      ErrCode.INTERNAL,
      `${managedPath} missing and cannot locate agent-wrapper.sh source — run \`yaco install\` from a yaco checkout or set YACO_REPO_ROOT`,
    );
  }

  const stat = statSync(managedPath);
  if (!stat.isFile()) {
    throw new CliError(ErrCode.INTERNAL, `${managedPath} is not a file`);
  }
  if ((stat.mode & 0o111) === 0) chmodSync(managedPath, 0o755);
}

function ensureAgentWrapperScript(): void {
  ensureAgentWrapperScriptFrom(packagedAgentWrapperPath());
}

export const _ensureAgentWrapperScriptFromForTests = ensureAgentWrapperScriptFrom;

function makeHookEntry(event: string, async_: boolean, timeout?: number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: "command",
    command: hookCommand(event),
    async: async_,
  };
  if (timeout !== undefined) entry.timeout = timeout;
  return entry;
}

/** A yaco-managed hook group for a lifecycle event (SessionStart,
 *  UserPromptSubmit, Stop, ...). These groups carry NO `matcher`: ownership is
 *  identified by the hook *command* (see {@link isYacoOwnedGroup}), and an
 *  absent matcher means "match all".
 *
 *  This matters most for SessionStart, whose `matcher` filters on the start
 *  *source* (`startup|resume|clear|compact`). A label there is compiled as a
 *  regex that matches no source, silently disabling the hook — so we leave it
 *  unset. UserPromptSubmit/Stop ignore `matcher` entirely. */
function yacoHookGroup(event: string, async_ = true): Record<string, unknown> {
  return {
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

/** True if a hook group was authored by yaco. The hook *command* is the
 *  canonical ownership signal: every yaco entry runs `agent hook-event <Event>`.
 *  The legacy `matcher === HOOK_MARKER` check is kept only to recognize — and
 *  thus migrate/overwrite — groups written by older installs that abused the
 *  marker as a matcher (which silently disabled SessionStart). */
function isYacoOwnedGroup(group: any): boolean {
  if (group?.matcher === HOOK_MARKER) return true;
  if (!Array.isArray(group?.hooks)) return false;
  return group.hooks.some((h: any) => isYacoHookCommand(h?.command));
}

function hasYacoHook(hookGroups: unknown[]): boolean {
  return hookGroups.some((g) => isYacoOwnedGroup(g));
}

// ---------------------------------------------------------------------------
// Startup trust gate: codexHooksAllYacoOwned
//
// Codex shows its hooks-review screen whenever an enabled, unmanaged hook is
// new or changed. YACO may auto-dismiss that screen ONLY when it can account
// for the ENTIRE effective hook set as its own. This is a fail-closed security
// predicate (NOT the substring-based isYacoOwnedGroup migration helper): every
// enabled command-hook handler, across every source, must be the *canonical*
// `<yaco-binary> agent hook-event <Event>` invocation — exactly, not as a
// substring of a larger shell command. Any foreign handler, any unparseable
// source, or any inline hook construct it cannot enumerate ⇒ false (block).
// ---------------------------------------------------------------------------

/** Strict per-handler ownership: the command is EXACTLY the canonical YACO
 *  hook invocation `<yaco-binary> agent hook-event <Event>` for a single event
 *  token. Unlike {@link isYacoHookCommand} (a substring test a foreign command
 *  could embed, e.g. `evil && yaco agent hook-event Stop`), this anchors the
 *  whole command, so nothing extra can ride along. */
function isCanonicalYacoHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const prefix = `${hookBinary()} agent hook-event `;
  if (!command.startsWith(prefix)) return false;
  return /^[A-Za-z]+$/.test(command.slice(prefix.length));
}

/** Validate a single hook handler. A DISABLED handler never runs, so it is
 *  trusted; any ENABLED handler MUST be a `command` handler whose command is the
 *  exact canonical YACO invocation. Non-command types (e.g. inline JS) ⇒ false. */
function isYacoHandler(h: any): boolean {
  if (h?.enabled === false) return true;
  if (h?.type !== "command") return false;
  return isCanonicalYacoHookCommand(h?.command);
}

/** Validate one hook group's handler list. The group MUST expose a `hooks`
 *  array; any other shape (missing/non-array `hooks`) ⇒ false (fail-closed). */
function groupAllYaco(group: any): boolean {
  if (!Array.isArray(group?.hooks)) return false;
  return group.hooks.every(isYacoHandler);
}

/** Source-specific shape of a Codex hook map. Each source accepts ONLY its own
 *  per-event shape — a value in the wrong shape ⇒ false, never trusted. */
type HookShape = "json" | "toml";

/** Validate one per-event value against its SOURCE shape:
 *   - json: MUST be an array of groups (`Event: group[]`, from hooks.json).
 *   - toml: MUST be the single-group object `{ hooks: handler[] }` that
 *           `Bun.TOML.parse` produces from `[[hooks.<Event>.hooks]]`.
 *  A value in the other (or any unexpected) shape ⇒ false. */
function eventValueAllYaco(value: unknown, shape: HookShape): boolean {
  if (shape === "json") {
    if (!Array.isArray(value)) return false;
    return value.every(groupAllYaco);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return groupAllYaco(value);
}

/** Recursively true if any object in the subtree declares an executable-handler
 *  key (`command` or `hooks`). Proves that Codex's `[hooks.state]` bookkeeping
 *  smuggles no handler. */
function containsHandlerKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsHandlerKeys);
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("command" in o || "hooks" in o) return true;
    return Object.values(o).some(containsHandlerKeys);
  }
  return false;
}

/** Validate Codex's `[hooks.state]` trusted-hash bookkeeping (config.toml only):
 *  a plain object of trust records (`{"<path>:<event>:n:n": { trusted_hash }}`)
 *  with NO executable-handler structure anywhere. A foreign handler hidden under
 *  `state` (any `command`/`hooks` key) ⇒ false. */
function isTrustStateMap(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return !containsHandlerKeys(value);
}

/** Codex hook events YACO installs — the canonical allowlist of event keys a
 *  trusted Codex hook map may carry. A handler under any other event name is one
 *  YACO never installs ⇒ foreign by definition. */
const CODEX_HOOK_EVENT_SET: ReadonlySet<string> = new Set(CODEX_HOOK_EVENTS);

/** Validate a Codex `hooks` map keyed by event name, against its source shape.
 *  Keys are allowlisted to {@link CODEX_HOOK_EVENTS}: any unknown event name ⇒
 *  false (a hook under an event YACO never installs is foreign). For config.toml
 *  the reserved `state` key is also allowed but VALIDATED as Codex's
 *  trusted-hash bookkeeping (not blindly skipped); hooks.json has no `state`
 *  subtree. Any deviation ⇒ false. */
function hooksMapAllYaco(map: unknown, shape: HookShape): boolean {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return false;
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (shape === "toml" && key === "state") {
      if (!isTrustStateMap(value)) return false;
      continue;
    }
    if (!CODEX_HOOK_EVENT_SET.has(key)) return false; // unknown event ⇒ foreign
    if (!eventValueAllYaco(value, shape)) return false;
  }
  return true;
}

/** Fail-closed enumeration of one `.codex/hooks.json` source. Missing file ⇒
 *  contributes nothing (true). Unparseable JSON ⇒ false (block). */
function codexHooksJsonAllYaco(path: string): boolean {
  if (!existsSync(path)) return true;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return false;
  }
  if (parsed?.hooks === undefined) return true; // present, but declares no hooks
  return hooksMapAllYaco(parsed.hooks, "json");
}

/** Fail-closed enumeration of inline `[hooks]` tables in one `.codex/config.toml`.
 *  YACO never installs hooks inline (it writes hooks.json), so any inline hook
 *  DEFINITION is operator-authored — the gate applies the SAME strict per-handler
 *  canonical match as hooks.json.
 *
 *  Parses with Bun's TOML parser (a Bun built-in): a malformed file THROWS ⇒
 *  false (block), satisfying "any unparseable source ⇒ block". The `[hooks.state]`
 *  trusted-hash subtree is validated (must hold only trust records). The
 *  `[features] hooks = true` flag lives under the top-level `features` table, so
 *  it never reaches the `hooks` map. Missing file, or no inline `[hooks]` at all
 *  ⇒ true. Any foreign handler, non-command type, or unexpected shape ⇒ false. */
function codexConfigTomlAllYaco(path: string): boolean {
  if (!existsSync(path)) return true;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  let parsed: any;
  try {
    parsed = Bun.TOML.parse(raw);
  } catch {
    return false; // malformed TOML ⇒ cannot enumerate ⇒ block
  }
  if (parsed?.hooks === undefined) return true; // no inline hook definitions
  return hooksMapAllYaco(parsed.hooks, "toml");
}

/** Fail-closed startup trust gate for Codex's hooks-review screen.
 *
 *  Enumerates EVERY effective Codex hook source — global + project
 *  `.codex/hooks.json` and inline `[hooks]` in global + project
 *  `.codex/config.toml` — and returns true only when every enabled command-hook
 *  handler across all of them is the canonical YACO invocation. Any foreign
 *  handler, any unparseable/unreadable source, or any inline construct it cannot
 *  enumerate ⇒ false, so the caller writes `blocked(trust)` and leaves the
 *  screen for a human. Plugin-bundled hooks are not modeled here; YACO never
 *  installs them, and the conservative default already errs toward block. */
export function codexHooksAllYacoOwned(sessionPath: string): boolean {
  const home = userHome();
  return (
    codexHooksJsonAllYaco(join(home, ".codex", "hooks.json")) &&
    codexHooksJsonAllYaco(join(sessionPath, ".codex", "hooks.json")) &&
    codexConfigTomlAllYaco(join(home, ".codex", "config.toml")) &&
    codexConfigTomlAllYaco(join(sessionPath, ".codex", "config.toml"))
  );
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

/** Drop legacy multmux shell-hook entries — the `bash ".../hook-v2.sh"` groups
 *  earlier installs left in provider configs (under ~/.multmux or, after the
 *  yaco migration, ~/.yaco). The managed `yaco agent hook-event` form supersedes
 *  them, so a lingering shell hook just fires twice per event. Only groups
 *  carrying such a command are touched; a group emptied by the removal is
 *  dropped, every other group (including unrelated empties) is left in place.
 *  Mutates the `{ event: groups[] }` map; returns true when it changed anything. */
export function dropLegacyMultmuxHooks(hooks: Record<string, any>): boolean {
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const next: any[] = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        next.push(group);
        continue;
      }
      const kept = group.hooks.filter(
        (h: any) => !(typeof h?.command === "string" && h.command.includes("hook-v2.sh")),
      );
      if (kept.length === group.hooks.length) {
        next.push(group);
        continue;
      }
      changed = true;
      if (kept.length > 0) next.push({ ...group, hooks: kept });
    }
    hooks[event] = next;
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
  if (dropLegacyMultmuxHooks(settings.hooks)) changed = true;

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
  if (dropLegacyMultmuxHooks(hooks.hooks)) changed = true;

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

/** Ensure the wrapper script and the provider hook configs are in place.
 *  Provider config mutation is delegated to the adapter (`hooks.install`); the
 *  shared runtime only owns the wrapper. */
export function ensureHooks(provider: string): void {
  ensureAgentWrapperScript();
  getProvider(provider).hooks?.install();
}

/** Wrap a command string so it runs inside the exit-trap wrapper. The absolute
 *  yaco binary the wrapper's crash path needs (`YACO_BIN`) is propagated into the
 *  tmux session env by `createSession`, not baked into this command — a leading
 *  `VAR=val` token would be exec'd by tmux as a (non-existent) program. */
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
