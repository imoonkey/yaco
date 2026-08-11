/** Provider subscription-quota probes.
 *
 *  Claude and Codex each expose how much of the signed-in subscription's quota
 *  is spent, but only through their own surfaces: Codex answers the local
 *  `codex app-server` JSON-RPC, Claude answers an OAuth-authenticated HTTP
 *  endpoint. This module co-locates both probes behind one normalized window
 *  model so `yaco agent usage` reports them side by side, mirroring the
 *  per-capability layout of `history.ts` and `output.ts` (one shared module
 *  branching by provider, not one file per provider).
 *
 *  Access tokens are read from the local credential store on every probe and
 *  are never logged, cached, or returned.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, renameSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { CliError, ErrCode } from "../../errors.ts";
import { usageCacheFile } from "../../paths/yaco-home.ts";

export interface UsageWindow {
  /** The provider's own identity for this window: a duration when it publishes
   *  one ("5h", "7d"), otherwise its group name ("session", "weekly").
   *
   *  Deliberately not a session/weekly enum. The providers publish different
   *  things — Codex gives a duration and no name, Claude a name and no
   *  duration — and neither is derivable from the other. Mapping both onto two
   *  buckets means guessing, and a guess here is a lie about a number the user
   *  is trying to plan around: a 1-day or 30-day window would both be filed
   *  under "weekly". Carrying what the provider actually said cannot go stale
   *  when a plan gains a window shape nobody has seen yet. */
  window: string;
  /** What the window covers when it is narrower than the whole account — a
   *  model or per-limit name. Absent for the account-wide window. */
  scope?: string;
  percent: number;
  /** ISO 8601. Absent when the provider did not report a reset time; the
   *  percentage is the payload and stays useful without it. */
  resetsAt?: string;
}

export interface ProviderUsage {
  provider: string;
  /** Provider-reported plan name, when it reports one. */
  plan?: string;
  /** Empty when the probe failed, or when the account genuinely has no limits. */
  windows: UsageWindow[];
  /** ISO 8601 time the numbers were fetched — older than now when cached. */
  checkedAt: string;
  error?: { code: ErrCode; message: string };
}

/** A probe's payload before it is stamped with provider/time. */
type Quota = Pick<ProviderUsage, "plan" | "windows">;

/** Window name used when a provider reports a limit with no duration and no
 *  group — permitted by Codex's schema, where both fields are nullable. */
const UNSPECIFIED_WINDOW = "quota";

/** Serve cached numbers for this long before re-probing. The Claude endpoint
 *  rate-limits aggressively under repeated polling. */
const CACHE_TTL_MS = 120_000;

const CODEX_PROBE_TIMEOUT_MS = 20_000;
const CLAUDE_PROBE_TIMEOUT_MS = 15_000;
/** Grace between SIGTERM and SIGKILL for the app-server child. */
const TERMINATE_GRACE_MS = 2_000;
/** Bytes of the child's stderr retained for diagnostics. */
const STDERR_TAIL_BYTES = 4_096;
/** How long to wait for the child's stderr to finish arriving before quoting
 *  whatever has already been drained. */
const STDERR_DRAIN_GRACE_MS = 500;

