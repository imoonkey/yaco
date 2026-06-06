import { capturePane, createSession, getAgentPid, hasSession, checkSessionAlive, sendRawKeys, sendKeys, startOscColorQueryResponder } from "../../lib/core/agent/tmux.ts";
import { getProvider } from "../../lib/core/agent/providers/index.ts";
import { isIdle } from "../../lib/core/agent/providers/idle.ts";
import type { StartupInterstitial, TuiProvider } from "../../lib/core/agent/providers/types.ts";
import {
  buildDefaultSessionName,
  extractName,
  isValidSessionHandle,
  resolveName,
  stripAnsi,
  validateName,
  PENDING_SESSION_ID,
  type SessionState,
  type SpawnedBy,
} from "../../lib/core/agent/model.ts";
import { ensureHooks, buildWrappedCommand } from "../../lib/core/agent/lifecycle.ts";
import { deleteState, readState, writeState, listStateHandles, resolveRenamedHandle } from "../../lib/core/agent/session-state.ts";

const READY_TIMEOUT_MS = 30000;
const POLL_MS = 500;
const STABLE_IDLE_MS = 1000;
const POST_INPUT_SETTLE_TIMEOUT_MS = 8000;
const SID_POLL_TIMEOUT_MS = 3000;
const SID_POLL_MS = 200;

function sessionIdPriority(sessionId: string): number {
  if (!sessionId) return 0;
  if (sessionId === PENDING_SESSION_ID) return 1;
  return 2;
}

function syncStateAfterStart(
  handle: string,
  pid: number | null,
  ready: boolean,
  sessionId: string,
): SessionState | null {
  const current = readState(handle);
  if (!current) return null;

  let changed = false;

  if (pid !== null && pid > 0 && current.pid !== pid) {
    current.pid = pid;
    changed = true;
  }

  // Status progression: starting→idle or starting→processing only.
  // Never downgrade processing→idle (hook is authority for processing state).
  if (current.status === "starting") {
    if (ready) {
      current.status = "idle";
      changed = true;
    }
  }

  if (sessionIdPriority(sessionId) > sessionIdPriority(current.sessionId)) {
    current.sessionId = sessionId;
    changed = true;
  }

  if (changed) writeState(current);
  return current;
}

/** Auto-answer a startup TUI dialog (trust folder, hook review, ...) declared by
 *  the provider adapter. Sends the first matching interstitial's keys in order,
 *  pausing `settleMs` between them. Returns true when a dialog was handled. */
function handleStartupInterstitial(
  handle: string,
  output: string,
  interstitials: readonly StartupInterstitial[],
): boolean {
  for (const interstitial of interstitials) {
    if (!interstitial.pattern.test(output)) continue;
    interstitial.keys.forEach((key, i) => {
      if (i > 0 && interstitial.settleMs) Bun.sleepSync(interstitial.settleMs);
      sendRawKeys(handle, key);
    });
    return true;
  }
  return false;
}

/** Hook-first ready detection. Hook is the source of truth for status; screen is fallback
 *  for adapter-declared startup interstitials and for hook-less / hook-broken scenarios. */
function waitForReady(
  handle: string,
  interstitials: readonly StartupInterstitial[],
  timeoutMs: number = READY_TIMEOUT_MS,
): boolean {
  const start = Date.now();
  let idleSince: number | null = null;
  while (Date.now() - start < timeoutMs) {
    if (!hasSession(handle)) return false;

    // Hook-first: state file is the source of truth.
    const state = readState(handle);
    if (state?.status === "idle" || state?.status === "processing") return true;

    try {
      const raw = capturePane(handle, 80);
      const output = stripAnsi(raw);
      if (handleStartupInterstitial(handle, output, interstitials)) {
        idleSince = null;
        Bun.sleepSync(POLL_MS);
        continue;
      }
      // Screen fallback only if hook hasn't yet promoted past "starting".
      if (isIdle(output)) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= STABLE_IDLE_MS) return true;
      } else {
        idleSince = null;
      }
    } catch {
      idleSince = null;
    }
    Bun.sleepSync(POLL_MS);
  }
  return false;
}

/** Poll for sessionId from state file (hook) and provider storage correlation. */
function waitForSessionId(
  handle: string,
  pid: number,
  prov: TuiProvider,
  sessionCreatedMs?: number,
  sessionPath?: string,
  timeoutMs: number = SID_POLL_TIMEOUT_MS,
): string {
  const start = Date.now();
  const pending = prov.sessionId.pendingValue;
  while (Date.now() - start < timeoutMs) {
    // Check state file (hook may have written sessionId)
    const state = readState(handle);
    if (state?.sessionId && state.sessionId !== pending) return state.sessionId;
    // Try provider storage correlation (adapter-owned scan/DB lookup)
    const resolved = prov.sessionId.resolve({ pid, sessionCreatedMs, sessionPath });
    if (resolved) return resolved.sessionId;
    Bun.sleepSync(SID_POLL_MS);
  }
  return pending;
}

