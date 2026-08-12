import { capturePane, isTmuxAvailable, checkSessionAlive, getAgentPid, isProcessAlive } from "../../lib/core/agent/tmux.ts";
import { isIdle } from "../../lib/core/agent/providers/idle.ts";
import { turnStateFromTranscript, type TranscriptTurnState } from "../../lib/core/agent/providers/output.ts";
import { getProvider, hasProvider, listProviders } from "../../lib/core/agent/providers/index.ts";
import { isResolvedSessionId, recordOriginIfResolved } from "../../lib/core/agent/origin.ts";
import { readState, writeState, isStale, deleteState, cleanupOrphanBreadcrumbs, listStateHandles, listByPath, statePath } from "../../lib/core/agent/session-state.ts";
import { validateName, setStatus, PENDING_SESSION_ID, type SessionState, type RuntimeSessionState } from "../../lib/core/agent/model.ts";
import { resolveProjectForPath, toSessionRow, type AgentSessionRow, type ProjectRef } from "../../lib/core/agent/index.ts";
import { readProjects } from "../../lib/core/paths/index.ts";
import { CliError, ErrCode } from "../../lib/core/errors.ts";
import { which } from "../../lib/core/which.ts";
import { basename } from "node:path";
import { statSync } from "node:fs";

export type { RuntimeSessionState } from "../../lib/core/agent/model.ts";

type SessionStatusValue = "idle" | "processing" | "starting" | "stopped" | "not found" | "blocked";

/** Outcome of a pure metadata backfill: the (in-place mutated) state plus a
 *  flag telling the mutating caller whether a field changed and is worth
 *  persisting. The backfill itself never writes — persistence is the job of the
 *  `reconcileSession` wrapper, not the read-only `resolveSession` path. */
interface BackfillResult {
  state: SessionState;
  changed: boolean;
}

interface StateStamp {
  mtimeMs: number;
  ino: number;
}