/** Honor $HOME at call time so provider paths track test home overrides. */
function userHome(): string {
  const env = process.env["HOME"];
  return env && env.length > 0 ? env : homedir();
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** ISO 8601, or undefined when `ms` does not name a real instant.
 *
 *  `Number.isFinite` is not enough: `new Date(1e20)` is finite input but an
 *  Invalid Date, and `toISOString()` throws on it. The round trip through
 *  `getTime()` is what actually proves the date is representable. */
function toIsoOrUndefined(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A usable percentage: a real, non-negative number. Values above 100 are kept
 *  — a provider reporting overage is reporting something true — and clamped at
 *  the meter, not here. */
function isUsablePercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A usable name: a non-empty string. An empty window or scope name would
 *  render as a blank row that looks like a display bug. */
function isUsableName(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** "5h", "7d", "45m" — the provider's window duration, said plainly. */
function formatWindowDuration(mins: number): string {
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

/** Build one window, or undefined when the provider sent an entry we cannot
 *  state honestly. The percentage must be a finite number — it is the whole
 *  payload — while a reset time that is missing or unparseable is simply left
 *  off. Both must be checked rather than assumed: `new Date(NaN)` throws on
 *  `toISOString()`, so one malformed entry would otherwise take down the whole
 *  probe with an opaque RangeError. */
function toWindow(
  window: string,
  scope: string | undefined,
  percent: unknown,
  resetsAtMs: number,
): UsageWindow | undefined {
  if (!isUsablePercent(percent) || !isUsableName(window)) return undefined;
  const resetsAt = toIsoOrUndefined(resetsAtMs);
  return {
    window,
    ...(isUsableName(scope) ? { scope } : {}),
    percent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

// -- Codex: local app-server JSON-RPC --

/** Every field is nullable in Codex's published response schema, so none of
 *  them may be dereferenced as a plain number. */
interface CodexWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  /** Epoch seconds. */
  resetsAt?: number | null;
}

interface CodexLimit {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  planType?: string | null;
}

interface CodexRateLimits {
  rateLimits?: CodexLimit | null;
  rateLimitsByLimitId?: Record<string, CodexLimit> | null;
}

/** Flatten Codex's rate-limit record into normalized windows.
 *
 *  `rateLimitsByLimitId` is the richer source: besides the account-wide limit
 *  (the same one `rateLimits` holds) it carries per-model limits that the
 *  top-level object omits, and those are routinely the binding constraint. */
export function normalizeCodexQuota(result: CodexRateLimits): Quota {
  const accountWide = result.rateLimits ?? undefined;
  const byId = result.rateLimitsByLimitId ?? undefined;
  const limits = byId && Object.keys(byId).length > 0 ? Object.values(byId) : accountWide ? [accountWide] : [];

  const windows: UsageWindow[] = [];
  for (const limit of limits) {
    // The entry sharing the top-level limitId is the account-wide one; the rest
    // are scoped to a model and carry their own name.
    const scope =
      limit.limitId && limit.limitId === accountWide?.limitId
        ? undefined
        : (limit.limitName ?? limit.limitId ?? undefined);
    for (const window of [limit.primary, limit.secondary]) {
      if (!window) continue;
      const mins = window.windowDurationMins;
      const resetsAt = window.resetsAt;
      // A duration must be positive to name a window: 0 would render "0d" and
      // a negative one "-1h", both impossible windows presented as fact.
      const named = typeof mins === "number" && Number.isFinite(mins) && mins > 0;
      const normalized = toWindow(
        named ? formatWindowDuration(mins) : UNSPECIFIED_WINDOW,
        scope,
        window.usedPercent,
        typeof resetsAt === "number" ? resetsAt * 1000 : Number.NaN,
      );
      if (normalized) windows.push(normalized);
    }
  }

  const plan = accountWide?.planType ?? limits[0]?.planType ?? undefined;
  return { ...(plan ? { plan } : {}), windows };
}

/** The app-server child, wrapped so that nothing about talking to it can take
 *  the command down instead of diagnosing it.
 *
 *  Two failures are reported asynchronously and away from the call that caused
 *  them. A child that never starts reports `ENOENT` on an `error` event a tick
 *  after `spawn` returns; a write to a child whose read end is already gone
 *  reports `EPIPE` on stdin. Unobserved, either is an uncaught exception —
 *  verified for the stdin one on Node 24, which crashes the process on a write
 *  to a closed pipe unless a listener exists.
 *
 *  Only the spawn failure is worth *reporting*, because only it says something
 *  the read outcome does not: "codex is not installed" is a different fix from
 *  "codex was there and did not answer". A stdin failure is observed and
 *  dropped — the three requests go out in the same tick as the spawn, long
 *  before any child could die, so a broken input pipe here means the child was
 *  never there, which the read already reports better. */
interface CodexProc {
  child: ChildProcessWithoutNullStreams;
  /** Resolves once the child process itself is gone. Deliberately not `close`,
   *  which additionally waits for every stdio stream to end: an orphaned
   *  grandchild inherits those pipes and holds them open after the app-server
   *  is dead, so waiting on them would hang the command forever. Draining the
   *  stderr tail is what has a grace bound for exactly that case. */
  exited: Promise<void>;
  /** Write one JSON-RPC line. Resolves when the line is flushed *or* when it
   *  could not be — either way the write is over and the read decides. Never
   *  ends the stream: the app-server treats EOF on its input as a shutdown
   *  signal and exits before answering. */
  send(message: Record<string, unknown>): Promise<void>;
  /** Why the child never started, if it did not. */
  spawnError(): NodeJS.ErrnoException | undefined;
}

function spawnCodexAppServer(): CodexProc {
  // Default stdio is a pipe on all three streams, which is both what the
  // JSON-RPC exchange needs and what narrows the streams to non-null.
  const child = spawn("codex", ["app-server", "--listen", "stdio://"]);
  let spawnFailure: NodeJS.ErrnoException | undefined;
  child.on("error", (error: NodeJS.ErrnoException) => { spawnFailure ??= error; });
  child.stdin.on("error", () => { /* observed so EPIPE cannot crash the command */ });

  return {
    child,
    exited: new Promise<void>((resolve) => {
      // Either event ends the child's story: `exit` when it ran, `error` when
      // it never started. Resolving on both is what stops `terminate` from
      // waiting on a process that does not exist.
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    }),
    send: (message) =>
      new Promise<void>((resolve) => {
        child.stdin.write(JSON.stringify(message) + "\n", () => resolve());
      }),
    spawnError: () => spawnFailure,
  };
}

/** The spawn wrapper, for the tests that drive a child which is not there.
 *  Everything they assert — a write that cannot land still resolves, the stdin
 *  guard is installed — is unreachable through the command, which needs a real
 *  `codex` to get that far. */
export const _spawnCodexAppServerForTests = spawnCodexAppServer;

/** SIGTERM, escalating to SIGKILL, and always await the child so no app-server
 *  outlives the command. Safe to call twice. */
async function terminate(proc: CodexProc): Promise<void> {
  proc.child.kill();
  const escalate = setTimeout(() => proc.child.kill("SIGKILL"), TERMINATE_GRACE_MS);
  try {
    await proc.exited;
  } finally {
    clearTimeout(escalate);
  }
}

/** Start draining the child's stderr immediately, keeping only the tail.
 *
 *  Draining from spawn (rather than reading the stream when an error is being
 *  built) is what bounds memory: a broken app-server that floods stderr would
 *  otherwise be materialized in full just to quote its last line, and a child
 *  that never exits would leave the pipe unread until the buffer filled and
 *  blocked it. Only the last `STDERR_TAIL_BYTES` are retained. */
function drainStderr(stream: Readable): {
  settle(): Promise<void>;
  cancel(): void;
  text(): string;
} {
  let buffered = "";
  const decoder = new TextDecoder();
  stream.on("data", (chunk: Buffer) => {
    buffered = (buffered + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
  });
  // A broken pipe ends the drain rather than failing the probe: what the child
  // did is reported from its exit, not from the stream that carried its words.
  stream.on("error", () => {});
  const drained = new Promise<void>((resolve) => stream.once("close", resolve));
  return {
    // Bounded, and armed only when a diagnosis is actually being written: an
    // orphaned grandchild can hold the write end of the pipe open after the
    // app-server itself is gone, and waiting on the stream alone would hang the
    // command forever. Creating the grace timer eagerly instead would add its
    // full delay to every probe, including the successful ones.
    settle: async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STDERR_DRAIN_GRACE_MS);
      });
      try {
        await Promise.race([drained, grace]);
      } finally {
        clearTimeout(timer);
      }
    },
    // Releases the pending read so it cannot keep the event loop alive.
    cancel: () => stream.destroy(),
    text: () => {
      const tail = buffered.trim().split("\n").slice(-3).join("; ").trim();
      return tail ? `: ${tail}` : "";
    },
  };
}

/** Why the read ended, so a child that died is never reported as a timeout. */
type RpcOutcome =
  | { ok: true; message: Record<string, unknown> }
  | { ok: false; reason: "timeout" | "exited" };

/** Errors that mean "the stream ended", not "something went wrong worth
 *  reporting": the timeout destroying it mid-read, or the child's end of the
 *  pipe going away. The outcome below already says which of the two happened. */
const STREAM_TEARDOWN_CODES: ReadonlySet<string> = new Set([
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
  "EPIPE",
  "ECONNRESET",
]);

function isStreamTeardown(thrown: unknown): boolean {
  const code = (thrown as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && STREAM_TEARDOWN_CODES.has(code);
}

/** Read the first JSON-RPC message carrying `id` off a line-delimited stream. */
async function readRpcResponse(
  stream: Readable,
  id: number,
  timeoutMs: number,
): Promise<RpcOutcome> {
  const decoder = new TextDecoder();
  // Destroying ends the iteration; the flag is what tells an elapsed timeout
  // apart from the child closing its stdout on its own.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stream.destroy();
  }, timeoutMs);
  let buffered = "";
  try {
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk as Buffer, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        // The app-server writes only JSON lines; a malformed one is a broken
        // peer, surfaced by the probe's catch rather than parsed around — so it
        // is deliberately not one of the teardown codes swallowed below.
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message["id"] === id) return { ok: true, message };
      }
    }
  } catch (thrown) {
    if (!isStreamTeardown(thrown)) throw thrown;
  } finally {
    clearTimeout(timer);
    // Releases the pending read so it cannot keep the event loop alive.
    stream.destroy();
  }
  return { ok: false, reason: timedOut ? "timeout" : "exited" };
}

