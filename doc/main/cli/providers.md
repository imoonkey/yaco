# Providers

> Last updated: 2026-08-12 (`start` prechecks the provider executable; prior: session summaries are a shared in-process read; provider identity is one catalog; prior: Codex `Stop` fills idle `notice` from the rollout `final_answer`)

## Supported Providers

| Provider | CLI Command | Idle Pattern | Flags |
|----------|------------|--------------|-------|
| claude   | `env -u CLAUDECODE claude` | `^❯\s` (NBSP-tolerant) | `--dangerously-skip-permissions` |
| codex    | `env COLORTERM=truecolor codex` | `›` prompt | `-c features.hooks=true --yolo` |

## Provider Adapter Model

YACO providers are **local TUI CLIs running in tmux**. The browser attaches to
the provider's TUI; YACO reconstructs session metadata, history, summaries, and
reply events from provider-persisted files and databases. ACP / JSON-RPC agent
streams are out of scope — there is no agent control protocol, only a local CLI
stdout stream over persisted logs (see [output-follow](#provider-output--reply-streaming)).

Each provider is a typed adapter (`TuiProvider`) under
`src/lib/core/agent/providers/`. The registry (`providers/index.ts`:
`getProvider`, `listProviders`, `listProviderIds`, `hasProvider`) is the single
authority; the flat `providers.ts` is now a thin legacy shim that adapts the
registry to the `Provider` shape a few not-yet-migrated call sites still import.
New code imports from `providers/` directly.

A provider's **identity** — `{id, label, executable}` — lives one level up, in
`src/lib/core/agent/provider-catalog.ts`, and the adapters spread it rather than
declaring their own literals. That is what lets `app/server` hold the startable
catalog in process (`yaco-cli/core/agent#providerCatalog`) without loading an
adapter: the registry reaches tmux, hook installation and the session lifecycle,
none of which an exported closure may contain. There is one definition, so the
two cannot disagree; `test/providers.test.ts` asserts it anyway, which is what
catches a third adapter that writes its own literals.
-> See: [exports.md](exports.md)

Two capabilities are deliberately **not** on `TuiProvider`: the message reader
and the summary reader. `app/server` calls both in process, so their registries
live in the read modules (`providers/message-read.ts`,
`providers/summary-read.ts`) where no adapter is reachable. A capability flag on
the adapter would only be a shadow of those registries — and a provider that
omitted the flag would slip past the guard — so each read module's test instead
asserts that *every registered provider id* has a reader.

All provider-specific filesystem, database, and log parsing lives under `cli/`.
`app/server` never resolves or parses `~/.claude`, `~/.codex`, or a future
provider home directly — it consumes `yaco agent ... --json` or one explicit CLI
stream. Adding a TUI provider is **one CLI adapter plus UI metadata**, not edits
across start, status, session-id, history, streaming, project move, doctor, and
terminal quirks.

Adapter responsibilities, by capability:

| Capability | Required? | Owns |
|---|---|---|
| `command` | yes | launch command (`build`), resume canonicalization (`normalizeResumeArgs`), name-flag policy (`normalizeStartArgs`/`postStartInputs`), live rename (`renameInputs`), trust/review prompts (`startupInterstitials` — each may carry a fail-closed `guard`+`blockReason`; see [lifecycle.md](lifecycle.md#startup-trust-gating-codex-hooks-review)) |
| `detection` | yes | `idlePatterns` / `busyPatterns` for screen-scrape status fallback; `inputPromptPatterns` / `inputEmptyPatterns` / `inputPlaceholderStylePatterns` for safe internal slash-command delivery |
| `sessionId` | yes | pending sentinel, session-id env keys, start-resolution strategy, `resolve` from provider storage |
| `hooks` | optional | hook events, install/merge, config path, install probe (drives `install` + `doctor`) |
| `terminal` | optional | provider-runtime / headless-PTY terminal compatibility (see below) |
| `history` | optional | History-tab rows; absent ⇒ provider omitted from history. A row's `summary` is the **first meaningful** user message — `<system-reminder>`/command-stdout dropped, slash commands restored to `/name args`, `/rename`·`/clear`·`/compact` and handle echoes skipped (`providers/prompt-label.ts`, shared with the live-session labels in [Session Summaries](#session-summaries)). Each row also carries `tokens` — the last turn's total token count (a cheap session-size signal read from the log tail: Claude sums `input + cache_creation + cache_read + output` of the last `message.usage` in the JSONL tail it already reads; Codex tail-reads the `rollout_path` for the last `last_token_usage.total_tokens`), `null` when no usage record is reachable. Rows come back newest-first with an ascending-`sessionId` tie break → See: [architecture.md#read-ordering](architecture.md#read-ordering), `src/lib/core/agent/providers/history.ts` |
| `output` | optional | output cursor + line classification for reply streaming; absent ⇒ callers fall back to `capture` |
| `projectMove` | optional | provider-native cwd-keyed rewrites (see [Project Move](#project-move)) |

Registered in the read modules rather than on the adapter, for the reason above:

| Reader | Registry | Owns |
|---|---|---|
| `ProviderMessages` | `providers/message-read.ts` | full-inventory message reader: log-path resolution + per-line reconstruction into normalized `{role,types,text,ts}` rows for `agent messages`; unregistered ⇒ `INVALID`. → See [Message Inventory](#message-inventory) |
| summarizer | `providers/summary-read.ts` | the live session's display label; unregistered ⇒ the session is dropped from the list. → See [Session Summaries](#session-summaries) |

The shared runtime owns tmux, YACO state files, wrapper installation, name
validation, send/capture/kill/rename commands, and the HTTP/UI boundary. The
canonical `SessionState` (`handle`, `provider`, `sessionPath`, `pid`,
`sessionId`, `status`, `createdAt`, plus optional lineage `spawnedBy` /
`parentSession`) is the runtime registry; provider-native
state is never canonical — it is only an adapter-owned source for derived data.

### Terminal Runtime Compatibility

`TuiProvider.terminal` is **CLI provider-runtime / headless-PTY** compatibility:
behavior that must work with **no browser attached**.

| Field | Purpose | Example |
|---|---|---|
| `launchEnv` | env the provider needs at launch | Codex `COLORTERM=truecolor` |
| `respondToColorQuery` | reply to detached-tmux OSC 10/11 color queries at startup | Codex `true` |

This is **distinct from** the browser presentation policy in app/ui
(`ProviderUiConfig.terminal`: xterm contrast floor + OSC report suppression).
The split rule: **if it must happen with no browser attached, it is CLI runtime
config; if it only matters while xterm renders to a human, it is app/ui config.**
The same provider can require opposite actions in the two domains (a detached
tmux OSC color *responder* vs. xterm OSC *suppression*), so a single shared OSC
flag would be wrong. See [architecture.md](architecture.md#cli--app-boundary).

## Hook Availability

Hook is the **primary** status signal; screen scraping is fallback only (trust dialog auto-accept, hook-less providers). Codex's **hooks-review** trust prompts are not blindly auto-accepted — they are gated by the fail-closed `codexHooksAllYacoOwned` predicate → `blocked(trust)` when the effective hook set is foreign/unverifiable. See [lifecycle.md](lifecycle.md#startup-trust-gating-codex-hooks-review).

| Hook Event | Claude | Codex | Status Effect |
|---|---|---|---|
| SessionStart | Yes | Yes | → idle |
| UserPromptSubmit | Yes | Yes | → processing |
| Stop | Yes | Yes | → idle |
| StopFailure | Yes | No | → idle |
| PreToolUse | Yes | Yes | → processing |
| PostToolUse | Yes | Yes (Bash only) | → processing (error correction + mtime refresh) |
| PostToolUseFailure | Yes | No | → processing |
| PermissionRequest | Yes | Yes | → idle (waiting for user) |
| PreCompact | Yes | Yes | → processing |
| PostCompact | Yes | Yes | → processing |
| Notification (`idle_prompt`/`permission_prompt`) | Yes | No | → idle |
| SessionEnd | Yes | No | → idle |

`PostToolUse` keeps state file mtime fresh during long turns, preventing the stale threshold (5min) from triggering capture fallback. Also corrects status if `Stop` fired prematurely. Codex `PostToolUse` currently only fires for Bash tool calls.

**No-tool thinking gap.** A turn with no tool calls (pure reasoning / long text generation) fires no `PostToolUse`, so mtime can cross the stale threshold while the agent is still working. `reconcile()` then capture-screens and must not misread it as idle. `isIdle()` matches the rendered pane against the **union of every provider's `idlePatterns`** (`ALL_IDLE_PATTERNS`), so each pattern must be a strong provider-specific prompt glyph (`❯` / `›`) — a loose fallback like `>\s*$` leaks across providers and false-matches stray blockquote/diff/echo lines mid-thinking. Such fallbacks were removed; only the real prompt glyphs remain.

`Notification`, `PreCompact`, and `PostCompact` use the matcher field as a content filter (notification type / compaction trigger) rather than a label, so they are registered with `matcher: "*"` (the same path as tool-scoped events). Lifecycle events are registered with **no** `matcher` at all — `SessionStart` filters on the start *source* (`startup|resume|clear|compact`), so a label there compiles to a regex matching no source and silently disables the hook, while an absent matcher means "match all". Ownership is carried by the hook *command*, not by a matcher; see [architecture.md](architecture.md#hook-installation).

Codex's missing `SessionEnd` is compensated by the exit-trap wrapper (`${YACO_HOME:-~/.yaco}/agent-wrapper.sh`), which deletes the state file on process exit. `StopFailure` absence is benign — both `Stop` and `StopFailure` map to `idle`.

**Stop debounce.** Per the legacy contract preserved from the shell hook, `Stop`/`StopFailure` events go through a 120 ms re-check window before applying the `idle` transition. If the state file mutated during the pause (typically because the next turn's `UserPromptSubmit` already wrote `processing`), the late Stop is dropped. Implemented in `src/lib/core/agent/hook-event.ts#runHookEventForHandle`.

-> See: [architecture.md](architecture.md#exit-trap-wrapper)

## Adding a Provider

1. Add a `TuiProvider` adapter at `src/lib/core/agent/providers/<id>.ts`.
   `command` + `detection` + `sessionId` are required; `hooks`, `terminal`,
   `history`, `output`, and `projectMove` are optional (a provider can start as
   a usable tmux-backed TUI and gain richer reconstruction later).
2. Register it in `src/lib/core/agent/providers/index.ts`.
3. Add browser presentation metadata (icon, contrast floor, OSC suppression,
   `canStart`) in `app/ui/src/lib/providerUi.ts`.

Start/status/rename/whoami/lifecycle/tmux, install/doctor, project move, and the
app boundary all read the registry, so no per-call-site provider branch is
needed.

## Provider Shortcuts

- Top-level: `yaco claude [args...]` / `yaco codex [args...]` is shorthand for `yaco agent start <provider> [args...]`. The dispatcher recognizes the provider name as the area token and delegates to `runStart`.
- Mid-layer: `yaco agent claude ...` is REJECTED with USAGE (exit 2). The canonical form is `yaco agent start <provider>`.
- Passthrough split: in `start`, yaco-side flags (`--json`) bind only before a standalone `--`; everything after is forwarded verbatim to the provider. Backward-compatible when `--` is omitted (any unrecognized flag flows through to the provider, as before).
- Precheck: `start` refuses a provider whose `executable` is not on `$PATH` — `CliError(ENV)`, exit 3, before any state file or tmux session exists. It is the same `which` behind `doctor`'s `providers` check. Anything else the provider rejects (a forwarded mistyped flag included) can only be reported after it exits, from the pane the wrapper salvages. -> See: [lifecycle.md](lifecycle.md#bootstrap-failure-what-start-can-name-and-what-only-the-provider-can)

An empty prompt opens an idle session (no initial task).

For Codex, the runtime syncs the provider title with `/rename <handle>` for both explicit and default names by enqueueing the slash command after bootstrap readiness. The title sync is best-effort and does not wait for settle before `start()` returns. Codex placeholder prompts are recognized by their dim ANSI style rather than by placeholder wording; busy turns or occupied composers queue a detached helper that waits until the input clears. For Claude, the runtime injects `--name <handle>` into the launch command when no explicit name is provided, so default word-based names are persisted natively.

Slash commands are delivered through tmux bracketed paste followed immediately by `Enter`. Raw character-by-character `send-keys` can race slash-command autocomplete, causing partial commands such as `/rename` to be interpreted as another command while the remainder stays in the composer.

For Codex, an unnamed empty start can stay `pending:awaiting-first-prompt` until a real prompt creates a thread. The `/rename` may resolve the thread earlier, but that timing is not guaranteed.

## Resume

Both flag form (`--resume <id>`) and positional form (`resume <id>` as leading arg) are accepted. The runtime canonicalizes per provider:

| Provider | User writes (any form) | Resulting agent CLI |
|----------|----------------------|---------------------|
| Claude | `yaco claude --resume <id>` or `yaco claude resume <id>` | `claude --resume <id>` (flag) |
| Codex | `yaco codex --resume <id>` or `yaco codex resume <id>` | `codex resume <id>` (subcommand) |

When resuming with `--name`, Codex submits `/rename <handle>` after ready (same as fresh starts) as best-effort provider-title sync. If the slash command is sent immediately, startup waits for it to settle; if user input already occupies the prompt, startup queues the input-gated helper and returns. The `sessionId` is written to the state file immediately (no polling needed).

Real-agent integration tests verify that the stored UUID `sessionId` works with both `claude --resume <id>` and `codex resume <id>`.

Codex sessions explicitly export `COLORTERM=truecolor` before launch so the provider sees a truecolor hint even when running under tmux. The runtime starts the detached `tmux pipe-pane` OSC 10/11 color responder when the provider adapter declares `terminal.respondToColorQuery` (Codex does), gated by that adapter flag rather than a hard-coded provider check. There is no fixed launch delay, so the responder attaches best-effort right after `tmux new-session`; it watches the pane for the real OSC 10/11 query bytes and replies with `tmux send-keys -H`.

-> See: [src/lib/core/agent/providers/index.ts](../../../cli/src/lib/core/agent/providers/index.ts) (registry), [providers/claude.ts](../../../cli/src/lib/core/agent/providers/claude.ts), [providers/codex.ts](../../../cli/src/lib/core/agent/providers/codex.ts)

## Provider Output & Reply Streaming

A provider may declare an optional `output` capability (`ProviderOutput` in
`src/lib/core/agent/providers/types.ts`) so YACO can reconstruct turn-scoped
reply events from the provider's persisted JSONL log. Claude and Codex both
declare it (`src/lib/core/agent/providers/output.ts`). A provider without
`output` falls back to `capture` (rendered-pane snapshot).

Two CLI surfaces drive it (consumed by `app/server`, so provider-home reads stay
under `cli/`):

```text
yaco agent output-cursor <name> [--json]
yaco agent output-follow <name> [--cursor <token>] [--offset <bytes>] [--json]
```

- **`output-cursor`** resolves the session's current log into an **opaque**
  cursor `{ token, offset, sourceMtimeMs }`. `token` is `oc1_<base64url>` of
  `{provider, sessionId, path}` — app/server stores and round-trips it but must
  not parse it or derive a path from it.
- **`output-follow`** is a persistent NDJSON **stdout stream** (not the single
  `{ok,data}` envelope): it tails the log and writes one frame per line, then
  the process exits. One provider turn is one `output-follow` subprocess that
  polls internally — not one subprocess per poll.

Frame shapes:

```json
{"type":"event","event":{"kind":"interim|question|final","text":"..."},"nextOffset":1234}
{"type":"end","reason":"final|max-lifetime|error","nextOffset":2201}
```

Contract details:

- The shared follower (`followOutput`, in `providers/follow.ts`) owns `stat`,
  byte-range reads, byte-space partial-line buffering, and offset advancement.
  Providers only `resolveCursor` and `classifyLine`. It is a *sibling* of
  `output.ts`, not part of it: it polls, and a polling loop is banned from every
  exported closure — while `output.ts` is reached from the exported message read.
  -> See: [exports.md](exports.md#the-rules)
- `classifyLine` returns **at most one** `AgentOutputEvent` per complete line
  (`AgentOutputEvent | null`), so each event maps to a unique `nextOffset` and
  no same-line event is lost across a reconnect. Claude folds lead-in text into
  the single `question` event.
- Codex writes an agent message under **two** rollout envelopes: a flat
  `event_msg/agent_message` payload, and an `event_msg/item_completed` payload
  wrapping an `AgentMessage` item whose text is split into `content[]` blocks.
  The `phase` (`final_answer` / `commentary`) and the text are the same two
  facts in both, so `classifyCodex` reads either into one shape and classifies
  once. A payload shape the classifier does not recognise yields no `final` at
  all, which reads downstream as `agent wait` hanging to its lifetime cap and an
  empty Codex idle notice — not as a parse error.
- `nextOffset` is the byte offset just past the consumed line; pass it back as
  the next `--offset` to resume without replay.
- **Termination:** first `final` event, a defensive **max-lifetime** cap
  (default 30 min, override `YACO_OUTPUT_FOLLOW_MAX_MS`), caller abort
  (SIGTERM/SIGINT), reader `EPIPE`, or a read `error`. `timeout` is never a
  provider event — the app owns stream timeout and the AskUserQuestion Escape
  side effect; the CLI only emits the `question` event.
- **Input validation (before any frame, normal error envelope):** a strict
  allowlist parser accepts only the handle plus `--cursor`/`--cursor=`,
  `--offset`/`--offset=`, and `--json`. Any other flag (including generic agent
  flags) → `USAGE`. `--offset` must be a non-negative integer (split or equal
  form) → else `USAGE`. A `--cursor` value must be present, non-empty, and not
  flag-like → else `USAGE`; a well-formed token that doesn't match the session's
  provider/sessionId → `INVALID`. `--help`/`-h` is honored only as a standalone
  help request.

-> See: [src/lib/core/agent/providers/output.ts](../../../cli/src/lib/core/agent/providers/output.ts), [src/lib/core/agent/providers/follow.ts](../../../cli/src/lib/core/agent/providers/follow.ts), [src/commands/agent/output.ts](../../../cli/src/commands/agent/output.ts)

## Message Inventory

Where `output` is turn-completion only (final/question text, dropping
thinking/tool_use/tool_result), the optional `messages` capability
(`ProviderMessages` in `src/lib/core/agent/providers/types.ts`) is a **full
inventory**: every message in the session log as a normalized row with a stable
index. Claude and Codex both declare it
(`src/lib/core/agent/providers/messages.ts`); a provider without it → `INVALID`.
It serves `agent messages` so an orchestrator can navigate a session's history
without PTY `capture` (debug-only) — the structured **final** message still
comes from `wait` / `--wait`.

The read itself is **shared, not command-owned**. `readMessageRows(session,
filter)` in `providers/message-read.ts` does one read of the log, indexes every
message, and returns the rows a filter keeps; the command adds only the
projections (`--meta`, `--index`, `--summary`, rendering). `app/server` calls the
same function in process through `yaco-cli/core/agent/messages`, so the
filtering and index semantics have exactly one implementation. `/messages` still
spawns: it is one child rather than `1+n`, and what it returns is the command's
own text rendering, which lives in the command layer.
-> See: [read-path.md](read-path.md), [exports.md](exports.md), [../app/backend/libs.md](../app/backend/libs.md)

```text
yaco agent messages <name> [--meta] [--role r] [--type t] [--range a..b] [--preview[=N]] [--ts] [--json]
yaco agent messages <name>  --index <i>          # full message; i may be negative (-1 = last)
yaco agent messages <name>  --summary            # constant-size session shape + prompt landmarks
```

- **`--summary`** is the orientation entry for a large session: total, role/kind
  histograms, `tool_use`-by-name counts, the empty-row count, total chars, and
  the **prompt landmark indices** (real user messages — `role:user` minus
  tool_results). Constant size regardless of session length — read it first,
  then `--range`/`--index` into the part you want.
- **`--meta`** (default) lists lean rows `{index, role, types, chars}` — a
  token-cheap table of contents. `chars` is the budget signal. `--preview[=N]`
  (default 100) and `--ts` are opt-in. Filters `--role` / `--type` (prefix-matches
  `tool_use` → `tool_use:Bash`) / `--range a..b` (inclusive, open ends and
  negative bounds; `-20..` = last 20) select which rows are **shown without
  changing an index**.
- **`--index <i>`** returns one `MessageFull` `{index, role, types, chars, ts,
  text}`; text mode prints `text` raw.

Contract details:

- **Frozen index.** A row's `index` is its 0-based ordinal in the kept-row
  sequence. Inclusion is keyed only on a coarse discriminator — Claude
  `user`/`assistant` non-sidechain lines, Codex non-developer `response_item`s —
  never on the fine-grained block/payload kind. Unknown kinds reconstruct to a
  generic `[<type>]` placeholder row, so enriching reconstruction never shifts
  historical indices. Stability is for the **resolved physical log file** under
  this frozen policy.
- **Reconstruction** joins block segments with `\n`; `chars = text.length`;
  `preview = collapseWhitespace(text).slice(0, N)`. Path resolution reuses the
  `output` log-path helpers (`resolveClaudeLogPath` / `resolveCodexLogPath`)
  and the pending-session guard.
- **Event-loop budget.** The scan yields every 256 KB consumed, and `--role` /
  `--type` are applied as it goes so only kept rows are materialized. Bytes, not
  lines: a real 38 MB log here is 854 records, sixteen of them over a megabyte.
  What that cannot bound is one record's own parse — measured 2 ms for a 1.36 MB
  record. -> See: [test/bench/message-read-bench.mjs](../../../cli/test/bench/message-read-bench.mjs)
- **Text rendering** is compact (single-letter role, human-readable `chars`,
  first-absolute-then-relative `--ts` deltas with a multi-day date prefix);
  `--json` stays exact (absolute ISO `ts`).
- **Errors:** invalid/traversal handle → `USAGE`; no live session → `NOT_FOUND`;
  unknown provider / no `messages` capability → `INVALID`; pending session or
  deleted log → `NOT_FOUND`; other read failure → `IO`. `--index` out of range →
  `NOT_FOUND`.

-> See: [src/lib/core/agent/providers/messages.ts](../../../cli/src/lib/core/agent/providers/messages.ts), [src/lib/core/agent/providers/message-read.ts](../../../cli/src/lib/core/agent/providers/message-read.ts), [src/commands/agent/messages.ts](../../../cli/src/commands/agent/messages.ts)

## Session Summaries

A summary is the label a live session is recognized by in the session list: the
**first meaningful** user message in its provider log, collapsed for display by
the rules `prompt-label.ts` also applies to history rows.

`readSessionSummaries(targets)` in `providers/summary-read.ts` is the one
implementation. `yaco agent summaries --path <p>` enumerates the project's state
files and hands them in; `app/server` hands in exactly the sessions its cache is
missing, in process through `yaco-cli/core/agent/summaries`. Sessions are
explicit inputs, which is what keeps the module clear of the state-file
enumeration an exported closure may not reach, and what makes two concurrent
calls on different projects structurally unable to cross.

```text
yaco agent summaries --path <project-path> [--json]     # handle  label, one line per session
```

Per provider, in order, stopping at the first label:

| Provider | Source |
|---|---|
| claude | the session's project JSONL |
| codex | `state_5.sqlite` `first_user_message` → one rollout per day, newest day back → the `title` column |

Codex auto-renames the thread `title` to the YACO handle on start, so the title
is a name echo and only ever the last resort.

**The scan is bounded, and that is the whole reason it may run in the server.**
A provider log is input-sized — 38 MB at the top of the local corpus — and the
reader it replaced decoded and parsed all of it to find a label that is almost
always in the first record. The scan reads 256 KB at a time, parses only
complete records, yields between steps, and stops at the first label. Because
`firstMeaningfulMessage` judges each text independently of the ones around it,
stopping early is the same answer, not an approximation.

Two things it does **not** answer identically, both deliberate:

- **A record over 4 MiB is skipped undecoded.** Chunking bounds the scan but not
  one record: decode + `JSON.parse` + collapse is ~2 ms per MB in one
  uninterruptible go, so a 36 MB record is ~73 ms — two to three times the whole
  subprocess route it replaces. Across the 300 largest local logs (1.15 GB) the largest
  record of any kind is 4.15 MB and the largest *user* record — the only kind
  that can be a label — is 0.85 MB.
- **Codex rollout search is the whole `YYYY/MM/DD` tree**, not the eight days the
  previous private walk covered, and it continues to the next day when a rollout
  yields no label. Which file a day contributes is unchanged — the first by name,
  as `resolveCodexLogPath` has always chosen — so the only sessions this reaches
  that the old walk did not are ones whose prompt sits in an older day's rollout.

Net, a Codex session gains a label where an older rollout holds its prompt, and
loses one where the prompt is a single record over the cap. Neither is
"strictly more": they are two independent changes in opposite directions, and
the local corpus contains an instance of neither (611/611 labels are identical
to the implementation this replaces).

-> See: [exports.md](exports.md) (the eligibility rules and the one judged
`node:sqlite` admission), [read-path.md](read-path.md) (what this cutover
measured and how to roll it back), `test/bench/summary-stall.ts` (the starvation
bound and the query's own measurement).

## Project Move

`yaco project move <old> <new>` rekeys cwd-keyed metadata after a project moves
on disk. The generic mover (`src/lib/core/project/move.ts`) owns **only**
YACO-owned state — session-state `sessionPath` and the `projects.json` registry —
and aggregates **opaque** per-provider plans by iterating the registry. It never
inspects a provider's storage schema or payload shape.

A provider may declare an optional `projectMove` capability
(`ProviderProjectMove` in `src/lib/core/agent/providers/types.ts`,
implemented in `src/lib/core/agent/providers/project-move.ts`). Each adapter owns
its own private rewrites:

- **Claude:** `~/.claude/projects/<encoded-cwd>/` directory rename + per-file
  JSONL `cwd` rewrite. The rewrite preserves each file's mtime (the web app
  sorts history by mtime), and handles encoded-name collisions by merging
  file-by-file without clobbering.
- **Codex:** `~/.codex/sessions/.../rollout-*.jsonl` `cwd`, `~/.codex/config.toml`
  `[projects."<path>"]` section rename, and `~/.codex/state_5.sqlite`
  `threads.cwd` (+ `agent_path`) in one transaction.

Contract (`ProviderProjectMove`):

- `plan(inputs) → ProviderMovePlan | null` — side-effect-free; returns `null`
  when the provider has no hits. `ProviderMovePlan.payload` is provider-specific
  but **serializable**: the mover persists it in dry-run JSON and passes it back
  to the same adapter for `apply`/`renderText` without reading it. Every array in
  a plan — the mover's own rows and each payload's — is **ordered by the data**,
  because `--json` serializes the plan verbatim and the dry-run report prints it
  row by row. -> See:
  [architecture.md#read-ordering](architecture.md#read-ordering).
- `apply(plan) → counts` — performs the mutations and returns the real applied
  counts (e.g. codex threads = rows actually updated).
- `renderText(plan) → lines` — the provider's dry-run/apply detail section.
- `countRows` — the provider's legacy count-table rows (`{ key, label }`), e.g.
  Claude `{claudeProjects → ~/.claude/projects}`, Codex
  `{codexSessions → ~/.codex/sessions}`, `{codexConfig → ~/.codex/config}`,
  `{codexThreads → ~/.codex/state_5}`.

**Command boundary preserves the legacy surface.** Although provider plans are
opaque/nested internally, `MoveCounts` stays the flat legacy shape
(`{ sessions, registry, claudeProjects, codexSessions, codexConfig,
codexThreads }`) and the text count table keeps its historical labels — both
rendered even when a provider has zero hits. The labels and keys come from each
provider's `countRows` (provider-owned), so the command iterates the registry
rather than hard-coding provider knowledge. `ProjectMoveInputs.providerHomeOverrides`
(keyed by provider id) is the test seam for provider homes — the shared inputs
type does not grow `claudeHome`/`codexHome`. Dry-run displays plan counts; a real
apply displays apply counts (matching the historical plan-vs-apply split).

-> See: [src/lib/core/project/move.ts](../../../cli/src/lib/core/project/move.ts), [src/lib/core/agent/providers/project-move.ts](../../../cli/src/lib/core/agent/providers/project-move.ts), [src/commands/project/move.ts](../../../cli/src/commands/project/move.ts)

---

## Claude Assumptions (C1-C13)

| # | Assumption | Source | Code Location | Guard Test | If Violated |
|---|-----------|--------|---------------|------------|-------------|
| C1 | idle prompt is `❯` (U+276F) followed by NBSP+text or whitespace | TUI observation; Claude UI added a placeholder hint after `❯` separated by U+00A0 in 2026-05 — naive `❯\s*$` regex fails | `src/lib/core/agent/providers/claude.ts` (regex `/^❯\s/m`) | providers.test.ts: NBSP placeholder regression | waitForReady falls back to hook signal; if hook also broken → 30s timeout |
| C2 | shows "esc to interrupt" / "Thinking" / "Running…" when busy | TUI observation | `src/lib/core/agent/providers/idle.ts` (BUSY_PATTERNS) | agent-lifecycle: send→processing | isIdle false positive, status/list reports idle too early |
| C3 | hooks in `~/.claude/settings.json` | Claude docs | `src/lib/core/agent/lifecycle.ts#ensureClaudeHooks` | agent-lifecycle: processing→idle | hooks inactive, capture-only fallback |
| C4 | 12 hook events (SessionStart/UserPromptSubmit/Stop/StopFailure/PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/Notification/PreCompact/PostCompact/SessionEnd) | Claude docs (code.claude.com/docs/en/hooks) | `src/lib/core/agent/lifecycle.ts` (CLAUDE_HOOK_EVENTS) | hook-event.test.ts: applyHookEvent transitions; hooks-install.test.ts: install + idempotent overwrite | missing event → status stale, 5min fallback |
| C5 | SessionStart delayed until first prompt | R1 tested | `src/commands/agent/start.ts` ready→idle compensation | status detection: no-prompt start asserts idle | if Claude fires at boot → no impact (idempotent) |
| C6 | session file at `~/.claude/sessions/<pid>.json` | reverse engineering | `src/lib/core/agent/session-id.ts` | agent-lifecycle: sessionId not pending | sessionId fails, falls back to PENDING |
| C7 | session file has `{pid, sessionId, name}` | reverse engineering | `src/lib/core/agent/session-id.ts` | agent-sync: rename verifies name field | name sync verification fails (multmux doesn't depend on this field) |
| C8 | `--name` sets session name | Claude docs | `src/lib/core/agent/providers/claude.ts` | agent-lifecycle: session file name === handle | if Claude ignores --name → handle still correct |
| C9 | `--resume <uuid>` restores session | Claude docs | `src/commands/agent/start.ts` | agent-sync: capture after resume contains token | resume fails |
| C10 | `--dangerously-skip-permissions` skips confirmation | Claude docs | `src/lib/core/agent/providers/claude.ts` | all Claude tests implicitly depend | trust dialog blocks, TRUST_PATTERN attempts confirmation |
| C11 | `env -u CLAUDECODE` prevents nesting conflicts | observation | `src/lib/core/agent/providers/claude.ts` | **none** | nesting anomaly (low risk) |
| C12 | hook stdin is `{hook_event_name, session_id}` | Claude docs | `src/lib/core/agent/hook-event.ts#applyHookEvent` | hook-event.test.ts: end-to-end stdin/state-file | hook silently fails, capture fallback |
| C13 | Bash/PowerShell tool subprocesses expose `CLAUDE_CODE_SESSION_ID`, matching YACO state `sessionId` | Claude docs + live QA 2026-06-05 (`qa-claude-whoami`) | `src/lib/core/agent/whoami.ts` | whoami.test.ts: session-id fallback; live QA: `env -u TMUX_PANE yaco agent whoami --json` | `whoami` still resolves via `TMUX_PANE`; session-id fallback fails outside tmux pane env |

## Codex Assumptions (X1-X15)

| # | Assumption | Source | Code Location | Guard Test | If Violated |
|---|-----------|--------|---------------|------------|-------------|
| X1 | idle prompt is `›` (U+203A) | TUI observation | `src/lib/core/agent/providers/codex.ts` | agent-lifecycle: start→idle | waitForReady timeout |
| X2 | does not accept `--name` flag | tested | `src/lib/core/agent/providers/codex.ts` | codex name sync: /rename verification | stripNameFlag harmless but redundant |
| X3 | accepts `/rename <name>` when delivered via input-gated bracketed paste + Enter | tested | `src/commands/agent/start.ts`, `src/commands/agent/rename.ts`, `src/lib/core/agent/tmux.ts` | explicit rename integration verifies "Thread renamed"; `providers.test.ts` covers empty-input detection; `tmux.test.ts` enforces bracketed paste | provider title may lag or remain unsynced; YACO handle remains authoritative |
| X4 | hooks in `~/.codex/hooks.json` | Codex docs + source (codex-rs/hooks) | `src/lib/core/agent/lifecycle.ts#ensureCodexHooks` | agent-lifecycle: processing transition | hooks inactive |
| X5 | 8 hook events (SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PermissionRequest/PreCompact/PostCompact/Stop); PreCompact/PostCompact present in source but not yet in public docs | Codex source (`codex-rs/hooks/src/schema.rs`) confirmed via codex-hooks-research session 2026-05-10 | `src/lib/core/agent/lifecycle.ts` (CODEX_HOOK_EVENTS) | hook-event.test.ts: applyHookEvent transitions | fewer → reduced status updates |
| X6 | hooks synchronous (async=false) | Codex limitation | `src/lib/core/agent/lifecycle.ts#yacoHookGroup(event, false)` | hooks-install.test.ts: async flag verification | could switch to async |
| X7 | Stop hook reliable enough to drive status→idle and idle final-message notice | R1 tested → P5 retested; notice path covered 2026-06-22 | `src/lib/core/agent/hook-event.ts#fillIdleNotice` | hook-event.test.ts: Codex idle final_answer notice | status stays processing or idle notification has no Codex message |
| X8 | hooks-review screen is change-sensitive (shows only when an enabled unmanaged hook is new/changed; trust keyed per-hook hash under `[hooks.state]`) | Codex source (`startup_hooks_review.rs`, `hooks/src/engine/discovery.rs`) | `src/commands/agent/start.ts` (guard path), `src/lib/core/agent/lifecycle.ts#codexHooksAllYacoOwned`, `src/lib/core/agent/providers/codex.ts` | `test/trust-gate.test.ts` (gate + guard path) | foreign/unverifiable hook set → `blocked(trust)`, user reviews manually |
| X8 | requires `-c features.hooks=true` | Codex CLI feature list | `src/lib/core/agent/providers/codex.ts` | all Codex tests implicitly depend | hooks inactive |
| X9 | `suppress_unstable_features_warning` in config.toml | Codex docs | `src/lib/core/agent/lifecycle.ts#ensureCodexHooks` | **none** | warning text disrupts idle detection |
| X10 | session data in `~/.codex/state_5.sqlite` | reverse engineering | `src/lib/core/agent/session-id.ts` | agent-sync: sessionId recovered after repair | SQLite fails, rollout scan already succeeded or stays PENDING |
| X11 | SQLite `threads` table has `id`, `cwd`, `created_at` (no PID column); rollout scan is primary, DB is fallback | reverse engineering DB (2026-04-11: `logs` table dropped in migration #23; priority reversed to rollout-first for ms-precision concurrency safety) | `src/lib/core/agent/session-id.ts` | session-id.test.ts: SQL validation | query empty, sessionId stays PENDING |
| X12 | rollout files at `~/.codex/sessions/YYYY/MM/DD/`; a final answer is `phase="final_answer"` under **either** `event_msg.payload.type="agent_message"` (flat, `message` string) or `event_msg.payload.type="item_completed"` with `item.type="AgentMessage"` (text in `content[]` blocks discriminated by `type="Text"`) — every local rollout from 2026-08-07 uses the second | reverse engineering | `src/lib/core/agent/session-id.ts`, `src/lib/core/agent/providers/output.ts#resolveCodexLogPath` | agent-output.test.ts: Codex final parser; hook-event.test.ts: Codex idle notice | sessionId stays PENDING, output streaming fails, or idle notice is empty |
| X13 | detached Codex OSC 10/11 synthetic replies are gated by the provider adapter's `terminal.respondToColorQuery`; `start.ts` launches the responder right after `tmux new-session` when the adapter declares it (Codex does), with no fixed launch delay | provider-registry slice 2026-06-05 | gating in `src/commands/agent/start.ts`, responder in `src/lib/core/agent/tmux.ts#startOscColorQueryResponder`, flag in `src/lib/core/agent/providers/codex.ts` | lifecycle-guards test asserts Codex start launches the responder before publishing pid | input box may lose background tint if the responder attaches after Codex's first query |
| X14 | `codex resume <uuid>` restores session | Codex docs | `src/commands/agent/start.ts` | agent-sync: resume contains token | resume fails |
| X15 | Codex tool subprocesses expose `CODEX_THREAD_ID`, matching YACO state `sessionId` | live QA 2026-06-05 (`qa-codex-whoami`) | `src/lib/core/agent/whoami.ts` | whoami.test.ts: session-id fallback; live QA: `env -u TMUX_PANE yaco agent whoami --json` | `whoami` still resolves via `TMUX_PANE`; session-id fallback fails outside tmux pane env |

## Missing Guard Tests

| Assumption | Risk | Suggested Test |
|-----------|------|----------------|
| C11: env -u CLAUDECODE | low | verify CLAUDECODE unset inside tmux session |
| X9: suppress_unstable_features_warning | low | verify no warning text on startup |
| X12: rollout file path/format | medium | verify rollout scan in no-DB scenario |
| X13: OSC color query responder | medium | live startup probe verifies composer background ANSI appears and literal `rgb:...` replies are absent |

## Verified Behaviors

Prior art confirmed through probes and testing — not assumptions.

| Behavior | Verification | Discovered |
|----------|-------------|------------|
| Claude SessionStart does not fire without prompt (delayed to first prompt) | R1 tested: monitored state file 20s, stayed `starting` | R1 |
| Codex Stop hook reliable in single test (P5: Stop fired promptly after completion, status→idle) | P5 probe 2026-04-10 | P5 |
| Claude `--resume <uuid> --name <handle>` natively supported, name synced to session file | P1 probe 2026-04-10 | P1 |
| Claude `--resume <name>` (by session name) natively supported | P2 probe 2026-04-10 | P2 |
| Codex `resume <name>` (by thread name) natively supported | P3 probe 2026-04-10 | P3 |
| Codex SessionStart does not fire without prompt (delayed to first prompt) | P4 probe 2026-04-10 | P4 |
| Codex rejects `--name` flag (exits with error) | tested | early dev |
| Codex accepts `/rename <name>` TUI command | tested + integration test verifies "Thread renamed" | R1 |
| Codex `/rename` works during processing | P6 probe 2026-04-10 | P6 |
| Claude SessionEnd fires on context reset (process still alive) | observed + code guard (hook writes idle, not delete) | early dev |
| Codex has no SessionEnd hook | Codex docs + tested | early dev |
| wrapper EXIT trap compensates both: deletes state file on process death | design + test coverage | early dev |

-> See: [lifecycle.md](lifecycle.md) for visual state diagrams and sequence flows
