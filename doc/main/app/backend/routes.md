# API Routes

HTTP API endpoint reference. All routes are prefixed with `/api`.

## Owns

- Endpoint signatures, request/response shapes, and HTTP semantics
- Route-level validation and error handling

## Does Not Own

- Business logic implementation (see [libs.md](libs.md))
- Shared type definitions (see [../data-model/types.md](../data-model/types.md))

## Related Code

`server/src/routes/*.ts`

## Endpoints

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List registered projects |
| POST | `/api/projects` | Register a project (`{ name, path }`) — validates path is absolute and directory exists; starts a file-watcher so a runtime-registered project gets live tree/git SSE without a restart |
| POST | `/api/projects/reorder` | Persist ordered project list (`{ order: string[] }`) |
| DELETE | `/api/projects/:name` | Unregister a project (and stop its file-watcher) |

### Progress

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/progress` | All progress entries across projects, sorted newest-first |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | All sessions (yaco agent + Workflow-managed shell). Optional `?project=<name>` filter. Agent sessions read `${YACO_HOME:-~/.yaco}/sessions/*.json` (yaco agent state root); shell sessions read `${YACO_HOME:-~/.yaco}/shell-sessions/*.json` and verify tmux liveness. Response includes `worktree` field for agent sessions (slug extracted from `sessionPath`) |
| GET | `/api/sessions/history` | Session history (Claude JSONL + Codex SQLite). Required `?project=<name>`. Returns `HistorySession[]` sorted by modified DESC, capped at 200, with live session tagging |
| POST | `/api/sessions/start` | Start session (`{ provider, name?, cwd, prompt?, resumeId? }`, `provider` is a catalog id string or `shell`). Project resolved by longest-prefix match (supports worktree cwds). `shell` uses the shell-session path; any other provider is validated against the CLI provider catalog (`yaco agent providers --json`) inside `startAgentSession` and rejected if unknown. When `resumeId` present: idempotency preflight uses same descendant match, passes `--resume` through to `yaco agent start`. Returns resolved handle (not echoed name) |
| POST | `/api/sessions/:handle/pause` | Send `/stop` to session |
| POST | `/api/sessions/:handle/resume` | Resume with optional prompt |
| POST | `/api/sessions/:handle/close` | Close session (shell or agent — `yaco agent kill <handle>` for the latter) |

### Files

All file routes support `?worktree=<slug>` query param — when present, `withProject` middleware redirects operations to `.worktrees/<slug>/` checkout.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files/:project` | Root-level file listing (lazy — dirs have `children: []`, gitignored entries marked) |
| GET | `/api/files/:project/search-index` | Flat list of all file paths for Cmd+P search. Uses `git ls-files --cached --others --exclude-standard` (fast, honors `.gitignore`); falls back to recursive walk for non-git projects (10k budget). Also recovers files inside **top-level** symlinked directories — nested symlinked dirs are not indexed (avoids full-tree walk on large monorepos). Symlink walker is loop-safe via per-recursion-path realpath ancestor tracking. **Colocated-repo aware:** also runs `git ls-files` per detected colocated repo (`cwd=<repo>`) and merges with a `<repo>/` prefix (host first, then repos sorted by prefix), one shared `seen` set — so a plan repo kept out of host git via `info/exclude` is still searchable, while the repo's own `.gitignore` still hides its logs/locks. -> See: [colocated repos](#colocated-repos) |
| GET | `/api/files/:project/children?dir=...` | One directory's immediate children (lazy expand on demand) |
| GET | `/api/files/:project/content?path=...` | Read file — returns `{ content, path, revision }` (max 1MB, path-validated) |
| GET | `/api/files/:project/raw?path=...` | Serve raw binary file — returns file with proper `Content-Type` (images, PDFs). Max 20MB. MIME map: `.png/.jpg/.jpeg/.gif/.svg/.webp/.ico/.bmp` (image types) + `.pdf`. Falls back to `application/octet-stream`. |
| PUT | `/api/files/:project/content?path=...` | Write file (`{ content, baseRevision? }`) — returns `{ ok, revision }` or 409 on conflict |
| POST | `/api/files/:project/create-file` | Create empty file (`{ path }`) — mkdir -p parents |
| POST | `/api/files/:project/create-dir` | Create directory (`{ path }`) |
| POST | `/api/files/:project/rename` | Rename file/folder (`{ oldPath, newPath }`) |
| POST | `/api/files/:project/move` | Move to directory (`{ sourcePath, destDir }`) |
| POST | `/api/files/:project/delete` | Delete file/folder recursively (`{ path }`) |
| POST | `/api/files/:project/reveal` | Reveal file in OS file manager (`{ path }`) — `open -R` on macOS, `xdg-open` on Linux |

### Git

All git routes support `?worktree=<slug>` query param via `withProject` middleware. `/status`, `/diff`, and `/baseline` are **colocated-repo aware** (-> See: [colocated repos](#colocated-repos)); the `/compare` ref-diff stays host-rooted.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/git/:project/refs` | Branches, tags, recent commits (50) — returns `{ branches: string[], tags: string[], recentCommits: { hash, subject, date, author }[] }`. 5s in-memory cache per project. Log format: `%h\t%ci\t%an\t%s` |
| GET | `/api/git/:project/status` | Git status — returns `{ changes: [{ path, status }], stale: boolean, stats? }`. Aggregates the host **plus every colocated repo** (`git status` + `git diff --shortstat` per repo), prefixing a colocated repo's paths with `<repo>/`; deterministic order (host first, repos sorted by prefix), one shared `seen` set. Snapshots key by `<effectivePath>\0<repoPrefix>` (so a worktree never inherits the primary's colocated changes). Partial failure: `stale:true` if any repo's git fails (that repo falls back to its last snapshot); `stats` is summed across repos and omitted while stale |
| GET | `/api/git/:project/diff?path=...` | Unified diff for a file. Optional `&base=REF&compare=REF` for ref-to-ref diff (host-rooted); without them falls back through: `git diff HEAD` → `git diff --cached HEAD` (staged) → `--no-index /dev/null` (untracked), run in the file's **owning repo** via `resolveFileRepo(..., "deny")` — a colocated logical path (`plan/foo.md`, path-boundary so `plan2/x` ≠ `plan`) diffs against that repo's HEAD (works for deleted files); a host symlink is never followed outside the project (git never runs in an external location) |
| GET | `/api/git/:project/baseline?path=...` | File's HEAD content for editor-buffer diffing (gutter) — returns `{ content, exists }`. Via `resolveFileRepo(..., "preserve")`: an existing file follows its symlink target's HEAD blob (so the gutter diffs real content, not the link text); a deleted colocated file resolves to its own repo's HEAD; `exists:false` when untracked or the target is outside any repo |
| GET | `/api/git/:project/compare?base=REF&compare=REF` | File list changed between two refs — returns `{ files: GitChange[] }`. Status letters: M/A/D (renames mapped to M). 400 if base/compare missing, 500 on git error. Host-rooted (cross-ref colocated diff is out of scope) |

#### Colocated repos

A **colocated repo** is a depth-1 child directory that is its own git repo but is deliberately kept out of the host repo (the motivating case: `plan/`, excluded via `.git/info/exclude`). `lib/colocatedRepos.ts` `getColocatedRepos(projectPath)` detects them by a general signal — a depth-1 child whose `.git` exists (dir or worktree file), that is **not in the host index** (one `git ls-files -z` read) and **not matched by the root working-tree `.gitignore`** (the same source the tree's dimming uses, so detection and dimming never disagree). A `colocatedRepos` policy from `yaco.toml` `[colocated] repos` narrows it: `"auto"` (default, all qualifying), `"off"`, or a comma-separated allow-list (re-validated by the same signal). Result is cached by `realpath(projectPath)` for a short TTL (no watchers). The read-only git surfaces above mirror across the host + each detected repo so a colocated repo shows up first-class (searchable, changes/diffs, undimmed tree) without ever entering host git. -> See: [lib/colocatedRepos.ts](libs.md), [yaco plan init](../../cli/plan.md)

### Attention & SSE

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notifications/stream` | SSE transport — events: `attention` (projected `AttentionSnapshot`), `refresh`, `ui-state:changed` (30s heartbeat). No per-item notification event |
| GET | `/api/attention/feed?limit=&before=` | Live attention snapshot + bounded/paginated Recent history. `limit` default 50, max 200; `before` is the opaque composite cursor; response carries `nextBefore` |
| POST | `/api/attention/ack` | `{ scope: 'project'\|'session'\|'task', project, key? }` — server-stamped, monotonic-max ack (rejects/clamps a future or lower value). 204 |
| POST | `/api/attention/clear` | `{ project }` — set the project's monotonic `recentClearedAt`. 204 |

### WebSocket

| Protocol | Path | Description |
|----------|------|-------------|
| WS | `/ws/terminal/:name?cols=N&rows=N&fg=%23rrggbb&bg=%23rrggbb&cursor=%23rrggbb&project=P` | Terminal PTY attached to tmux; palette params let app/server answer Codex OSC color probes at the PTY bridge; `project` scopes session selection in the UI |

### Voice

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/voice/status` | Voice pipeline availability and config |
| POST | `/api/voice/transcribe` | Transcribe one recording (Whisper only) |
| POST | `/api/voice/format` | Format a whole transcript (formatter only) |

**`GET /api/voice/status`**

Returns pipeline readiness so the UI can gate recording controls.

Enabled (GROQ_API_KEY set):
```json
{ "enabled": true, "sttModel": "whisper-large-v3", "formatterModels": ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "qwen/qwen3-32b", "llama-3.1-8b-instant"], "maxUploadBytes": 20000000 }
```

Disabled (key missing):
```json
{ "enabled": false, "reason": "missing_api_key" }
```

The pipeline is **split** into two single-responsibility endpoints. The client
records one continuous take (native `MediaRecorder`, ended by the user via
Stop/F5 — no mid-recording chunking, no VAD), uploads it **once** to
`/transcribe`, then calls `/format` once over that transcript. The formatter
runs exactly once per take.

**`POST /api/voice/transcribe`** (`multipart/form-data`) — Whisper STT only.

Request fields:
- `audio` (file, required) — one whole-take recording (typically `audio/webm;codecs=opus`, or `audio/mp4` on Safari). MIME-allowlisted (`audio/wav`, `webm`, `ogg`, `mpeg`, `mp4`, `m4a`, `flac`); when the part is typeless / `application/octet-stream`, the file extension is used instead.
- `language` (string, optional) — ISO-639-1 hint for Whisper
- `context` (string, optional) — tiny vocabulary-bias snippet; `buildWhisperPrompt` keeps only a capped tail (Groq 224-token `initial_prompt` limit)

Response (silence yields `{ "text": "" }`):
```json
{ "text": "git status dash s b" }
```

**`POST /api/voice/format`** (`application/json`) — multi-model LLM formatter only.

Request body `{ text, surface, filePath? }`:
- `text` (string, required) — joined raw transcript; capped at `VOICE_MAX_TRANSCRIPT_CHARS` (8000) → 413 before any model call
- `surface` (string, required) — `editor` or `terminal`
- `filePath` (string, optional) — active editor file. Validated as an **opaque repo-relative path** (`normalizeSafeFilePath`): rejects absolute paths, `..` traversal, URL/drive prefixes, control chars, and anything outside `[A-Za-z0-9._@+/-]` (so it can't inject prompt text); blank → dropped.

Formatter pipeline: shared speech-to-writing prompt + optional file-type context, tries models in order via `openai` SDK, strips thinking tokens.

Success (`formattingStatus: "formatted"`):
```json
{ "displayText": "git status -sb", "formattingStatus": "formatted" }
```

Formatter failure (`formattingStatus: "fallback_raw"`):
```json
{ "displayText": "...", "formattingStatus": "fallback_raw", "warning": "Formatting failed; showing raw transcript." }
```

Empty/blank transcript (`formattingStatus: "empty"`, 200, no model call):
```json
{ "displayText": "", "formattingStatus": "empty" }
```

**Error responses** — stable JSON `{ "error": "<message>" }`:

| Condition | HTTP | `error` message | Route |
|-----------|------|-----------------|-------|
| Missing GROQ_API_KEY | 503 | Voice input is unavailable. Set GROQ_API_KEY. | both |
| Invalid form / missing audio / non-string `language`\|`context` | 400 | Invalid voice recording. | transcribe |
| Unsupported audio format | 400 | Unsupported audio format. | transcribe |
| Audio > 20 MB | 413 | Recording too large. Keep it short. | transcribe |
| Invalid JSON / `surface` / `filePath` | 400 | Invalid request. | format |
| Transcript > `VOICE_MAX_TRANSCRIPT_CHARS` | 413 | Transcript too long. | format |
| Upstream rate limit | 429 | Rate limit reached. Try again shortly. | transcribe |
| Upstream timeout/network | 502 | Transcription failed. Try again. | transcribe |

On a 429, `/transcribe` forwards the upstream Groq `retry-after` header so the
client backs off precisely — `useVoice.ts` parses it (seconds or HTTP date),
waits, and retries the upload once.

Audio is never persisted to disk. API key is never exposed to the browser.

-> History: `plan/archive/20260605_voice-streaming/` (the original streaming
design; the mid-recording chunking it describes was reverted to this single-take
flow).

### Tasks

All task routes spawn `yaco task <sub> --json` (canonical CLI surface) and parse the `{ok,data}/{ok,error}` envelope. CliError codes map to HTTP statuses: `USAGE`/`INVALID` → 400 (with `details` preserved), `NOT_FOUND` → 404, `CONFLICT`/`LOCK` → 409, others → 500. The server execFile timeout is `DEFAULT_TASK_LOCK_TIMEOUT_MS + 5_000` (imported from `@yaco/cli/core/task`) so a held lock surfaces as a structured 409 envelope instead of an opaque 500 timeout. GET uses `yaco task list --workset all --json`; path resolution and `yaco.toml [paths].tasks` handling stay owned by the CLI.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks/:project` | `yaco task list --workset all --json`. Returns **all worksets** (active, backlog, archive) — the workspace filters client-side. Response enriched with `worktreeStatus` for each task that has a `worktree` field (resolved via `getWorktreeStatuses`) |
| PATCH | `/api/tasks/:project/:taskId` | Partial task update (`yaco task set <id> --data <json> --json`); returns the updated task body |
| PUT | `/api/tasks/:project/:taskId` | Create task — requires `title`, `description`, `acceptCriteria`. Same `yaco task set` envelope as PATCH |
| DELETE | `/api/tasks/:project/:taskId` | `yaco task rm <id> --json`; returns `{deleted: true}` |
| POST | `/api/tasks/:project/:taskId/archive` | `yaco task archive <id> --json`; returns `{archived: true}` |
| POST | `/api/tasks/:project/bulk` | Bulk update (`{ ids, patch }`) — sequential `yaco task set` per id; first failure short-circuits |

### Search

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/search/:project/text` | Cross-file text search via ripgrep — streams NDJSON |

**Query params:**
- `q` (required) — search pattern
- `regex` — treat as regex (default: false)
- `caseSensitive` — override smart-case (default: unset, smart-case applies)
- `wholeWord` — word boundary matching (default: false)
- `glob` — file glob filter (e.g., `*.ts`)
- `context` — context lines, 0–5 (default: 1)

**NDJSON message types:**
```
{"type":"match","file":"src/foo.ts","line":42,"column":8,"matchLength":5,"text":"..."}
{"type":"context","file":"src/foo.ts","line":41,"text":"..."}
{"type":"done","matchCount":127,"fileCount":23,"durationMs":45,"capped":false}
{"type":"error","message":"..."}
```

Hard-cap: 5000 matches (kills `rg` when reached, `capped: true` in done message). Hard-ignored: `.git`, `node_modules`, `dist`, `build`. Requires `rg` on PATH (returns 503 if missing).

### Inline Suggestions (Autocomplete)

Backs the markdown-only inline-suggestion editor feature. Non-project-aware in v1 (active-draft context only — no disk reads), so these routes are mounted under the bare `/api/autocomplete` prefix without `withProject`. Files/route/env are **not** renamed in v1 (the legacy `autocomplete` names are kept).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/autocomplete/status` | Feature availability — returns `{ enabled, model }`. `enabled` is false when `GROQ_API_KEY` is unset; the client gates requests on it (60s backoff). |
| POST | `/api/autocomplete/complete` | Markdown continuation. Body `{ prefix, suffix, filePath? }` → returns `{ prediction }` (single-line insert string, possibly empty). |

**`POST /api/autocomplete/complete`**

- `prefix` / `suffix` (string, required) — text before/after the cursor from the active editor draft.
- `filePath` (string, optional) — repo-relative path, validated by `normalizeSafeFilePath` (rejects absolute paths, `..`, URL/drive prefixes, control chars, and injection chars `< > \` " …`; blank → dropped). Used only as a prompt hint and to gate markdown/secret eligibility.

Guards: body capped at 32 KB (413), JSON-validated (400), `prefix`/`suffix` must be strings (400), invalid `filePath` (400). The server returns an **empty** prediction (no model call) for non-markdown paths, likely-secret paths, and a cursor inside a fenced code block. A client `AbortError` returns `{ prediction: "" }`.

**Error responses** — `{ "error": "<message>" }`:

| Condition | HTTP | `error` message |
|-----------|------|-----------------|
| Missing `GROQ_API_KEY` | 503 | Autocomplete is unavailable. Set GROQ_API_KEY. |
| Body > 32 KB | 413 | Request body too large. |
| Invalid JSON | 400 | Invalid JSON. |
| `prefix`/`suffix` not strings | 400 | prefix and suffix must be strings. |
| Invalid `filePath` | 400 | filePath must be a safe relative path. |
| Upstream rate limit | 429 | Rate limit reached. Try again shortly. |
| Upstream failure | 502 | Completion failed. Try again. |

Config: `GROQ_API_KEY` + optional `AUTOCOMPLETE_MODELS` (comma-separated) / `AUTOCOMPLETE_MODEL` in `server/.env`. Business logic: [libs.md § autocomplete.ts](libs.md). Behavior spec: [../ui/workspace/editor-and-preview.md](../ui/workspace/editor-and-preview.md#inline-suggestions).

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Returns `{ ok: true }` |

### WeChat

Env-gated by `WECHAT_ENABLED=1` and `WECHAT_CONVERSATION_WHITELIST` (optional, comma-separated). When unset, behavior is unchanged.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/wechat/status` | Returns `{ enabled, initialized, loggedIn, auth: { mode, whitelist, tofuBound }, login: { phase, qrAscii?, accountId?, error? } }`. Phase ∈ `idle`, `awaiting-qr`, `awaiting-scan`, `logged-in`, `failed`. |
| POST | `/api/wechat/login` | Starts SDK QR-code login in the background (idempotent — concurrent calls reuse the in-flight flow). Returns the current `LoginState`. 400 when `WECHAT_ENABLED!=1`. |
| POST | `/api/wechat/login/reset` | Resets the login state to `idle` (no-op if a login is in flight). |
| POST | `/api/wechat/logout` | Shuts the bot down + calls SDK logout(). 409 if a login flow is active. |

### WhatsApp

Env-gated by `WHATSAPP_ENABLED=1`. Optional: `WHATSAPP_CHAT_JID` (lock to a single chat, overrides TOFU) and `WHATSAPP_CONVERSATION_WHITELIST` (comma-separated alternative).

The bot uses the user's own WhatsApp account via puppeteer-driven WhatsApp Web (no separate bot identity exists in WhatsApp). To prevent auto-replying to all the user's contacts, the listener filters `message_create` events down to **self-chat only** — TOFU binds the first chat the user types in (typically "Message yourself"); other chats are silently dropped.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/whatsapp/status` | Returns `{ enabled, initialized, loggedIn, auth, login: { phase, qrAscii?, error?, boundChat?, ready, … } }`. Phase ∈ `idle`, `awaiting-qr`, `authenticating`, `ready`, `failed`, `disconnected`. |
| POST | `/api/whatsapp/login` | Idempotent init; first call spawns the puppeteer client (`LocalAuth` persists session to `${YACO_HOME:-~/.yaco}/channels/whatsapp/session/`, so subsequent boots skip QR). 400 when `WHATSAPP_ENABLED!=1`. |
| POST | `/api/whatsapp/logout` | Destroys the client + wipes the saved session dir + resets state. |
