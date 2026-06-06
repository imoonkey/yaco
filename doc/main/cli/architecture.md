# Architecture

> Last updated: 2026-06-06 (tui-provider-docs)

## Overview

The agent runtime orchestrates coding agents (Claude Code, Codex) via tmux,
exposed through the `yaco agent ...` subcommand surface. Session metadata
lives in `${YACO_HOME:-~/.yaco}/sessions/<handle>.json`, resolved via
`src/lib/core/agent/session-state.ts#sessionsRoot()` (honors
`YACO_AGENT_SESSIONS_DIR` env override, otherwise falls back to
`src/lib/core/paths/yaco-home.ts#sessionsDir()`). Status is tracked via
provider hooks first, then stale-state and capture-pane fallbacks.

## Components

```
src/
  main.ts                              # dispatcher (areas, --json envelope, render); top-level provider shortcut
  hook-event-bin.ts                    # slim Bun entry for hook fires (avoids loading the full command tree)
  commands/
    paths.ts                           # yaco paths
    agent/
      index.ts                         # yaco agent area handler + parseStartArgs (-- passthrough split)
      start.ts                         # start an agent session (returns SessionState)
      send.ts                          # send a message (or stdin) to a running session
      capture.ts                       # capture terminal output (with idle wait)
      rename.ts                        # rename a session handle (idle-only)
      kill.ts                          # kill one session or all current-project sessions
      status.ts                        # list sessions and their idle/busy state (supports --json)
      whoami.ts                        # resolve current process to its YACO session handle
      hook-event.ts                    # CLI handler for `yaco agent hook-event <EventName>`
      hooks/install.ts                 # yaco agent hooks install
  lib/core/agent/
    model.ts                           # SessionState, RuntimeSessionState, HookEvent, PENDING_SESSION_ID, name helpers, ANSI strip
    providers/                         # typed TuiProvider registry (index, types, claude, codex; idle/hooks/history/output/project-move capabilities)
    providers.ts                       # legacy shim over providers/ for not-yet-migrated call sites (Provider, getProvider, isIdle)
    session-state.ts                   # state file CRUD; YACO_AGENT_SESSIONS_DIR / sessionsDir() resolver
    session-id.ts                      # Claude PID scan; Codex rollout (primary) + DB (fallback)
    whoami.ts                          # current-agent identity resolver (tmux pane, session env, ancestor pid)
    lifecycle.ts                       # ensureHooks (wrapper install + provider config merge); buildWrappedCommand
    hook-event.ts                      # applyHookEvent + runHookEventForHandle + STOP_DEBOUNCE_MS
    tmux.ts                            # tmux operations (sessions, panes, PIDs, OSC responder, theme detection)
    words.ts                           # adjective/noun lists for default handles
scripts/
  agent-wrapper.sh                     # sole shell artifact — installed verbatim to ${YACO_HOME}/agent-wrapper.sh
```

The `multmux` standalone entry (old `src/index.ts`) was retired — `yaco agent`
is now the canonical surface. Top-level provider shortcuts
(`yaco claude/codex [args...]`) delegate to `yaco agent start <provider>`;
mid-layer `yaco agent claude ...` is rejected with USAGE (canonical is
`yaco agent start <provider>`).

## Core Abstractions

### Session Lifecycle

1. `start` creates a tmux session named:
   - handle = tmux session name directly (default `<provider>-<adj>-<adj>-<noun>-<6hex>`, or explicit `--name`)