/** Derive session lineage from the environment at start, before writing state.
 *
 *  Precedence (per design):
 *    YACO_AGENT_HANDLE present  -> spawnedBy=agent, parentSession=<resolved handle>
 *    YACO_AGENT_SPAWNED_BY=user:web -> spawnedBy=user:web
 *    otherwise                  -> spawnedBy=user:terminal
 *
 *  The wrapper exports YACO_AGENT_HANDLE for every provider process, so a child
 *  `yaco agent start` from inside an agent inherits its parent's handle. That
 *  handle may be stale if the parent was renamed after launch (env can't be
 *  mutated in place), so we normalize it through the `.renamed-*` breadcrumb
 *  chain. A malformed inherited handle is ignored (falls through to web/terminal)
 *  rather than aborting the start. */
export function deriveSessionLineage(
  env: NodeJS.ProcessEnv = process.env,
): { spawnedBy: SpawnedBy; parentSession?: string } {
  const parent = env["YACO_AGENT_HANDLE"]?.trim();
  if (parent && isValidSessionHandle(parent)) {
    return { spawnedBy: "agent", parentSession: resolveRenamedHandle(parent) };
  }
  if (env["YACO_AGENT_SPAWNED_BY"] === "user:web") {
    return { spawnedBy: "user:web" };
  }
  return { spawnedBy: "user:terminal" };
}

export function resolveStartHandle(
  provider: string,
  args: string[],
  name: string | undefined,
  existingHandles: readonly string[],
  hasLiveSession: (handle: string) => boolean,
): string {
  const requestedName = name ?? extractName(args);
  if (!requestedName) {
    return buildDefaultSessionName(provider);
  }

  validateName(requestedName);
  return resolveName(
    requestedName,
    (handle) => hasLiveSession(handle) || existingHandles.includes(handle),
  );
}

/** Extract resume ID from passthrough args — supports both flag and positional forms:
 *  --resume <id>, --resume=<id>, or `resume <id>` as leading positional subcommand. */
export function extractResume(args: string[]): string | undefined {
  // Flag form: --resume <id> or --resume=<id>
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--resume" && i + 1 < args.length) return args[i + 1];
    if (arg.startsWith("--resume=")) return arg.slice("--resume=".length);
  }
  // Positional form: args[0] === "resume" and args[1] is the id
  if (args.length >= 2 && args[0] === "resume" && !args[1]!.startsWith("-")) {
    return args[1];
  }
  return undefined;
}

/** Remove resume flag+value or positional `resume <id>` from args */
export function stripResume(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // Flag form
    if (arg === "--resume") { i++; continue; }
    if (arg.startsWith("--resume=")) continue;
    result.push(arg);
  }
  // Positional form: if result starts with "resume <id>", strip them
  if (result.length >= 2 && result[0] === "resume" && !result[1]!.startsWith("-")) {
    return result.slice(2);
  }
  return result;
}


function submitPostStartInputs(handle: string, inputs: readonly string[]): boolean {
  let submitted = true;
  for (const input of inputs) {
    try {
      sendKeys(handle, input);
    } catch {
      submitted = false;
    }
  }
  return submitted;
}

/** Wait for a just-submitted post-start input (e.g. Codex's `/rename <handle>`)
 *  to drain back to a stable idle prompt before start() returns.
 *
 *  The post-start `/rename` is a slash command the TUI applies asynchronously.
 *  Without waiting, start() can return mid-command, and a caller that issues a
 *  second command immediately — notably `yaco agent rename`, which sends its own
 *  `/rename <newHandle>` — races the in-flight one and loses it. Re-using the
 *  same stable-idle signal as waitForReady (fresh window, no hook short-circuit)
 *  serializes the two. Bounded; best-effort if the session dies or stays busy. */
function waitForPostInputSettle(
  handle: string,
  timeoutMs: number = POST_INPUT_SETTLE_TIMEOUT_MS,
): void {
  const start = Date.now();
  let idleSince: number | null = null;
  while (Date.now() - start < timeoutMs) {
    if (!hasSession(handle)) return;
    try {
      const output = stripAnsi(capturePane(handle, 80));
      if (isIdle(output)) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= STABLE_IDLE_MS) return;
      } else {
        idleSince = null;
      }
    } catch {
      idleSince = null;
    }
    Bun.sleepSync(POLL_MS);
  }
}

