# Providers

> Last updated: 2026-06-06 (tui-provider-docs)

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

All provider-specific filesystem, database, and log parsing lives under `cli/`.
`app/server` never resolves or parses `~/.claude`, `~/.codex`, or a future
provider home directly — it consumes `yaco agent ... --json` or one explicit CLI
stream. Adding a TUI provider is **one CLI adapter plus UI metadata**, not edits
across start, status, session-id, history, streaming, project move, doctor, and
terminal quirks.

Adapter responsibilities, by capability:

| Capability | Required? | Owns |
|---|---|---|
| `command` | yes | launch command (`build`), resume canonicalization (`normalizeResumeArgs`), name-flag policy (`normalizeStartArgs`/`postStartInputs`), live rename (`renameInputs`), trust/review prompts (`startupInterstitials`) |
| `detection` | yes | `idlePatterns` / `busyPatterns` for screen-scrape status fallback |
| `sessionId` | yes | pending sentinel, session-id env keys, start-resolution strategy, `resolve` from provider storage |
| `hooks` | optional | hook events, install/merge, config path, install probe (drives `install` + `doctor`) |
| `terminal` | optional | provider-runtime / headless-PTY terminal compatibility (see below) |
| `history` | optional | History-tab rows + per-session summary labels; absent ⇒ provider omitted from history |
| `output` | optional | output cursor + line classification for reply streaming; absent ⇒ callers fall back to `capture` |
| `projectMove` | optional | provider-native cwd-keyed rewrites (see [Project Move](#project-move)) |

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

Hook is the **primary** status signal; screen scraping is fallback only (trust dialog auto-accept, hook-less providers).

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

`PostToolUse` keeps state file mtime fresh during long turns, preventing stale threshold from triggering capture fallback. Also corrects status if `Stop` fired prematurely. Codex `PostToolUse` currently only fires for Bash tool calls.

`Notification`, `PreCompact`, and `PostCompact` use the matcher field as a content filter (notification type / compaction trigger) rather than a label, so they are registered with `matcher: "*"` (the same path as tool-scoped events). Lifecycle events use the `HOOK_MARKER` label `yaco-agent-hook`.

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

An empty prompt opens an idle session (no initial task).

For Codex, the runtime always sends `/rename <handle>` after the agent is ready (both explicit and default names). This works even during active processing, so all args pass through to Codex verbatim — no prompt deferral or arg parsing needed. For Claude, the runtime injects `--name <handle>` into the launch command when no explicit name is provided, so default word-based names are persisted natively.

Codex slash commands are delivered through tmux bracketed paste followed by `Enter`. Raw character-by-character `send-keys` can race Codex's slash-command autocomplete, causing partial commands such as `/rename` to be interpreted as another command while the remainder stays in the composer.

For Codex, an unnamed empty start can stay `pending:awaiting-first-prompt` until a real prompt creates a thread. The `/rename` may resolve the thread earlier, but that timing is not guaranteed.

## Resume

Both flag form (`--resume <id>`) and positional form (`resume <id>` as leading arg) are accepted. The runtime canonicalizes per provider:

| Provider | User writes (any form) | Resulting agent CLI |
|----------|----------------------|---------------------|
| Claude | `yaco claude --resume <id>` or `yaco claude resume <id>` | `claude --resume <id>` (flag) |
| Codex | `yaco codex --resume <id>` or `yaco codex resume <id>` | `codex resume <id>` (subcommand) |

When resuming with `--name`, Codex submits `/rename <handle>` after ready (same as fresh starts) as best-effort provider-title sync. Startup does not wait for the slash command to finish. The `sessionId` is written to the state file immediately (no polling needed).

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

- The shared follower (`followOutput`) owns `stat`, byte-range reads,
  byte-space partial-line buffering, and offset advancement. Providers only
  `resolveCursor` and `classifyLine`.
- `classifyLine` returns **at most one** `AgentOutputEvent` per complete line
  (`AgentOutputEvent | null`), so each event maps to a unique `nextOffset` and
  no same-line event is lost across a reconnect. Claude folds lead-in text into
  the single `question` event.
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

-> See: [src/lib/core/agent/providers/output.ts](../../../cli/src/lib/core/agent/providers/output.ts), [src/commands/agent/output.ts](../../../cli/src/commands/agent/output.ts)

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
  to the same adapter for `apply`/`renderText` without reading it.
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
| C2 | shows "esc to interrupt" / "Thinking" / "Running…" when busy | TUI observation | `src/lib/core/agent/providers/idle.ts` (BUSY_PATTERNS) | agent-lifecycle: send→processing | isIdle false positive, capture --wait returns too early |
| C3 | hooks in `~/.claude/settings.json` | Claude docs | `src/lib/core/agent/lifecycle.ts#ensureClaudeHooks` | agent-lifecycle: processing→idle | hooks inactive, capture-only fallback |
| C4 | 12 hook events (SessionStart/UserPromptSubmit/Stop/StopFailure/PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/Notification/PreCompact/PostCompact/SessionEnd) | Claude docs (code.claude.com/docs/en/hooks) | `src/lib/core/agent/lifecycle.ts` (CLAUDE_HOOK_EVENTS) | hook-event.test.ts: applyHookEvent transitions; hooks-install.test.ts: install + idempotent overwrite | missing event → status stale, 3min fallback |
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
| X3 | accepts `/rename <name>` when delivered via bracketed paste + Enter | tested | `src/commands/agent/start.ts`, `src/lib/core/agent/tmux.ts` | explicit rename integration verifies "Thread renamed"; `tmux.test.ts` enforces bracketed paste | provider title may lag or remain unsynced; YACO handle remains authoritative |
| X4 | hooks in `~/.codex/hooks.json` | Codex docs + source (codex-rs/hooks) | `src/lib/core/agent/lifecycle.ts#ensureCodexHooks` | agent-lifecycle: processing transition | hooks inactive |
| X5 | 8 hook events (SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PermissionRequest/PreCompact/PostCompact/Stop); PreCompact/PostCompact present in source but not yet in public docs | Codex source (`codex-rs/hooks/src/schema.rs`) confirmed via codex-hooks-research session 2026-05-10 | `src/lib/core/agent/lifecycle.ts` (CODEX_HOOK_EVENTS) | hook-event.test.ts: applyHookEvent transitions | fewer → reduced status updates |
| X6 | hooks synchronous (async=false) | Codex limitation | `src/lib/core/agent/lifecycle.ts#yacoHookGroup(event, false)` | hooks-install.test.ts: async flag verification | could switch to async |
| X7 | Stop hook reliable in single test (P5, 2026-04-10) | R1 tested → P5 retested | capture fallback | G4 guard test ongoing monitoring | capture handles correctly |
| X8 | requires `-c features.hooks=true` | Codex CLI feature list | `src/lib/core/agent/providers/codex.ts` | all Codex tests implicitly depend | hooks inactive |
| X9 | `suppress_unstable_features_warning` in config.toml | Codex docs | `src/lib/core/agent/lifecycle.ts#ensureCodexHooks` | **none** | warning text disrupts idle detection |
| X10 | session data in `~/.codex/state_5.sqlite` | reverse engineering | `src/lib/core/agent/session-id.ts` | agent-sync: sessionId recovered after repair | SQLite fails, rollout scan already succeeded or stays PENDING |
| X11 | SQLite `threads` table has `id`, `cwd`, `created_at` (no PID column); rollout scan is primary, DB is fallback | reverse engineering DB (2026-04-11: `logs` table dropped in migration #23; priority reversed to rollout-first for ms-precision concurrency safety) | `src/lib/core/agent/session-id.ts` | session-id.test.ts: SQL validation | query empty, sessionId stays PENDING |
| X12 | rollout files at `~/.codex/sessions/YYYY/MM/DD/` | reverse engineering | `src/lib/core/agent/session-id.ts` | **none** | sessionId stays PENDING |
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