async function probeCodex(): Promise<Quota> {
  const proc = spawnCodexAppServer();
  const stderr = drainStderr(proc.child.stderr);
  /** The child's last words, once it has actually finished saying them. */
  const diagnosis = async (): Promise<string> => {
    await terminate(proc);
    await stderr.settle();
    return stderr.text();
  };
  try {
    // The app-server rejects every other request until the initialize response
    // is followed by the `initialized` notification.
    for (const message of [
      { method: "initialize", id: 1, params: { clientInfo: { name: "yaco", title: "YACO", version: "0.1.0" } } },
      { method: "initialized", params: {} },
      { method: "account/rateLimits/read", id: 2 },
    ]) {
      await proc.send(message);
    }

    const outcome = await readRpcResponse(proc.child.stdout, 2, CODEX_PROBE_TIMEOUT_MS);
    if (!outcome.ok) {
      if (outcome.reason === "timeout") {
        throw new CliError(
          ErrCode.TIMEOUT,
          `codex app-server did not report quota within ${CODEX_PROBE_TIMEOUT_MS}ms`,
        );
      }
      // Diagnose before asking why: it awaits the child, so a spawn failure the
      // runtime reports asynchronously has certainly landed by the time it is
      // read.
      const detail = await diagnosis();
      const failedToStart = proc.spawnError();
      if (failedToStart) {
        throw new CliError(
          ErrCode.ENV,
          failedToStart.code === "ENOENT"
            ? "codex CLI not found on PATH"
            : `could not start the codex CLI: ${failedToStart.message}`,
        );
      }
      throw new CliError(
        ErrCode.ENV,
        `codex app-server exited before reporting quota${detail}`,
      );
    }

    const failure = outcome.message["error"] as { message?: string } | undefined;
    if (failure) {
      throw new CliError(
        ErrCode.ENV,
        `codex rejected the quota request: ${failure.message ?? "unknown error"} ` +
          "(run `codex` and sign in with ChatGPT)",
      );
    }
    return normalizeCodexQuota((outcome.message["result"] ?? {}) as CodexRateLimits);
  } finally {
    await terminate(proc);
    stderr.cancel();
  }
}

