/** TuiProvider contract and shared provider DTOs.
 *
 *  A TuiProvider is a local TUI agent CLI that YACO orchestrates inside tmux.
 *  The shared runtime owns tmux, YACO state files, the wrapper, and the HTTP/UI
 *  boundary; each adapter owns its provider-native command shape, idle/busy
 *  detection, hook config, session-id strategy, and (optionally) history,
 *  output reconstruction, and project-move rewrites.
 *
 *  Optional capabilities may be omitted: a provider can start as a usable
 *  tmux-backed TUI and gain richer reconstruction later. */

import type { BlockReason, SessionState, SpawnedBy } from "../model.ts";
import type { SessionIdResult } from "../session-id.ts";

/** Provider hook event name (e.g. "SessionStart"). Open-ended so future
 *  providers can declare events YACO does not model centrally. */
export type ProviderHookEvent = string;

/** Inputs available when normalizing start args or computing post-start inputs. */
export interface StartContext {
  /** Resolved, collision-free YACO handle for the session. */
  handle: string;
  /** Passthrough args after resume normalization. */
  args: string[];
  /** Resume/thread id when the session resumes an existing conversation. */
  resumeId?: string;
}

/** A startup TUI dialog the runtime auto-answers while waiting for ready
 *  (trust folder, hook review, ...). `keys` are sent in order; `settleMs` is
 *  the pause between keys. `skipWhenPattern` suppresses stale scrollback matches
 *  when it appears after the matched interstitial text, such as a later prompt
 *  proving the captured dialog is already historical.
 *
 *  `guard` is a fail-closed security predicate evaluated AFTER `skipWhenPattern`
 *  (so only a genuinely-current dialog is gated): when it returns false the
 *  runtime sends NO keys and instead blocks the session with `blockReason`,
 *  leaving the dialog for a human. Absent `guard` ⇒ always auto-answer. */
export interface StartupInterstitial {
  pattern: RegExp;
  keys: readonly string[];
  settleMs?: number;
  skipWhenPattern?: RegExp;
  guard?: (sessionPath: string) => boolean;
  blockReason?: BlockReason;
}

export interface ProviderCommand {
  /** Flags that, when already present, suppress YACO's default permission flag. */
  permissionFlags: readonly string[];
  /** Assemble the shell command string from already-normalized args. */
  build(args: string[]): string;
  /** Rewrite resume args into the provider's canonical form. */
  normalizeResumeArgs(args: string[]): string[];
  /** Own all name-flag behavior (inject, strip, or leave) for the final args. */
  normalizeStartArgs(ctx: StartContext): string[];
  /** Inputs submitted into the live TUI after the tmux session is created. */
  postStartInputs(ctx: StartContext): readonly string[];
  /** Inputs that rename a live session in-TUI; empty when unsupported. */
  renameInputs(newHandle: string): readonly string[];
  /** Startup dialogs the runtime auto-answers before ready. */
  startupInterstitials?: readonly StartupInterstitial[];
}

export interface ProviderDetection {
  /** Patterns whose presence in the trailing pane means the TUI is idle. */
  idlePatterns: readonly RegExp[];
  /** Patterns identifying a live input prompt line in rendered pane output. */
  inputPromptPatterns?: readonly RegExp[];
  /** Patterns identifying an empty input prompt line, including placeholders. */
  inputEmptyPatterns?: readonly RegExp[];
  /** Raw ANSI/style markers identifying a provider placeholder prompt line. */
  inputPlaceholderStylePatterns?: readonly RegExp[];
  /** Patterns whose presence means the agent is actively processing. */
  busyPatterns?: readonly RegExp[];
}

export interface ProviderHooks {
  /** Hook events this adapter installs into the provider config. */
  events: readonly ProviderHookEvent[];
  /** Install/merge YACO hooks into the provider config. */
  install(): void;
  /** Absolute path of the provider hook config file. */
  configPath(): string;
  /** True when a YACO-owned hook entry is already present. */
  hasInstalledHook(): boolean;
}

/** CLI provider-runtime terminal compatibility — behavior that must work with
 *  no browser attached (headless PTY). Distinct from app/ui presentation. */
export interface ProviderTerminal {
  /** Environment the provider needs at launch (e.g. COLORTERM). */
  launchEnv?: Record<string, string>;
  /** Reply to detached-tmux OSC 10/11 color queries during startup. */
  respondToColorQuery?: boolean;
}