2. Provider CLI launches immediately inside the detached tmux session (`claude`, `codex`)
3. Managed sessions apply tmux runtime options (`status off`, `focus-events on`, `allow-passthrough on`) and append RGB terminal features
4. `waitForReady()` is **hook-first**: it polls the state file and returns immediately when status reaches `idle` or `processing` (whichever the hook writes first). The pane is only inspected as a fallback — to auto-accept the trust dialog, to handle Codex's "Hooks need review" re-trust prompt when the hook command changes, and to detect a stable idle prompt for hook-less or hook-broken sessions. On success, `start()` syncs the latest state file: only `starting→idle` transitions are applied; a hook-written `processing` is never downgraded. PID and sessionId are persisted (`resolved` > `pending` > `empty`) so status does not depend on hook timing. If the session dies during bootstrap, `start()` throws instead of returning phantom state.
5. For named Codex starts, the agent runtime sends `/rename <handle>` after the agent is ready. This works even during active processing (P6 verified), so all args pass through to Codex verbatim — no prompt deferral or arg parsing needed. Both fresh starts and resume+name follow the same `/rename` path.
6. `capture --wait` polls idle detection to know when the agent is done
7. `kill` uses three-state liveness (`checkSessionAlive`): kills live sessions, cleans up dead state, and refuses on uncertainty (preserves state file). `kill --all` skips uncertain sessions.

**Resume (`--resume <id>` or `resume <id>`):** Resumes an existing agent conversation. Both flag form (`--resume <id>`) and positional subcommand form (`resume <id>` as the leading arg) are recognized and canonicalized per provider: Claude gets `--resume <id>` (flag), Codex gets `resume <id>` (subcommand). The `sessionId` is written to the state file immediately (no polling needed).

**Dead-handle reclaim:** Before name resolution, `start()` checks if the requested handle has a stale state file for a dead session (`checkSessionAlive === false`). If so, it deletes the stale file, preventing the user from getting `worker-2` when `worker` is actually available.

**Send optimistic hint:** `send()` writes `status=processing` to the state file before `sendKeys`, so `capture --wait` doesn't return stale pre-send idle buffer. The hook remains authority and will overwrite. On sendKeys failure, the hint is reverted only if the session is still alive and the state file hasn't been replaced.

**Input delivery:** `sendKeys()` loads message text into a tmux buffer, pastes it with bracketed paste (`paste-buffer -p`), then sends a real `Enter` key. Text newlines stay part of the message; submission is always the final `Enter`. This avoids Codex slash-command autocomplete consuming partial input before the submit key arrives.

### Status Detection

Three-layer approach, in priority order. All read paths (`status` text/JSON, `capture --wait`) use the shared `reconcile(handle)` function in `commands/agent/status.ts` as the single source of truth:

1. **Hook-based (primary)**: Claude Code (12 events) and Codex (8 events) fire lifecycle hooks (SessionStart, UserPromptSubmit, Stop/StopFailure, PreToolUse/PostToolUse/PostToolUseFailure, PermissionRequest, Notification, PreCompact/PostCompact, SessionEnd — provider availability varies, see [providers.md](providers.md#hook-availability)). Provider configs point at `bun /…/cli/src/hook-event-bin.ts <EventName>` (a slim entry that avoids loading the full command tree on every fire — keeps cold start ~150 ms). The handler reads the event JSON from stdin and runs `runHookEventForHandle` (TypeScript), which derives the handle from the live tmux session name (`tmux display-message -p '#{session_name}'`), applies `applyHookEvent` to compute the next state, and writes via the same atomic temp-file-rename writer. **Note:** Codex lacks `SessionEnd` and `StopFailure` hooks — see exit-trap wrapper below. **Context reset safety:** `SessionEnd` sets status to `idle` (not delete), because Claude fires `SessionEnd` → `SessionStart` on context window resets while the process is still alive. Actual file deletion happens only via the wrapper EXIT trap.

   **Stop debounce.** `Stop`/`StopFailure` events go through a 120 ms re-check window: read state, sleep, re-read; if the file mutated during the pause, a fresher event (typically the next turn's `UserPromptSubmit`) already won and the Stop is dropped. Otherwise, the transition to `idle` is applied. This protects against a late Stop for turn N overwriting the processing state of turn N+1.

2. **Screen-scrape fallback**: Regex pattern matching on the live tail of terminal output (`isIdle`, `BUSY_PATTERNS` in `providers/idle.ts`). Used when hooks aren't installed (third-party providers, broken hook script) or to auto-accept the trust dialog at startup. The busy-pattern check uses a tighter ~12-line window so transient MCP-boot messages (`esc to interrupt`) that scroll into history do not mask a settled idle prompt. Each adapter's `detection` declares `idlePatterns` (prompt regexes) and `busyPatterns` (working indicators), aggregated by `providers/idle.ts`. The Claude prompt regex `/^❯\s/m` accepts both U+0020 and U+00A0 (NBSP) after `❯`.

3. **Staleness fallback**: If the state file says `processing` but its mtime is > 30 minutes old, distrust it and fall through to capture-based detection.

4. **Orphan GC**: `status` (list mode) reconciles state files against live tmux sessions using `checkSessionAlive()`, which returns three-state results: `true` (alive), `false` (confirmed dead), `null` (uncertain — timeout, signal, tmux server busy). GC only deletes on confirmed death (`false`); uncertain results are skipped to prevent false deletion when tmux is under load (e.g., 40+ sessions). Handles post-reboot cleanup.

-> See: [src/lib/core/agent/session-state.ts](../../../cli/src/lib/core/agent/session-state.ts), [src/lib/core/agent/hook-event.ts](../../../cli/src/lib/core/agent/hook-event.ts), [src/lib/core/agent/lifecycle.ts](../../../cli/src/lib/core/agent/lifecycle.ts), [src/lib/core/agent/tmux.ts](../../../cli/src/lib/core/agent/tmux.ts)

### State Machine

```
States: starting, idle, processing
File existence = active session; file deletion = session ended.

Transitions:
  [yaco agent start]   → starting
  [waitForReady: hook says idle/processing] → adopt hook status (primary path)
  [waitForReady: screen idle, hook silent]  → idle (fallback)
  SessionStart         → idle        (guard: skip if already processing)
  UserPromptSubmit     → processing  (from starting or idle)
  PreToolUse / PostToolUse / PreCompact / PostCompact → processing
  Notification (idle_prompt | permission_prompt) → idle
  PermissionRequest    → idle        (waiting for user approval)
  [yaco agent send]    → processing  (optimistic hint; hook overwrites)
  Stop / StopFailure   → idle        (after 120ms debounce; dropped if state mutated during the pause)
  SessionEnd           → idle        (context reset safe — process may still be alive)
  [wrapper EXIT trap]  → [file deleted]  (process actually died)
  [tmux session confirmed dead]  → [GC deletes file]  (three-state: only on false, not null)
  [yaco agent kill]    → [file deleted]
  [bootstrap death]    → [file deleted + Error thrown]  (start never returns phantom state)

Context window reset sequence:
  SessionEnd → idle → SessionStart → idle (new sessionId) → seamless
```

-> See: [lifecycle.md](lifecycle.md) for visual state diagrams and sequence flows.

### Exit-Trap Wrapper

All agent commands run inside `${YACO_HOME:-~/.yaco}/agent-wrapper.sh` (path
from `src/lib/core/paths/yaco-home.ts#agentWrapperPath()`), which sets a bash
`EXIT` trap. On process exit (normal, error, or signal), the trap deletes
the state file directly.

- **Sole shell artifact.** The wrapper body is shipped as a real file at `cli/scripts/agent-wrapper.sh` and installed verbatim by `yaco agent hooks install`. Shell is the only stack where the EXIT trap reliably fires when the tmux pane dies abruptly, so this stays out of TypeScript by design (Shell Boundary).
- **Session name re-read at exit** — the EXIT trap calls `tmux display-message -p '#{session_name}'` to get the current name (which reflects any renames that occurred during the session's lifetime). Falls back to the startup-cached name when the tmux session is already gone (e.g., `tmux kill-session`).
- **Rename breadcrumb** — `renameState()` writes `.renamed-<oldHandle>` in the sessions dir pointing to the new name. Write-before-delete: new state file is written before old is removed, preventing a race where GC deletes the old file between tmux rename and state rename (leaving no file). Callers pass pre-read state to avoid a re-read race with GC. Chain-safe: A→B→C updates A's breadcrumb to point to C. Cleanup: EXIT trap removes breadcrumb on exit; `deleteState()` removes breadcrumbs to/from the deleted handle; `status` GC sweeps orphans whose target file is gone.
- **Handle-reuse guard** — the wrapper receives the session's `createdAt` and only deletes the state file if the on-disk file still belongs to the same launch. This prevents an older exiting process from deleting a newer session that quickly reused the same default handle.
- **Primary cleanup mechanism** — the only code path that deletes state files on session end.
- **Essential for Codex** (which lacks `SessionEnd` hook) and Claude crash scenarios.
- **Complements the TS hook-event handler** — hooks handle status transitions (`idle`/`processing`); wrapper handles file lifecycle (deletion).
- **Login + interactive bash for the agent** — after the trap is installed, the wrapper runs the agent via `bash -lic 'exec "$@"' _ "$@"` so claude/codex inherit the same env as if launched from a hand-opened terminal: sources `/etc/profile`, `~/.profile`, `~/.bashrc`; picks up `SSH_AUTH_SOCK` (via keychain), full PATH (cargo/nvm/cuda/etc.), and other interactive-shell exports. Without this the workflow → agent → tmux → `/bin/sh -c` chain skipped every shell init and the agent had a stripped-down env. The wrapper also `unset`s `npm_(config|lifecycle|package)_*` first because tmux server caches its initial env — vars leaked when the parent was launched via `npm run` (e.g. `npm_config_prefix`) make nvm refuse to initialize.

-> See: [src/lib/core/agent/lifecycle.ts](../../../cli/src/lib/core/agent/lifecycle.ts), [scripts/agent-wrapper.sh](../../../cli/scripts/agent-wrapper.sh), [src/commands/agent/start.ts](../../../cli/src/commands/agent/start.ts)

### Hook Installation

`yaco agent hooks install` (handler in `src/commands/agent/hooks/install.ts`)
calls `ensureHooks` for both providers. `ensureHooks` writes
`${YACO_HOME}/agent-wrapper.sh` from `cli/scripts/agent-wrapper.sh` (chmod
0755, only rewrites when the bytes differ) and then merges yaco-owned
entries into the provider configs.

The canonical entry point for hook merging is now `yaco install` (writes the
same configs plus the rest of the install state). `yaco agent hooks install`
remains as the focused command for re-installing hooks only.

- **Idempotent overwrite.** For each hook event the installer computes the target group, finds any pre-existing yaco-owned entry (identified by the `yaco-agent-hook` marker OR a hook command shaped like `bun .../hook-event-bin.ts <Event>` / `… agent hook-event <Event>`), and replaces it in place when the content differs. Unrelated user entries are preserved verbatim, in their original position.
- **Marker disambiguation.** Tool-scoped events (`PreToolUse`, `PostToolUse`, `Notification`, `PreCompact`, `PostCompact`, `PermissionRequest`, `PostToolUseFailure`) use matcher `"*"` (tool-name filter); other events use matcher `yaco-agent-hook` (a marker label). Ownership is decided by `isYacoOwnedGroup` — marker match OR yaco-shaped command — so a user's own `"*"` entry cannot be misclassified.
- **Hook command — canonical form.** Resolved once at install time via `hookBinary()` → `<absolute-yaco-binary> agent hook-event <Event>`. Resolution order: `$YACO_BIN_DIR/yaco` → `process.argv[0]` (when it ends with `/yaco`, i.e. the compiled binary is itself executing) → `which yaco` → literal `"yaco"`. Absolute paths ensure the hook works even when the tmux server / provider runs with a stripped PATH. The pre-yc-install-doctor form (`bun <abs-path>/cli/src/hook-event-bin.ts <Event>`) was retired because it required `bun` AND a repo checkout to be reachable at hook-fire time — neither survives a `tools/install.sh` that placed the compiled binary in `$BIN_DIR` and then moved the repo away.
- **Per-event cold-start preserved by `main.ts` fast-path.** When `argv[0:2] === ['agent','hook-event']`, the dispatcher lazy-imports only `commands/agent/hook-event.ts` and skips the full command-tree import — same effect as the legacy `hook-event-bin.ts` entry. `hook-event-bin.ts` is retained as an internal test convenience but is NOT what install writes into provider configs.
- **`isYacoHookCommand` accepts both shapes** (`hook-event-bin.ts` OR `agent hook-event`) so the ownership check survives upgrades from a pre-yc-install-doctor footprint. The merge then OVERWRITES the old command in place with the canonical form.

### Session ID Resolution

`sessionId` identifies the agent's own conversation — usable with `claude --resume <uuid>` / `codex resume <uuid>`. Resolved from local files, not hooks alone:

| Provider | Source | Method |
|----------|--------|--------|
| Claude | `~/.claude/sessions/<pid>.json` | Direct PID filename match, then fallback scan |
| Codex | `~/.codex/sessions/` rollout files (primary), `~/.codex/state_5.sqlite` threads table (fallback) | Rollout birthtime ms-match → DB `SELECT id FROM threads WHERE cwd = ? AND created_at > ? AND created_at < ? ORDER BY created_at ASC LIMIT 1` |

**Claude resolution:** PID-based. The state file `pid` field stores the agent CLI PID (not the tmux pane PID). `getAgentPid()` in `tmux.ts` searches the live descendant tree under `#{pane_pid}` and prefers the expected provider command (`claude` / `codex`) instead of assuming a fixed 1-2 level shape. `status --json` repairs stale PIDs on read.

**Codex resolution:** Two-tier, no PID. Codex decoupled thread identity from OS processes — the `threads` table has no PID column. Primary: rollout file scan (`~/.codex/sessions/YYYY/MM/DD/`) matches by birthtime (ms precision, ±1s skew / 60s delay window). Fallback: SQLite `threads` table query by CWD + bounded time window (`[sessionStart - 1s, sessionStart + 60s]`, `ASC` to pick earliest match). Rollout scan is preferred because ms-precision birthtimes reliably distinguish concurrent same-CWD sessions; the DB's epoch-second `created_at` cannot.

**Timing:** Claude session files exist at CLI boot. Unnamed empty Codex starts can legitimately stay `"pending:awaiting-first-prompt"` until a real prompt creates a thread. Named empty Codex starts may resolve earlier because `/rename` itself submits input, but that timing is not guaranteed. Resume sessions skip polling entirely — the sessionId is known upfront from the `--resume` flag.

**Race avoidance:** `session-state.ts` writes state atomically via temp-file + rename. `start()` syncs the latest state file after readiness instead of trusting hook order, and `status --json` repairs PID/sessionId drift on read without persisting undocumented fields. The wrapper EXIT trap compares `createdAt` before deleting so older exits cannot wipe a newer recycled handle. Codex rollout scan only accepts files created within [sessionStart - 1s, sessionStart + 60s], preventing stale thread reuse. Codex DB fallback uses the same bounded window with `ASC` ordering to pick the earliest match — concurrent same-CWD sessions each claim their own thread as long as they start >1s apart.

-> See: [src/lib/core/agent/session-id.ts](../../../cli/src/lib/core/agent/session-id.ts)

### Current-Agent Identity (`whoami`)

`yaco agent whoami` resolves the current process back to its YACO-managed
session handle. Text mode prints only the handle; `--json` returns the full
runtime state plus `source` (`tmux-pane`, `session-id`, or `ancestor-pid`).

Resolution is intentionally ordered from strongest to weakest signal:

1. **tmux pane identity** — if `TMUX_PANE` is present, ask tmux for that
   pane's `#{session_name}` and accept it only when a matching YACO state file
   exists. This is the normal local path for both Claude and Codex because the
   YACO handle is the tmux session name.
2. **provider session-id env** — match known tool-subprocess variables against
   state `sessionId`: `CODEX_THREAD_ID` for Codex and
   `CLAUDE_CODE_SESSION_ID` for Claude Code Bash/PowerShell tools and hooks.
   YACO does not use remote-only Claude session variables for local identity.
3. **ancestor PID** — walk the OS parent chain from the current `whoami`
   process and choose the nearest ancestor whose PID matches a YACO state
   `pid`. This handles wrapper/tool nesting without assuming a fixed number of
   process levels; when multiple managed agents appear in the ancestry, the
   closest one wins.

If no signal maps to a live managed state file, the command returns
`NOT_FOUND` instead of guessing.

-> See: [src/lib/core/agent/whoami.ts](../../../cli/src/lib/core/agent/whoami.ts), [src/commands/agent/whoami.ts](../../../cli/src/commands/agent/whoami.ts)

### JSON Output (`--json`) and Dual-Mode Capture

`yaco agent start --json` and `yaco agent status --json` output full
`SessionState` as JSON inside the envelope. Fields: `handle`, `provider`,
`sessionPath`, `pid`, `sessionId`, `status`, `createdAt`.

`yaco agent capture` is dual-mode:
- **text mode** (no `--json`) — the renderer recognizes the handler's `{ text: "..." }` shape and writes the captured pane buffer to stdout verbatim. No JSON wrap, no surrounding text — bytes round-trip.
- **`--json` mode** — same handler return wraps as `{ ok:true, data:{ text:"..." } }` per the dispatcher envelope.

`yaco agent output-follow` is a third mode: a persistent NDJSON **stdout stream**
(not the single envelope), for provider reply streaming. -> See:
[providers.md](providers.md#provider-output--reply-streaming).

-> See: [src/commands/agent/start.ts](../../../cli/src/commands/agent/start.ts), [src/commands/agent/status.ts](../../../cli/src/commands/agent/status.ts), [src/commands/agent/capture.ts](../../../cli/src/commands/agent/capture.ts), [src/main.ts](../../../cli/src/main.ts) (`render` accepts `{help}` and `{text}` shapes).

### CLI ↔ App Boundary

The CLI owns all provider-native storage; `app/server` consumes structured CLI
surfaces instead of resolving or parsing `~/.claude`, `~/.codex`, or a future
provider home. This keeps each provider's private file/DB/log layout under
`cli/` so adding a provider is one CLI adapter, not edits across the server.

CLI surfaces consumed by `app/server` (all `--json` except the NDJSON stream):

| Surface | Shape | Server consumer |
|---|---|---|
| `yaco agent providers --json` | provider catalog `{id,label,executable}` | provider-start validation; drops the old closed `'claude'\|'codex'` union and `inferAgentProvider` heuristic |
| `yaco agent history --path <p> --json` | project-scoped `HistorySession[]`, live rows tagged by YACO `sessionId` | History tab |
| `yaco agent summaries --path <p> --json` | per-live-session `{handle,sessionId,provider,label}` | session-list labels (app-side cache; misses only) |
| `yaco agent output-cursor <h> --json` | opaque `{token,offset,sourceMtimeMs}` | pre-send reply cursor |
| `yaco agent output-follow <h> --cursor <t> --offset <b> --json` | persistent NDJSON `event`/`end` stream | channel reply streaming (one subprocess per turn) |

The app still reads **YACO-owned** state files directly (`${YACO_HOME}/sessions`,
`projects.json`) for fast session lists and file-watch signals — those are
YACO-owned snapshots, not provider storage. `AgentSession.provider` is a bare
`string` trusted from the YACO state file, validated against the catalog only on
start (`shell` bypasses the catalog).

**Capture vs. output-follow.** `capture` snapshots the rendered tmux pane
(provider-agnostic, point-in-time, lossy) for raw terminal fallback and idle
screen-scraping. `output-follow` reads provider-persisted logs and emits
turn-scoped reply events (`interim`/`question`/`final`); it is the primary
channel reply path when a provider declares `output`, with `capture` the
fallback when it does not. The CLI owns log location, byte reads, buffering,
offset advancement, and line classification; the app owns stream **timeout** and
the AskUserQuestion Escape side effect — the CLI never emits a `timeout` event.

**Browser presentation lives in app/ui, not the CLI.** `app/ui` owns a
provider-keyed presentation config (`app/ui/src/lib/providerUi.ts`,
`ProviderUiConfig`): icon, xterm contrast floor, OSC report suppression, and the
`canStart` startable-controls flag. It is a UI-local **superset** of the CLI
catalog — it also carries `shell` and a generic terminal fallback, neither a CLI
agent provider.

**OSC runtime vs. browser presentation split.** Terminal behavior is owned by
runtime: if it must happen with **no browser attached**, it is CLI provider-
runtime config (`TuiProvider.terminal` — launch env, detached-tmux OSC 10/11
color *responder*); if it only matters while **xterm renders to a human**, it is
app/ui config (`ProviderUiConfig.terminal` — xterm OSC *suppression*, contrast
floor). The same provider can require opposite actions in the two domains, so a
single shared OSC flag would be wrong.

-> See: [providers.md](providers.md#provider-adapter-model), [src/commands/agent/index.ts](../../../cli/src/commands/agent/index.ts), [src/lib/core/agent/providers/output.ts](../../../cli/src/lib/core/agent/providers/output.ts)

### Provider Isolation

- `env -u CLAUDECODE` prevents nested Claude conflicts
- `env COLORTERM=truecolor` nudges Codex toward truecolor rendering inside tmux
- Codex's provider adapter declares `terminal.respondToColorQuery`, so `start` attaches a `tmux pipe-pane` responder right after `tmux new-session` (gated by that flag, no fixed launch delay). The responder watches the real OSC 10/11 query bytes and sends the matching replies back with `tmux send-keys -H`; this preserves the composer background in detached sessions without blind timed injection or visible `^[]10;rgb...` echo. With no launch delay it attaches best-effort and may miss a query Codex emits before pipe-pane is live.
- `--dangerously-skip-permissions` (Claude) / `--yolo` (Codex) for autonomous operation
- Codex "Hooks need review" trust prompt — when the installed hook command's hash changes (e.g. after upgrading yaco's binary path), Codex re-prompts on session start. `start.ts#waitForReady` recognizes both screens (`Hooks need review` numbered menu, `Press t to trust all` overlay) and accepts trust automatically so unattended starts proceed.

### tmux Exact-Match Safety

All tmux `-t` targets use the `=` prefix for exact name lookup, preventing cross-session operations (without `=`, tmux treats `-t "foo"` as a prefix match that can resolve to `foo-2` or `foo-bar`). Two helpers in `src/lib/core/agent/tmux.ts` handle the tmux target-type distinction:

- **`sessionTarget(handle)`** = `"=${handle}"` — for commands that accept `target-session` (`has-session`, `kill-session`, `rename-session`, `list-panes`)
- **`paneTarget(handle)`** = `"=${handle}:"` — for commands that accept `target-pane` (`set-option`, `set`, `send-keys`, `capture-pane`). The trailing colon is required because tmux parses bare `"=name"` differently in pane-target context (it fails to resolve the session).

The shell wrapper (`agent-wrapper.sh`) only uses `has-session` and `display-message` with `"=$sn"` which are session-target commands. Enforced by source-scan tests in `test/tmux.test.ts` and `test/agent-wrapper.test.ts`.

-> See: [src/lib/core/agent/tmux.ts](../../../cli/src/lib/core/agent/tmux.ts)

### cgroup Escape (Linux + systemd hosts)

When the runtime is invoked from a process inside a nested systemd `.service` cgroup (e.g. spawned by a `workflow-server.service`), naïvely calling `tmux new-session` puts the spawned tmux server in the same cgroup. `systemctl restart` of the parent service then SIGTERMs the entire cgroup — including every agent session.

`cgroupEscapePrefix()` in `src/lib/core/agent/tmux.ts` detects this case (Linux + `systemd-run` available + leaf cgroup ends in `.service` and isn't `user@<uid>.service`) and prefixes `tmux new-session` with `systemd-run --user --scope --quiet --collect`. tmux ends up in a transient `.scope` outside the parent's control-group; the parent restart leaves it alone. Subsequent tmux clients connect to the same already-escaped server, so the wrap only needs to win once per tmux server lifetime.

Detection result is cached per process. macOS and non-systemd Linux return `""` and behave exactly as before — no wrapping, no overhead. launchd doesn't have cgroup-style group-kill semantics, so macOS doesn't need this.