// -- Claude: OAuth usage endpoint --

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

interface ClaudeLimit {
  group?: string;
  kind?: string;
  percent?: number;
  resets_at?: string;
  scope?: { model?: { display_name?: string | null } | null; surface?: string | null } | null;
}

interface ClaudeUsage {
  limits?: ClaudeLimit[];
}

/** Normalize Claude's `limits[]` into windows.
 *
 *  `limits[]` — not the named `five_hour`/`seven_day` fields — is the source
 *  because it is the only one carrying model-scoped windows, and a scoped
 *  window is frequently far closer to exhaustion than the account-wide one. */
export function normalizeClaudeQuota(usage: ClaudeUsage, plan?: string): Quota {
  const windows: UsageWindow[] = [];
  for (const limit of usage.limits ?? []) {
    const normalized = toWindow(
      limit.group ?? limit.kind ?? UNSPECIFIED_WINDOW,
      limit.scope?.model?.display_name ?? limit.scope?.surface ?? undefined,
      limit.percent,
      Date.parse(limit.resets_at ?? ""),
    );
    if (normalized) windows.push(normalized);
  }
  return { ...(plan ? { plan } : {}), windows };
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
  };
}

/** The same credential JSON, read from the macOS login keychain. Returns
 *  undefined on any other platform, or when the item is absent. */
