# Providers

> Last updated: 2026-06-05 (tui-provider-output-follow-cli)

## Supported Providers

| Provider | CLI Command | Idle Pattern | Flags |
|----------|------------|--------------|-------|
| claude   | `env -u CLAUDECODE claude` | `^❯\s` (NBSP-tolerant) | `--dangerously-skip-permissions` |
| codex    | `env COLORTERM=truecolor codex` | `›` prompt | `-c features.hooks=true --yolo` |

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

Define in `src/lib/core/agent/providers.ts`:
- `command`: shell command to launch the agent
- `idlePattern`: regex for "waiting for input" state
- `busyPatterns`: regexes for "still working" indicators
- `flags`: CLI flags for autonomous mode

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

-> See: [src/lib/core/agent/providers.ts](../../../cli/src/lib/core/agent/providers.ts)

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

---

## Claude Assumptions (C1-C13)

| # | Assumption | Source | Code Location | Guard Test | If Violated |
|---|-----------|--------|---------------|------------|-------------|
| C1 | idle prompt is `❯` (U+276F) followed by NBSP+text or whitespace | TUI observation; Claude UI added a placeholder hint after `❯` separated by U+00A0 in 2026-05 — naive `❯\s*$` regex fails | `src/lib/core/agent/providers.ts` (regex `/^❯\s/m`) | providers.test.ts: NBSP placeholder regression | waitForReady falls back to hook signal; if hook also broken → 30s timeout |
| C2 | shows "esc to interrupt" / "Thinking" / "Running…" when busy | TUI observation | `src/lib/core/agent/providers.ts` (BUSY_PATTERNS) | agent-lifecycle: send→processing | isIdle false positive, capture --wait returns too early |
| C3 | hooks in `~/.claude/settings.json` | Claude docs | `src/lib/core/agent/lifecycle.ts#ensureClaudeHooks` | agent-lifecycle: processing→idle | hooks inactive, capture-only fallback |
| C4 | 12 hook events (SessionStart/UserPromptSubmit/Stop/StopFailure/PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/Notification/PreCompact/PostCompact/SessionEnd) | Claude docs (code.claude.com/docs/en/hooks) | `src/lib/core/agent/lifecycle.ts` (CLAUDE_HOOK_EVENTS) | hook-event.test.ts: applyHookEvent transitions; hooks-install.test.ts: install + idempotent overwrite | missing event → status stale, 3min fallback |
| C5 | SessionStart delayed until first prompt | R1 tested | `src/commands/agent/start.ts` ready→idle compensation | status detection: no-prompt start asserts idle | if Claude fires at boot → no impact (idempotent) |
| C6 | session file at `~/.claude/sessions/<pid>.json` | reverse engineering | `src/lib/core/agent/session-id.ts` | agent-lifecycle: sessionId not pending | sessionId fails, falls back to PENDING |
| C7 | session file has `{pid, sessionId, name}` | reverse engineering | `src/lib/core/agent/session-id.ts` | agent-sync: rename verifies name field | name sync verification fails (multmux doesn't depend on this field) |
| C8 | `--name` sets session name | Claude docs | `src/lib/core/agent/providers.ts` | agent-lifecycle: session file name === handle | if Claude ignores --name → handle still correct |
| C9 | `--resume <uuid>` restores session | Claude docs | `src/commands/agent/start.ts` | agent-sync: capture after resume contains token | resume fails |
| C10 | `--dangerously-skip-permissions` skips confirmation | Claude docs | `src/lib/core/agent/providers.ts` | all Claude tests implicitly depend | trust dialog blocks, TRUST_PATTERN attempts confirmation |
| C11 | `env -u CLAUDECODE` prevents nesting conflicts | observation | `src/lib/core/agent/providers.ts` | **none** | nesting anomaly (low risk) |
| C12 | hook stdin is `{hook_event_name, session_id}` | Claude docs | `src/lib/core/agent/hook-event.ts#applyHookEvent` | hook-event.test.ts: end-to-end stdin/state-file | hook silently fails, capture fallback |
| C13 | Bash/PowerShell tool subprocesses expose `CLAUDE_CODE_SESSION_ID`, matching YACO state `sessionId` | Claude docs + live QA 2026-06-05 (`qa-claude-whoami`) | `src/lib/core/agent/whoami.ts` | whoami.test.ts: session-id fallback; live QA: `env -u TMUX_PANE yaco agent whoami --json` | `whoami` still resolves via `TMUX_PANE`; session-id fallback fails outside tmux pane env |

## Codex Assumptions (X1-X15)

| # | Assumption | Source | Code Location | Guard Test | If Violated |
|---|-----------|--------|---------------|------------|-------------|
| X1 | idle prompt is `›` (U+203A) | TUI observation | `src/lib/core/agent/providers.ts` | agent-lifecycle: start→idle | waitForReady timeout |
| X2 | does not accept `--name` flag | tested | `src/lib/core/agent/providers.ts` | codex name sync: /rename verification | stripNameFlag harmless but redundant |
| X3 | accepts `/rename <name>` when delivered via bracketed paste + Enter | tested | `src/commands/agent/start.ts`, `src/lib/core/agent/tmux.ts` | explicit rename integration verifies "Thread renamed"; `tmux.test.ts` enforces bracketed paste | provider title may lag or remain unsynced; YACO handle remains authoritative |
| X4 | hooks in `~/.codex/hooks.json` | Codex docs + source (codex-rs/hooks) | `src/lib/core/agent/lifecycle.ts#ensureCodexHooks` | agent-lifecycle: processing transition | hooks inactive |
| X5 | 8 hook events (SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PermissionRequest/PreCompact/PostCompact/Stop); PreCompact/PostCompact present in source but not yet in public docs | Codex source (`codex-rs/hooks/src/schema.rs`) confirmed via codex-hooks-research session 2026-05-10 | `src/lib/core/agent/lifecycle.ts` (CODEX_HOOK_EVENTS) | hook-event.test.ts: applyHookEvent transitions | fewer → reduced status updates |
| X6 | hooks synchronous (async=false) | Codex limitation | `src/lib/core/agent/lifecycle.ts#yacoHookGroup(event, false)` | hooks-install.test.ts: async flag verification | could switch to async |
| X7 | Stop hook reliable in single test (P5, 2026-04-10) | R1 tested → P5 retested | capture fallback | G4 guard test ongoing monitoring | capture handles correctly |
| X8 | requires `-c features.hooks=true` | Codex CLI feature list | `src/lib/core/agent/providers.ts` | all Codex tests implicitly depend | hooks inactive |
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
