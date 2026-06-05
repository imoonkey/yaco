import { capturePane, createSession, getAgentPid, hasSession, checkSessionAlive, sendRawKeys, sendKeys } from "../../lib/core/agent/tmux.ts";
import { getProvider, isIdle } from "../../lib/core/agent/providers.ts";
import {
  buildDefaultSessionName,
  extractName,
  resolveName,
  stripAnsi,
  validateName,
  PENDING_SESSION_ID,
  type SessionState,
} from "../../lib/core/agent/model.ts";
import { ensureHooks, buildWrappedCommand } from "../../lib/core/agent/lifecycle.ts";
import { deleteState, readState, writeState, listStateHandles } from "../../lib/core/agent/session-state.ts";
import { resolveSessionId } from "../../lib/core/agent/session-id.ts";

const TRUST_PATTERN = /trust this folder|Yes, I trust/i;
// Codex re-prompts when hook commands change. Two screens:
//   1. "Hooks need review ... 2. Trust all and continue" — numbered menu,
//      cursor starts on option 1, send Down + Enter to pick "Trust all".
//   2. "Press t to trust all" overlay — send `t`.
const CODEX_HOOK_REVIEW_PATTERN = /Hooks need review[\s\S]*Trust all and continue/i;
const CODEX_HOOK_TRUST_OVERLAY_PATTERN = /Press t to trust all/i;
const READY_TIMEOUT_MS = 30000;
const POLL_MS = 500;
const STABLE_IDLE_MS = 1000;
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

/** Hook-first ready detection. Hook is the source of truth for status; screen is fallback
 *  for trust-dialog auto-accept and for hook-less / hook-broken scenarios. */
function waitForReady(handle: string, timeoutMs: number = READY_TIMEOUT_MS): boolean {
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
      if (TRUST_PATTERN.test(output)) {
        sendRawKeys(handle, "Enter");
        idleSince = null;
        Bun.sleepSync(POLL_MS);
        continue;
      }
      if (CODEX_HOOK_REVIEW_PATTERN.test(output)) {
        // Cursor starts on option 1 (Review hooks). Down + Enter selects
        // option 2 (Trust all and continue) and confirms.
        sendRawKeys(handle, "Down");
        Bun.sleepSync(100);
        sendRawKeys(handle, "Enter");
        idleSince = null;
        Bun.sleepSync(POLL_MS);
        continue;
      }
      if (CODEX_HOOK_TRUST_OVERLAY_PATTERN.test(output)) {
        sendRawKeys(handle, "t");
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

/** Poll for sessionId from state file (hook) and local file PID correlation */
function waitForSessionId(
  handle: string,
  pid: number,
  provider: string,
  sessionCreatedMs?: number,
  sessionPath?: string,
  timeoutMs: number = SID_POLL_TIMEOUT_MS,
): string {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Check state file (hook may have written sessionId)
    const state = readState(handle);
    if (state?.sessionId && state.sessionId !== PENDING_SESSION_ID) return state.sessionId;
    // Try local file PID correlation (with rollout fallback for Codex)
    const resolved = resolveSessionId(pid, provider, sessionCreatedMs, sessionPath);
    if (resolved) return resolved.sessionId;
    Bun.sleepSync(SID_POLL_MS);
  }
  return PENDING_SESSION_ID;
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

export function start(provider: string, passthroughArgs: string[] | string, name?: string): SessionState {
  // Support legacy string prompt for backward compat
  const args: string[] = typeof passthroughArgs === "string"
    ? (passthroughArgs ? [passthroughArgs] : [])
    : passthroughArgs;

  const prov = getProvider(provider);
  const cwd = process.cwd();

  // Extract --resume <id> from passthrough args (flag or positional form)
  const resumeId = extractResume(args);

  // Canonicalize resume args per provider:
  // - Codex: rewrite to subcommand form (codex resume <id> ...)
  // - Claude: rewrite to flag form (claude --resume <id> ...)
  let effectiveArgs: string[];
  if (resumeId && provider === "codex") {
    effectiveArgs = ["resume", resumeId, ...stripResume(args)];
  } else if (resumeId && provider === "claude") {
    effectiveArgs = ["--resume", resumeId, ...stripResume(args)];
  } else {
    effectiveArgs = args;
  }

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
  const nameFromArgs = name ?? extractName(args);

  // Collision preflight: check for non-multmux tmux session with same name
  if (hasSession(resolvedName) && !readState(resolvedName)) {
    throw new Error(`tmux session "${resolvedName}" already exists (not managed by multmux)`);
  }

  // Ensure hooks are installed globally
  ensureHooks(provider);

  // Write initial state file
  const state: SessionState = {
    handle: resolvedName,
    provider,
    sessionPath: cwd,
    pid: 0,
    sessionId: resumeId ?? "",
    status: "starting",
    createdAt: new Date().toISOString(),
  };
  writeState(state);

  const commandArgs = [...effectiveArgs];
  const postStartInputs: string[] = [];

  // Ensure the agent session knows its multmux handle name:
  // - Claude: inject --name if not already present (native flag, applied at launch)
  // - Codex: /rename post-start (Codex strips --name from CLI args)
  if (provider === "claude" && !nameFromArgs) {
    commandArgs.push("--name", resolvedName);
  }
  if (provider === "codex") {
    postStartInputs.push(`/rename ${resolvedName}`);
  }

  const wrappedCommand = buildWrappedCommand(resolvedName, state.createdAt, prov.buildCommand(commandArgs));
  try {
    createSession(resolvedName, wrappedCommand, cwd);
  } catch (error) {
    deleteState(resolvedName);
    throw error;
  }

  // Capture PID — poll briefly since the agent process may not have spawned yet
  // inside the wrapper. Read-modify-write to avoid overwriting hook changes.
  let pid: number | null = null;
  const pidDeadline = Date.now() + 3000;
  while (Date.now() < pidDeadline) {
    pid = getAgentPid(resolvedName, provider);
    if (pid !== null) break;
    Bun.sleepSync(200);
  }
  if (pid !== null) {
    syncStateAfterStart(resolvedName, pid, false, resumeId ?? "");
  }

  let ready = waitForReady(resolvedName);

  if (ready && postStartInputs.length > 0 && hasSession(resolvedName)) {
    ready = submitPostStartInputs(resolvedName, postStartInputs) && ready;
  }

  // Resolve sessionId — skip polling if already known from --resume
  let sessionId = resumeId ?? "";
  if (!resumeId) {
    if (provider === "codex") {
      sessionId = readState(resolvedName)?.sessionId || PENDING_SESSION_ID;
    } else {
      const resolvedPid = pid ?? 0;
      const sessionCreatedMs = new Date(state.createdAt).getTime();
      sessionId = waitForSessionId(
        resolvedName,
        resolvedPid,
        provider,
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