function readStateStamp(handle: string): StateStamp | null {
  try {
    const st = statSync(statePath(handle));
    return { mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return null;
  }
}

function sameStamp(a: StateStamp | null, b: StateStamp | null): boolean {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/** Backfill PID/sessionId from the live process tree and local provider files.
 *  PURE: mutates the passed-in `state` object in memory only and reports whether
 *  anything changed. It never touches disk. */
function backfillStateMetadata(state: SessionState, handle: string): BackfillResult {
  let changed = false;
  // Preferred process command is the provider executable, which the contract
  // separates from the provider id. Synthetic "unknown" sessions have no
  // adapter, so leave preferredCommand undefined and fall back to pane pid.
  const preferredCommand = hasProvider(state.provider) ? getProvider(state.provider).executable : undefined;
  const agentPid = getAgentPid(handle, preferredCommand);

  if (agentPid && agentPid !== state.pid) {
    state.pid = agentPid;
    changed = true;
  }

  if (state.sessionId && state.sessionId !== PENDING_SESSION_ID) {
    return { state, changed };
  }

  if (state.pid <= 0) {
    return { state, changed };
  }

  const createdMs = state.createdAt ? new Date(state.createdAt).getTime() : undefined;
  // Backfill from provider storage via the adapter. Unregistered providers
  // (e.g. synthesized "unknown") have no adapter, so they stay pending.
  const resolved = hasProvider(state.provider)
    ? getProvider(state.provider).sessionId.resolve({
        pid: state.pid,
        sessionCreatedMs: createdMs,
        sessionPath: state.sessionPath,
      })
    : null;

  if (resolved) {
    state.sessionId = resolved.sessionId;
    changed = true;
  } else if (!state.sessionId) {
    state.sessionId = PENDING_SESSION_ID;
    changed = true;
  }

  return { state, changed };
}

/** Synthesize a minimal state for sessions with no state file */
function synthesizeState(handle: string): RuntimeSessionState {
  const pid = getAgentPid(handle) ?? 0;
  return {
    handle,
    provider: "unknown",
    sessionPath: "",
    pid,
    sessionId: PENDING_SESSION_ID,
    status: "stopped",
    createdAt: "",
  };
}

/** A session is only safe to GC when tmux reports it gone AND its recorded
 *  process is no longer running. `tmux has-session` is socket-scoped: a caller
 *  whose $TMUX points at the wrong tmux server sees every live session as dead
 *  and would otherwise wipe all their state files. The PID check is global and
 *  authoritative — a live process means the session is alive on some socket. */
export function confirmedDead(tmuxAlive: boolean | null, pid: number | undefined): boolean {
  if (tmuxAlive !== false) return false; // alive or uncertain → never delete
  return !isProcessAlive(pid);
}

/** A resolved runtime view plus the persistence intents a mutating caller would
 *  act on. `dead` means the session is confirmed gone (GC candidate). When not
 *  dead, `state` is the runtime view to display; `persist` holds the state value
 *  the reconcile path should write when a backfill or capture correction drifted
 *  from disk (null = nothing to persist). */
interface ResolveDetail {
  dead: boolean;
  state: RuntimeSessionState | null;
  persist: SessionState | null;
  stamp: StateStamp | null;
}

function applyTranscriptState(state: SessionState, ts: TranscriptTurnState): SessionState {
  const corrected: SessionState = { ...state };
  setStatus(corrected, ts.status);
  if (ts.idleReason) corrected.idleReason = ts.idleReason;
  return corrected;
}

function stateDrifted(from: SessionState, to: SessionState, changed: boolean): boolean {
  return changed
    || from.status !== to.status
    || from.blockReason !== to.blockReason
    || from.idleReason !== to.idleReason
    || from.statusEnteredAt !== to.statusEnteredAt
    || from.notice !== to.notice;
}

/** Pure core of resolution — NO writes, NO deletes. Reads the state file, checks
 *  liveness for the dead/GC verdict, backfills metadata in memory, and (for a
 *  stale or missing status) captures the pane to derive a display status. The
 *  returned `persist` describes what a mutating caller could write; the pure
 *  callers ignore it. */
async function resolveDetail(handle: string, cachedAlive?: boolean | null): Promise<ResolveDetail> {
  // Liveness. tmux has-session is socket-scoped, so a session is only dead when
  // tmux says gone AND the recorded process is gone (see confirmedDead).
  const tmuxAlive = cachedAlive === undefined ? checkSessionAlive(handle) : cachedAlive;
  const initialStamp = readStateStamp(handle);
  const state = readState(handle);
  const stamp = state ? initialStamp ?? readStateStamp(handle) : null;
  // A `crashed` tombstone is dead-but-retained: the app must observe the crash
  // and the user must act before it can be cleared. Short-circuit BEFORE the
  // confirmedDead GC verdict so `list --reconcile` / `status --reconcile` never
  // erase it. Only an explicit `yaco agent kill` deletes it.
  if (state?.status === "crashed") {
    return { dead: false, state, persist: null, stamp };
  }
  if (confirmedDead(tmuxAlive, state?.pid)) {
    return { dead: true, state: null, persist: null, stamp };
  }
  // tmuxAlive === null, or process still alive on another socket → continue.

  if (state) {
    const stale = isStale(handle);
    const invalidStatus = (state.status as string) === "stopped";
    if (!stale && !invalidStatus) {
      // Valid non-stale state — backfill metadata in memory and return.
      const { state: backfilled, changed } = backfillStateMetadata(state, handle);
      return { dead: false, state: backfilled, persist: changed ? backfilled : null, stamp };
    }

    const { state: backfilled, changed } = backfillStateMetadata(state, handle);

    if (stale && state.status === "blocked") {
      if (state.blockReason === "permission" || state.blockReason === "question") {
        const ts = await turnStateFromTranscript(backfilled);
        if (ts?.status === "idle") {
          const corrected = applyTranscriptState(backfilled, ts);
          return { dead: false, state: corrected, persist: corrected, stamp };
        }
      }
      return { dead: false, state: backfilled, persist: changed ? backfilled : null, stamp };
    }

    if (stale && state.status === "processing") {
      const ts = await turnStateFromTranscript(backfilled);
      if (ts) {
        const corrected = applyTranscriptState(backfilled, ts);
        return {
          dead: false,
          state: corrected,
          persist: stateDrifted(backfilled, corrected, changed) ? corrected : null,
          stamp,
        };
      }
    }
  }

  // Capture-based fallback (state is stale or missing). Capture refines the
  // display status without persisting — the mutating path decides whether the
  // drift is worth writing back.
  try {
    const output = capturePane(handle, 15);
    const capturedStatus = isIdle(output) ? "idle" : "processing";
    if (state) {
      const { state: backfilled, changed } = backfillStateMetadata(state, handle);
      // Capture can only derive idle|processing (never blocked), so any stale
      // blockReason must not survive the correction — setStatus drops it when
      // writing a non-blocked status.
      const corrected: SessionState = { ...backfilled };
      setStatus(corrected, capturedStatus);
      // State file is stale — hooks stopped updating. A mutating caller persists
      // the capture-derived status (and any backfill) so all readers converge.
      // A stale blockReason that setStatus just dropped is its own drift, even
      // when the status value itself is unchanged.
      const drift = changed
        || backfilled.status !== capturedStatus
        || backfilled.blockReason !== corrected.blockReason
        || backfilled.idleReason !== corrected.idleReason;
      return { dead: false, state: corrected, persist: drift ? corrected : null, stamp };
    }
    return { dead: false, state: { ...synthesizeState(handle), status: capturedStatus }, persist: null, stamp };
  } catch {
    // Can't capture — return whatever state we have.
    if (state) {
      const { state: backfilled, changed } = backfillStateMetadata(state, handle);
      return { dead: false, state: backfilled, persist: changed ? backfilled : null, stamp };
    }
    return { dead: false, state: synthesizeState(handle), persist: null, stamp };
  }
}

/** PURE read-only resolver — the single source of truth for runtime state.
 *  Used by `list` (default), `status`, `whoami`, and all polling callers.
 *  Returns the resolved runtime view, or null when the session is confirmed
 *  dead/not found. Performs NO writes and NO deletes: it never persists status
 *  corrections nor GCs tombstones. `cachedAlive` skips the per-session tmux
 *  has-session call when the caller already checked liveness. */
export async function resolveSession(handle: string, cachedAlive?: boolean | null): Promise<RuntimeSessionState | null> {
  return (await resolveDetail(handle, cachedAlive)).state;
}

/** MUTATING reconcile wrapper — the only resolver that writes. It runs the pure
 *  `resolveDetail`, then: GCs a confirmed-dead session's state file (gated on
 *  `confirmedDead` inside resolveDetail), and persists any backfill / stale
 *  status correction the pure pass computed. Used by `list --reconcile` and the
 *  app server's 60s reconcile loop. */
export async function reconcileSession(handle: string, cachedAlive?: boolean | null): Promise<RuntimeSessionState | null> {
  const before = readState(handle);
  const detail = await resolveDetail(handle, cachedAlive);
  if (detail.dead) {
    if (isTmuxAvailable()) deleteState(handle);
    return null;
  }
  if (detail.persist) {
    if (detail.stamp && !sameStamp(detail.stamp, readStateStamp(handle))) {
      return resolveSession(handle, cachedAlive);
    }
    writeState(detail.persist);
    if (!isResolvedSessionId(before?.sessionId) && isResolvedSessionId(detail.persist.sessionId)) {
      recordOriginIfResolved(detail.persist);
    }
  }
  return detail.state;
}

interface StatusOptions {
  json?: boolean;
  /** When true, persist a stale-status correction / metadata backfill and GC a
   *  confirmed-dead tombstone. Default false: `status` is a pure read. */
  reconcile?: boolean;
}

/** Render the resolved runtime state as a labeled detail block for text mode.
 *  Text-only enrichment: `project` is derived from `sessionPath` + the registry
 *  here, for display, and never enters the `--json` runtime-state record. */
function renderStatusText(resolved: RuntimeSessionState): string {
  const project = resolveProjectForPath(resolved.sessionPath, readProjects());
  const rows: [string, string | number | undefined][] = [
    ["handle", resolved.handle],
    ["status", resolved.status],
    ["provider", resolved.provider],
    ["pid", resolved.pid > 0 ? resolved.pid : undefined],
    ["sessionId", resolved.sessionId],
    ["path", resolved.sessionPath || undefined],
    ["project", project?.name],
    ["spawnedBy", resolved.spawnedBy],
    ["parentSession", resolved.parentSession],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => `${(label + ":").padEnd(width + 1)}  ${value}`)
    .join("\n");
}

/** Inspect a single session by handle. Single source for `yaco agent status
 *  <name>`. The collection view lives in `list()`. PURE read by default —
 *  `--reconcile` opts into the mutating resolver (persist corrections + GC).
 *
 *  `--json` returns the resolved runtime session state verbatim (pinned by
 *  test); text mode renders a labeled detail block. */
export async function status(name: string, jsonOrOptions?: boolean | StatusOptions): Promise<string> {
  const opts: StatusOptions = typeof jsonOrOptions === "boolean"
    ? { json: jsonOrOptions }
    : (jsonOrOptions ?? {});

  validateName(name);
  const resolved = opts.reconcile ? await reconcileSession(name) : await resolveSession(name);
  if (!resolved) {
    throw new CliError(ErrCode.NOT_FOUND, `no agent session: ${name}`);
  }
  if (opts.json) return JSON.stringify(resolved);
  return renderStatusText(resolved);
}

interface ListOptions {
  json?: boolean;
  all?: boolean;
  path?: string;
  /** When true, perform the mutating pass: GC confirmed-dead tombstones, persist
   *  stale-status corrections, and clean up orphan breadcrumbs. Default false:
   *  `list` is a pure read that filters dead sessions out without deleting. */
  reconcile?: boolean;
}

/** Unregistered session paths still deserve a row — fall back to the path's
 *  basename so `yaco agent list` never hides a live session. */
function deriveProject(sessionPath: string, projects: ProjectRef[]): ProjectRef {
  return resolveProjectForPath(sessionPath, projects)
    ?? { name: basename(sessionPath) || sessionPath, path: sessionPath };
}

/** List live sessions as shared projection rows. Source for `yaco agent list`.
 *  Default scope is the cwd subtree; `--all` spans every project; `--path`
 *  scopes to an explicit subtree.
 *
 *  PURE READ by default: enumerates state files, resolves each session
 *  read-only (`resolveSession`), filters confirmed-dead sessions OUT of the
 *  returned rows, and never deletes their files or persists corrections.
 *
 *  `--reconcile` is the single mutation point: it GCs confirmed-dead tombstones,
 *  cleans orphan breadcrumbs, and persists stale-status / backfill corrections
 *  via `reconcileSession`. The app server's 60s loop is the intended caller. */
export async function list(options: ListOptions = {}): Promise<string> {
  const filterPath = options.path ?? (options.all ? undefined : process.cwd());
  const sessions = filterPath
    ? listByPath(filterPath)
    : listStateHandles().map(h => readState(h)).filter(Boolean) as SessionState[];

  // Cache liveness results — checkSessionAlive spawns a process per call, and
  // we need the result for the dead-filter and the resolver. One check per session.
  const aliveCache = new Map<string, boolean | null>();
  if (isTmuxAvailable()) {
    for (const session of sessions) {
      aliveCache.set(session.handle, checkSessionAlive(session.handle));
    }
  }

  // GC + breadcrumb cleanup ONLY in the mutating path. The PID guard makes
  // deletion socket-safe: a `list` run on the wrong tmux socket sees every
  // session as dead via has-session, but must not wipe state for live processes.
  if (options.reconcile) {
    for (const session of sessions) {
      // Never GC a crashed tombstone — it is dead-but-retained until observed.
      if (session.status !== "crashed" && confirmedDead(aliveCache.get(session.handle) ?? null, session.pid)) {
        deleteState(session.handle);
      }
    }
    if (isTmuxAvailable()) cleanupOrphanBreadcrumbs();
  }

  // Filter confirmed-dead sessions out of the view (keep anything not confirmed
  // dead). A crashed tombstone is dead-but-retained, so it always survives the
  // filter. The pure path does this WITHOUT deleting their files.
  const liveSessions = sessions.filter(
    s => s.status === "crashed" || !confirmedDead(aliveCache.get(s.handle) ?? null, s.pid),
  );

  const projects = readProjects();
  const rows: AgentSessionRow[] = [];
  for (const session of liveSessions) {
    const alive = aliveCache.get(session.handle);
    const resolved = options.reconcile
      ? await reconcileSession(session.handle, alive)
      : await resolveSession(session.handle, alive);
    if (!resolved) continue;
    const row = toSessionRow(resolved, deriveProject(resolved.sessionPath, projects));
    if (row) rows.push(row);
  }

  if (options.json) return JSON.stringify(rows);

  if (rows.length === 0) {
    // Health check mode
    const lines: string[] = ["No active sessions.", "", "Health:"];
    lines.push(`  tmux: ${isTmuxAvailable() ? "ok" : "not found"}`);
    for (const provider of listProviders()) {
      lines.push(`  ${provider.id}: ${which(provider.executable) ? "ok" : "not found"}`);
    }
    return lines.join("\n");
  }

  return rows
    .map(r => `${r.name.padEnd(30)} ${r.status.padEnd(12)} ${r.project}`)
    .join("\n");
}