function readMacosKeychainCredentials(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const found = spawnSync(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { encoding: "utf-8" },
  );
  // A missing `security` leaves `status` null, which is not 0 either — no
  // keychain, no credentials, same answer.
  if (found.status !== 0) return undefined;
  const blob = (found.stdout ?? "").trim();
  return blob === "" ? undefined : blob;
}

/** Read the OAuth access token Claude Code stores locally. Returned to the
 *  caller for immediate use only — never persisted or rendered. */
function readClaudeCredentials(): { token: string; plan?: string } {
  const path = credentialFile("claude");
  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // macOS keeps the credential blob in the login keychain instead of on
    // disk; the file path is the Linux/Windows location.
    raw = readMacosKeychainCredentials();
  }
  if (raw === undefined) {
    throw new CliError(
      ErrCode.ENV,
      `Claude credentials not found at ${path} — run \`claude\` and sign in`,
    );
  }
  // Parsed and checked, not cast: a corrupt store must fail as a nameable
  // environment problem, and a non-string token must never be sent as a bearer
  // credential (`Bearer 42`) or a non-string plan reach the JSON output.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(ErrCode.ENV, `Claude credentials at ${path} are not valid JSON — run \`claude\` to sign in again`);
  }
  const oauth = (parsed as ClaudeCredentials | null)?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || !isUsableName(oauth.accessToken)) {
    throw new CliError(
      ErrCode.ENV,
      `no Claude OAuth token in ${path} — subscription quota needs a signed-in session, not an API key`,
    );
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) {
    throw new CliError(ErrCode.ENV, "Claude OAuth token expired — run `claude` to refresh it");
  }
  return {
    token: oauth.accessToken,
    ...(isUsableName(oauth.subscriptionType) ? { plan: oauth.subscriptionType } : {}),
  };
}

