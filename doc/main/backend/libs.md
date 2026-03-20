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

### multmux.ts (117 lines)

Wraps the external `multmux` CLI to manage Claude/Codex agent sessions.

**Exports**: `getSessionsForProject()`, `querySessionsForProject()`, `getAllSessions()`, `sendToSession()`, `startMultmuxSession()`, `closeMultmuxSession()`

- Spawns `multmux` as a child process with timeout protection
- Parses session output to extract provider, status, and project
- Infers provider (claude/codex) from session name conventions

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

### session-poller.ts (165 lines)

Background polling service for session status detection.

**Exports**: `startSessionPoller()`, `stopSessionPoller()`, `getCachedMultmuxSessions()`, `hasCachedSessions()`

- Polls multmux every 3 seconds via `setTimeout` loop
- Detects `processing → idle` transitions and writes `session_idle` progress entries
- Skips idle detection for Claude sessions (uses Stop hook instead)
- Codex idle detection uses 15s minimum processing duration + 2x debounce
- Caches session list for use by the sessions route

### project-watcher.ts (76 lines)

Recursive filesystem watcher per project directory.

**Exports**: `startProjectWatchers()`, `stopProjectWatchers()`

- Uses `fs.watch` with `recursive: true` (macOS FSEvents, one fd per project)
- Routes filename changes to SSE refresh channels: `workstreams`, `git`, `filetree`
- Also watches `~/.workflow/projects.json` for project list changes
- 200ms debounce on all events to batch rapid changes

### terminal.ts (121 lines)

PTY management for terminal sessions.

**Exports**: `listShellSessions()`, `startShellSession()`, `closeShellSession()`, `attachSession()`

- Direct shell sessions: long-lived in-process PTYs named `shell-1`, `shell-2`, etc.
- Shell sessions keep a bounded scrollback buffer so re-attaching restores recent output
- Multmux sessions: attaches to tmux via `tmux attach-session` through node-pty
- `attachSession()` resolves session names and returns a PTY handle with initial data

### session-names.ts (27 lines)

Session name validation and tmux session resolution.

**Exports**: `SESSION_NAME_RE`, `validateSessionName()`, `resolveTmuxSession()`

- Validates names against `[a-zA-Z0-9_.-]+`
- Resolves short multmux names (e.g. `1-claude`) to full tmux names (e.g. `1-claude-workflow-mt`)