export function start(provider: string, passthroughArgs: string[] | string, name?: string): SessionState {
  // Support legacy string prompt for backward compat
  const args: string[] = typeof passthroughArgs === "string"
    ? (passthroughArgs ? [passthroughArgs] : [])
    : passthroughArgs;

  const prov = getProvider(provider);
  const cwd = process.cwd();

  // Extract --resume <id> from passthrough args (flag or positional form)
  const resumeId = extractResume(args);

  // Canonicalize resume args into the provider's native form (Claude: --resume
  // flag; Codex: resume subcommand). Adapters own the rewrite.
  const effectiveArgs = prov.command.normalizeResumeArgs(args);

  // G11: Targeted dead-handle reclaim — if the requested handle has a stale state file
  // for a dead session, delete it so name resolution doesn't think it's taken.
  // Validate BEFORE any readState/checkSessionAlive to prevent shell injection via raw handle.
  const requestedHandle = name ?? extractName(args);
  if (requestedHandle) {
    validateName(requestedHandle);
    const existingState = readState(requestedHandle);
    if (existingState && checkSessionAlive(requestedHandle) === false) {
      deleteState(requestedHandle);
    }
  }

  // Resolve handle name
  const existingHandles = listStateHandles();
  const resolvedName = resolveStartHandle(
    provider,
    args,
    name,
    existingHandles,
    hasSession,
  );

  // Collision preflight: check for non-multmux tmux session with same name
  if (hasSession(resolvedName) && !readState(resolvedName)) {
    throw new Error(`tmux session "${resolvedName}" already exists (not managed by multmux)`);
  }

  // Ensure hooks are installed globally
  ensureHooks(provider);

  // Write initial state file
  const lineage = deriveSessionLineage();
  const state: SessionState = {
    handle: resolvedName,
    provider,
    sessionPath: cwd,
    pid: 0,
    sessionId: resumeId ?? "",
    status: "starting",
    createdAt: new Date().toISOString(),
    ...lineage,
  };
  writeState(state);

  // Adapters own all name-flag behavior: Claude injects --name at launch, Codex
  // strips --name and learns its handle via post-start inputs (/rename).
  const startCtx = { handle: resolvedName, args: effectiveArgs, resumeId };
  const commandArgs = prov.command.normalizeStartArgs(startCtx);
  const postStartInputs = [...prov.command.postStartInputs(startCtx)];

  const wrappedCommand = buildWrappedCommand(resolvedName, state.createdAt, prov.command.build(commandArgs));
  try {
    createSession(resolvedName, wrappedCommand, cwd);
  } catch (error) {
    deleteState(resolvedName);
    throw error;
  }

  // Provider-runtime terminal compatibility: detached-tmux OSC 10/11 color-query
  // responder, started only when the adapter declares it (headless PTY behavior).
  if (prov.terminal?.respondToColorQuery) {
    startOscColorQueryResponder(resolvedName);
  }

  // Capture PID — poll briefly since the agent process may not have spawned yet
  // inside the wrapper. Read-modify-write to avoid overwriting hook changes.
  let pid: number | null = null;
  const pidDeadline = Date.now() + 3000;
  while (Date.now() < pidDeadline) {
    pid = getAgentPid(resolvedName, prov.executable);
    if (pid !== null) break;
    Bun.sleepSync(200);
  }
  if (pid !== null) {
    syncStateAfterStart(resolvedName, pid, false, resumeId ?? "");
  }

  let ready = waitForReady(resolvedName, prov.command.startupInterstitials ?? []);

  if (ready && postStartInputs.length > 0 && hasSession(resolvedName)) {
    ready = submitPostStartInputs(resolvedName, postStartInputs) && ready;
    // Let the post-start command (Codex `/rename`) settle so a follow-up rename
    // doesn't race it. Only runs for providers that declare post-start inputs.
    if (ready) waitForPostInputSettle(resolvedName);
  }

  // Resolve sessionId — skip polling if already known from --resume
  let sessionId = resumeId ?? "";
  if (!resumeId) {
    if (prov.sessionId.startResolution === "state-file-only") {
      // Trust hook-written state; provider storage is not scanned at start.
      sessionId = readState(resolvedName)?.sessionId || prov.sessionId.pendingValue;
    } else {
      const resolvedPid = pid ?? 0;
      const sessionCreatedMs = new Date(state.createdAt).getTime();
      sessionId = waitForSessionId(
        resolvedName,
        resolvedPid,
        prov,
        sessionCreatedMs,
        cwd,
        SID_POLL_TIMEOUT_MS,
      );
    }
  }

  const synced = syncStateAfterStart(resolvedName, pid, ready, sessionId);

  // G9: If session died during bootstrap, throw instead of returning phantom state
  if (checkSessionAlive(resolvedName) === false) {
    deleteState(resolvedName);
    throw new Error(`Session "${resolvedName}" died during bootstrap`);
  }

  return synced ?? (readState(resolvedName) ?? { ...state, pid: pid ?? 0, sessionId });
}