async function probeClaude(): Promise<Quota> {
  const { token, plan } = readClaudeCredentials();
  let response: Response;
  try {
    response = await fetch(CLAUDE_USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": CLAUDE_OAUTH_BETA },
      signal: AbortSignal.timeout(CLAUDE_PROBE_TIMEOUT_MS),
    });
  } catch (thrown) {
    const detail = thrown instanceof Error ? thrown.message : String(thrown);
    throw new CliError(ErrCode.IO, `could not reach the Claude usage endpoint: ${detail}`);
  }

  if (response.status === 429) {
    throw new CliError(
      ErrCode.RATE_LIMIT,
      "the Claude usage endpoint is rate-limiting this client — retry in a few minutes",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new CliError(
      ErrCode.ENV,
      `Claude rejected the OAuth token (HTTP ${response.status}) — run \`claude\` to re-authenticate`,
    );
  }
  if (!response.ok) {
    throw new CliError(ErrCode.IO, `Claude usage endpoint returned HTTP ${response.status}`);
  }
  return normalizeClaudeQuota((await response.json()) as ClaudeUsage, plan);
}

// -- Cache --

/** The credential store each provider authenticates from. Both CLIs let their
 *  config root be relocated — Claude by `CLAUDE_CONFIG_DIR` (which is also how
 *  multiple accounts are kept apart), Codex by `CODEX_HOME` — so the paths under
 *  `$HOME` are only defaults. */
function credentialFile(provider: string): string {
  const root = (override: string | undefined, fallback: string): string =>
    override && override !== "" ? override : join(userHome(), fallback);
  return provider === "claude"
    ? join(root(process.env["CLAUDE_CONFIG_DIR"], ".claude"), ".credentials.json")
    : join(root(process.env["CODEX_HOME"], ".codex"), "auth.json");
}

/** The identity a cached entry is bound to: the mtime of the provider's
 *  credential file. Signing in as someone else — or refreshing a token —
 *  rewrites that file, so entries fetched under the old account stop matching,
 *  and nothing secret goes to disk to achieve it.
 *
 *  Undefined means there is no file to bind to, which is a real configuration
 *  and not just a logged-out one: Codex also supports keyring and ephemeral
 *  credential stores, and Claude keeps its blob in the macOS keychain. Identity
 *  cannot be established in those setups, so the caller must neither read nor
 *  write the cache — a shared "generation 0" would let any account's numbers
 *  satisfy any other account's lookup. */
function credentialGeneration(provider: string): number | undefined {
  try {
    return statSync(credentialFile(provider)).mtimeMs;
  } catch {
    return undefined;
  }
}

interface CacheEntry {
  credentialGeneration: number;
  checkedAt: string;
  plan?: string;
  windows: UsageWindow[];
}

/** Rebuild a window from cache content field by field.
 *
 *  The cache is parsed, never trusted: a hand-edited or corrupted file must not
 *  be able to crash the command or smuggle extra keys into `--json` output, so
 *  every field is type-checked and the result is reconstructed from a
 *  whitelist rather than spread. */
function parseCachedWindow(raw: unknown): UsageWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const { window, scope, percent, resetsAt } = value;
  // Values, not just types: the same bars the live probes apply, so a
  // hand-edited cache cannot inject a negative percentage, a blank row, or a
  // timestamp that renders as NaN.
  if (!isUsableName(window) || !isUsablePercent(percent)) return undefined;
  if (scope !== undefined && !isUsableName(scope)) return undefined;
  if (resetsAt !== undefined && (typeof resetsAt !== "string" || toIsoOrUndefined(Date.parse(resetsAt)) === undefined)) {
    return undefined;
  }
  return {
    window,
    ...(scope !== undefined ? { scope } : {}),
    percent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function parseCacheEntry(raw: unknown): CacheEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const { credentialGeneration: generation, checkedAt, plan, windows } = value;
  if (typeof generation !== "number" || typeof checkedAt !== "string") return undefined;
  if (plan !== undefined && typeof plan !== "string") return undefined;
  if (!Array.isArray(windows)) return undefined;
  const parsed: UsageWindow[] = [];
  for (const window of windows) {
    const entry = parseCachedWindow(window);
    if (!entry) return undefined;
    parsed.push(entry);
  }
  return {
    credentialGeneration: generation,
    checkedAt,
    ...(plan !== undefined ? { plan } : {}),
    windows: parsed,
  };
}