/** Where the session id comes from at start:
 *   - poll-provider-storage: scan provider files/DB after launch
 *   - state-file-only: trust hook-written YACO state, do not scan storage */
export type StartResolution = "poll-provider-storage" | "state-file-only";

export interface SessionIdContext {
  pid: number;
  sessionCreatedMs?: number;
  sessionPath?: string;
}

export interface ProviderSessionId {
  /** Sentinel used until the real session id resolves. */
  pendingValue: string;
  /** Env vars that carry this provider's session id inside the TUI. */
  envKeys: readonly string[];
  startResolution: StartResolution;
  resolve(ctx: SessionIdContext): SessionIdResult | null;
}

/** One row in the History tab for a project, live or historical.
 *
 *  Each adapter owns its own title source, summary (first user message),
 *  timestamps, and archive flag. `tokens` is the last turn's total token count
 *  (input incl. cached context + output) as a cheap "how big was this session"
 *  signal, read from the tail of the provider's session log; `null` when no
 *  usage record is reachable. `live`/`liveSessionName` are filled generically by
 *  the history command, tagging rows whose `sessionId` matches a live YACO
 *  session. */
export interface HistorySession {
  sessionId: string;
  provider: string;
  title: string | null;
  summary: string;
  created: string;
  updatedAt: string;
  tokens: number | null;
  gitBranch: string | null;
  archived?: boolean;
  live?: boolean;
  /** Handle of the live YACO session sharing this sessionId, else null. */
  liveSessionName?: string | null;
  /** Spawn source, filled by history enrichment when known. */
  spawnedBy?: SpawnedBy | null;
  /** Parent session handle breadcrumb, filled by history enrichment when known. */
  parentSession?: string | null;
}

/** Canonical JSON payload for `yaco agent history --json`. */
export interface HistoryWindow {
  rows: HistorySession[];
  returned: number;
  truncated: boolean;
  oldestUpdatedAt: string | null;
}

export interface ProviderHistory {
  list(projectPath: string, liveSessions: readonly SessionState[]): Promise<HistorySession[]>;
}

/** Opaque cursor into a provider's persisted turn log. `token` is opaque to
 *  app/server; only the owning adapter may interpret it. */
export interface OutputCursor {
  token: string;
  offset: number;
  sourceMtimeMs: number;
}

/** Structured, turn-scoped reply event. `timeout` is app-owned stream control,
 *  not a provider classification, so it is intentionally absent here. */
export type AgentOutputEvent =
  | { kind: "interim"; text: string }
  | { kind: "question"; text: string }
  | { kind: "final"; text: string };

export interface ProviderOutput {
  resolveCursor(session: SessionState): Promise<OutputCursor | null>;
  /** Whether a provider log FILE already exists for this session, independent of
   *  whether a cursor can be resolved. Lets `send --wait` distinguish a genuine
   *  first-prompt session (no log yet → safe to wait from log start) from a
   *  session whose log exists but whose cursor is momentarily unresolvable
   *  (must NOT wait from start, or it would replay the old final answer). */
  logExists(session: SessionState): Promise<boolean>;
  /** Classify one COMPLETE provider log line into at most one event.
   *
   *  The single-event return is a contract, not a convention: the follower
   *  tags each event with the byte offset just past its line, so two events
   *  sharing one line's offset could be dropped on reconnect. Providers fold
   *  any multi-part content (e.g. lead-in text plus a question) into one
   *  event. A line that carries no reply event returns null. */
  classifyLine(line: string): AgentOutputEvent | null;
}

// -- Message inventory (`yaco agent messages`) --

/** Role of a normalized message row. Tool calls live in assistant rows, tool
 *  results in user rows; `types` disambiguates. */
export type MessageRole = "user" | "assistant";

/** One normalized message parsed from a provider log line. Pure function of the
 *  line — see `ProviderMessages.parseLine`. */
export interface ParsedMessage {
  role: MessageRole;
  /** Ordered, first-seen-deduped block/item kinds; tool calls carry the name
   *  (e.g. `tool_use:Bash`). Unknown kinds pass through verbatim. */
  types: string[];
  /** Full reconstructed textual content — what `messages --index` returns. */
  text: string;
  /** ISO timestamp from the line, or null when the line carries none. */
  ts: string | null;
}

/** Default `--meta` row: a token-cheap structural skeleton. `index` is a stable
 *  0-based ordinal in the kept-row sequence. */
