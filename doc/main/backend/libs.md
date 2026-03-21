# Library Modules

Server-side library modules providing business logic, background services, and system integrations.

## Owns

- Internal implementation of scanning, watching, session management, terminal handling, and notifications

## Does Not Own

- HTTP route handlers (see [routes.md](routes.md))
- API contract shapes (see [../data-model/api-contracts.md](../data-model/api-contracts.md))

## Related Code

`server/src/lib/*.ts`

## Module Reference

### projects.ts (34 lines)

Project registry management. Reads/writes `~/.workflow/projects.json`.

**Exports**: `ensureWorkflowDir()`, `loadProjects()`, `saveProjects()`

### scanner.ts (179 lines)

Core scanning engine for workstream metadata and progress entries across project directories.

**Exports**: `scanWorkstreams()`, `scanProgress()`, `updateWorkstreamStatus()`, `dismissProgress()`, `withFileLock()`

- Reads `doc/todo/*/workstream.json` and `doc/todo/*/progress.json` per project
- `withFileLock()` provides in-process locking for read-modify-write operations on JSON files
- Handles both workstream-level and project-level (`doc/todo/progress.json`) progress entries

### multmux.ts (138 lines)

Reads multmux session state from `.multmux/<handle>.json` state files and wraps the `multmux` CLI for session commands.

**Exports**: `readSessionsFromStateFiles()`, `readAllSessionsFromStateFiles()`, `inferMultmuxProvider()`, `sendToSession()`, `startMultmuxSession()`, `closeMultmuxSession()`

- Primary session source: reads `.multmux/*.json` state files (written by multmux hooks)
- Normalizes status: `starting → idle`, `stopped → excluded`, `processing → processing`
- Exports `MultmuxSession` and `MultmuxStateFile` interfaces
- Spawns `multmux` as a child process with timeout protection for commands (start, send, close)

### watcher.ts (136 lines)

Watches `progress.json` files for new entries and triggers notifications.

**Exports**: `startWatching()`, `stopWatching()`

- Uses `fs.watch` on each project's `doc/todo/` directory tree
- Detects new progress entries by comparing entry counts
- Emits `notification` events and `progress` refresh signals via notify.ts

### notify.ts (56 lines)

Notification dispatch to two sinks: macOS desktop and SSE broadcast.

**Exports**: `emitNotification()`, `emitRefresh()`, `addSSEClient()`, `removeSSEClient()`

- `emitNotification()` — sends to osascript + all SSE clients (with sink isolation on errors)
- `emitRefresh(channel)` — lightweight SSE-only signal for UI refresh (no osascript)
- Manages SSE client registry for connected browsers

### session-reconciler.ts (204 lines)

Low-frequency background reconciler for session health and idle detection.

**Exports**: `startSessionReconciler()`, `stopSessionReconciler()`

- Runs every 60 seconds as a safety net (not primary session source)
- Reads `.multmux/*.json` state files and compares against previous snapshot
- Emits `refresh:sessions` if drift detected (missed watcher events)
- Health-checks all active sessions via `tmux has-session`; writes `stopped` to stale state files
- Codex idle detection: 15s minimum processing duration + 2× debounce, writes `session_idle` entries
- Claude sessions skip idle detection (use Stop hook instead)

### project-watcher.ts (76 lines)

Recursive filesystem watcher per project directory.

**Exports**: `startProjectWatchers()`, `stopProjectWatchers()`

- Uses `fs.watch` with `recursive: true` (macOS FSEvents, one fd per project)
- Routes filename changes to SSE refresh channels: `sessions`, `workstreams`, `git`, `filetree`
- `.multmux/*.json` changes → `sessions` channel (event-driven session updates)
- Also watches `~/.workflow/projects.json` for project list changes
- 200ms debounce on all events to batch rapid changes

### terminal.ts (121 lines)

PTY management for terminal sessions.

**Exports**: `listShellSessions()`, `startShellSession()`, `closeShellSession()`, `attachSession()`, `setShellSessionChangeCallback()`

- Direct shell sessions: long-lived in-process PTYs named `shell-1`, `shell-2`, etc.
- Shell sessions keep a bounded scrollback buffer so re-attaching restores recent output
- Lifecycle callback: fires on start, close, and process exit for `refresh:sessions` integration
- Multmux sessions: attaches to tmux via `tmux attach-session` through node-pty
- `attachSession()` resolves session names and returns a PTY handle with initial data

### session-names.ts (27 lines)

Session name validation and tmux session resolution.

**Exports**: `SESSION_NAME_RE`, `validateSessionName()`, `resolveTmuxSession()`

- Validates names against `[a-zA-Z0-9_.-]+`
- Resolves short multmux names (e.g. `1-claude`) to full tmux names (e.g. `1-claude-workflow-mt`)