function cachedUsage(provider: string, generation: number): ProviderUsage | undefined {
  let entry: CacheEntry | undefined;
  try {
    entry = parseCacheEntry(JSON.parse(readFileSync(usageCacheFile(provider), "utf8")));
  } catch {
    // Absent, torn, or unparseable cache is a miss, never a failure.
    return undefined;
  }
  if (!entry) return undefined;
  if (entry.credentialGeneration !== generation) return undefined;
  // A negative age means the entry is stamped in the future (clock change);
  // treating it as a miss re-probes rather than serving it until the clock
  // catches up.
  const age = Date.now() - Date.parse(entry.checkedAt);
  if (!(age >= 0 && age < CACHE_TTL_MS)) return undefined;
  const { credentialGeneration: _generation, ...usage } = entry;
  return { provider, ...usage };
}

function writeCache(usage: ProviderUsage, generation: number): void {
  // Nothing useful to serve, and a transient empty answer must not be pinned
  // for the whole TTL.
  if (usage.windows.length === 0) return;
  const path = usageCacheFile(usage.provider);
  const entry: CacheEntry = {
    credentialGeneration: generation,
    checkedAt: usage.checkedAt,
    ...(usage.plan ? { plan: usage.plan } : {}),
    windows: usage.windows,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Write-then-rename so a concurrent reader sees either the old file or the
    // new one, never a half-written one.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // A cache that cannot be written only costs a re-probe next time.
  }
}

// -- Entry point --

const PROBES: Record<string, () => Promise<Quota>> = {
  claude: probeClaude,
  codex: probeCodex,
};

/** Provider ids that can report subscription quota. */
export function usageProviderIds(): string[] {
  return Object.keys(PROBES);
}

/** Most-exhausted window first — the one about to stop work is the one worth
 *  reading, and unlike a duration it is always known for every provider. */
function byWindowOrder(a: UsageWindow, b: UsageWindow): number {
  if (a.percent !== b.percent) return b.percent - a.percent;
  if (a.window !== b.window) return a.window.localeCompare(b.window);
  return (a.scope ?? "").localeCompare(b.scope ?? "");
}

/** Probe every requested provider concurrently.
 *
 *  A provider that fails comes back as an entry with `error` set and no
 *  windows rather than rejecting the whole read, so one broken login still
 *  leaves the other provider's numbers visible. Only successes are cached. */
export async function readUsage(
  providerIds: string[],
  opts: { fresh: boolean },
): Promise<ProviderUsage[]> {
  const entries = await Promise.all(
    providerIds.map(async (provider): Promise<ProviderUsage> => {
      // Sampled before the probe: binding the result to the identity read
      // afterwards would stamp account A's numbers with account B's generation
      // if the user re-authenticated while the probe was in flight.
      const generation = credentialGeneration(provider);
      if (!opts.fresh && generation !== undefined) {
        const hit = cachedUsage(provider, generation);
        if (hit) return hit;
      }
      const probe = PROBES[provider];
      if (!probe) {
        throw new CliError(ErrCode.INVALID, `provider does not report usage: ${provider}`);
      }
      try {
        const usage: ProviderUsage = {
          provider,
          ...(await probe()),
          checkedAt: toIso(Date.now()),
        };
        if (generation !== undefined) writeCache(usage, generation);
        return usage;
      } catch (thrown) {
        const error =
          thrown instanceof CliError
            ? { code: thrown.code, message: thrown.message }
            : { code: ErrCode.INTERNAL, message: thrown instanceof Error ? thrown.message : String(thrown) };
        return { provider, windows: [], checkedAt: toIso(Date.now()), error };
      }
    }),
  );
  return entries.map((entry) => ({ ...entry, windows: [...entry.windows].sort(byWindowOrder) }));
}