export interface MessageMeta {
  index: number;
  role: MessageRole;
  types: string[];
  /** `text.length` — budget signal for the cost of pulling this row. */
  chars: number;
  /** Present only with `--ts` (absolute ISO). */
  ts?: string;
  /** Present only with `--preview[=N]`. */
  preview?: string;
}

/** A single full message (`--index`). `ts` is always present (may be null),
 *  unlike the opt-in meta field. */
export interface MessageFull {
  index: number;
  role: MessageRole;
  types: string[];
  chars: number;
  ts: string | null;
  text: string;
}

/** Constant-size orientation over a whole session (`--summary`): shape +
 *  landmarks, independent of length. `prompts` are the indices of real user
 *  messages (role user, not a tool_result) — the conversation's table of
 *  contents. */
export interface MessagesSummary {
  total: number;
  roles: { assistant: number; user: number };
  /** user rows that are tool_results (role user but environment-authored). */
  toolResults: number;
  /** count by primary kind bucket (text/thinking/tool_use/tool_result/...). */
  kinds: Record<string, number>;
  /** tool_use rows by tool name (e.g. Bash, Edit). */
  tools: Record<string, number>;
  /** rows with empty text (chars === 0) — the navigational noise floor. */
  empty: number;
  /** total textual characters across all messages. */
  chars: number;
  prompts: number[];
}

/** Full-inventory reader over a session's provider log. Parallel to
 *  `ProviderOutput` (turn-completion only): this exposes every message with
 *  stable indices. Inclusion is keyed on a coarse, frozen discriminator so
 *  enriching reconstruction never shifts historical indices.
 *
 *  Not a `TuiProvider` capability: the readers are registered in
 *  `message-read.ts`, which `app/server` calls in process and which therefore
 *  may not reach the TUI adapters. A `messages` field here would only be a
 *  shadow of that registry — `test/agent-messages-parity.test.ts` instead
 *  asserts every registered provider id has a reader. */
export interface ProviderMessages {
  /** Resolve the session's message-log path, or null when no log exists yet
   *  (e.g. a pending session). Shares the provider log-path + pending guard. */
  resolveLogPath(session: SessionState): Promise<string | null>;
  /** Parse one COMPLETE log line into a normalized message, or null to skip it
   *  (header/meta, sidechain, UI-event, blank, malformed). Pure: same line →
   *  same result, independent of position. */
  parseLine(line: string): ParsedMessage | null;
}

/** How a project-move path comparison is performed. */
export type MatchMode = "exact" | "prefix";

export interface ProjectMoveInputs {
  oldPath: string;
  newPath: string;
  mode: MatchMode;
  /** Test seam for provider homes, keyed by provider id. */
  providerHomeOverrides?: Record<string, string>;
}

/** Side-effect-free move plan. `payload` is provider-specific but serializable;
 *  the generic mover persists it and passes it back to the same adapter. */
export interface ProviderMovePlan {
  provider: string;
  label: string;
  counts: Record<string, number>;
  payload: unknown;
}

export type ProviderMoveCounts = Record<string, number>;

/** A legacy count-table row this provider contributes to `yaco project move`
 *  output. The provider owns the storage label and the stable count key so the
 *  generic mover can render the historical count surface (text rows + flat JSON
 *  `rewrote` fields) without knowing any provider's storage schema. */
export interface ProviderMoveCountRow {
  /** Stable key, matching this provider's `ProviderMovePlan.counts` entries and
   *  the legacy flat `rewrote` JSON field (e.g. `claudeProjects`). */
  key: string;
  /** Human label for the move command's count table (e.g. `~/.claude/projects`). */
  label: string;
}

export interface ProviderProjectMove {
  /** Count-table rows this provider always contributes (rendered as zero when
   *  the move has no hits), keeping the command's count surface stable. */
  countRows: readonly ProviderMoveCountRow[];
  plan(inputs: ProjectMoveInputs): ProviderMovePlan | null;
  apply(plan: ProviderMovePlan): ProviderMoveCounts;
  renderText(plan: ProviderMovePlan): readonly string[];
}

export interface TuiProvider {
  id: string;
  label: string;
  executable: string;
  command: ProviderCommand;
  detection: ProviderDetection;
  sessionId: ProviderSessionId;
  hooks?: ProviderHooks;
  terminal?: ProviderTerminal;
  history?: ProviderHistory;
  output?: ProviderOutput;
  projectMove?: ProviderProjectMove;
}

export type { SessionIdResult } from "../session-id.ts";
