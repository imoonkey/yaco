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
| POST | `/api/projects` | Register a project (`{ name, path }`) — validates path is absolute and directory exists |
| POST | `/api/projects/reorder` | Persist ordered project list (`{ order: string[] }`) |
| DELETE | `/api/projects/:name` | Unregister a project |

### Progress

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/progress` | All progress entries across projects, sorted newest-first |
| POST | `/api/progress/:project/:ws/:id/dismiss` | Dismiss a progress entry. `:ws` is the bundle directory name under `projects/active/<bundle>/`, or `_` for project-level entries at `projects/progress.json`. |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | All sessions (multmux + Workflow-managed shell). Optional `?project=<name>` filter. Agent sessions read `~/.multmux/sessions/*.json`; shell sessions read `~/.workflow/shell-sessions/*.json` and verify tmux liveness. Response includes `worktree` field for agent sessions (slug extracted from `sessionPath`) |
| GET | `/api/sessions/history` | Session history (Claude JSONL + Codex SQLite). Required `?project=<name>`. Returns `HistorySession[]` sorted by modified DESC, capped at 200, with live session tagging |
| POST | `/api/sessions/start` | Start session (`{ provider, name?, cwd, prompt?, resumeId? }`). Project resolved by longest-prefix match (supports worktree cwds). When `resumeId` present: idempotency preflight uses same descendant match, passes `--resume` to multmux. Returns resolved handle (not echoed name) |
| POST | `/api/sessions/:handle/pause` | Send `/stop` to session |
| POST | `/api/sessions/:handle/resume` | Resume with optional prompt |
| POST | `/api/sessions/:handle/close` | Close session (shell or multmux) |

### Files

All file routes support `?worktree=<slug>` query param — when present, `withProject` middleware redirects operations to `.worktrees/<slug>/` checkout.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files/:project` | Root-level file listing (lazy — dirs have `children: []`, gitignored entries marked) |
| GET | `/api/files/:project/search-index` | Flat list of all file paths for Cmd+P search. Uses `git ls-files --cached --others --exclude-standard` (fast, honors `.gitignore`); falls back to recursive walk for non-git projects (10k budget). Also recovers files inside **top-level** symlinked directories — nested symlinked dirs are not indexed (avoids full-tree walk on large monorepos). Symlink walker is loop-safe via per-recursion-path realpath ancestor tracking. |
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

All git routes support `?worktree=<slug>` query param via `withProject` middleware.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/git/:project/refs` | Branches, tags, recent commits (50) — returns `{ branches: string[], tags: string[], recentCommits: { hash, subject, date, author }[] }`. 5s in-memory cache per project. Log format: `%h\t%ci\t%an\t%s` |
| GET | `/api/git/:project/status` | Git status — returns `{ changes: [{ path, status }], stale: boolean }` |
| GET | `/api/git/:project/diff?path=...` | Unified diff for a file. Optional `&base=REF&compare=REF` for ref-to-ref diff; without them falls back through: `git diff HEAD` → `git diff --cached HEAD` (staged changes) → `--no-index /dev/null` (untracked) |
| GET | `/api/git/:project/compare?base=REF&compare=REF` | File list changed between two refs — returns `{ files: GitChange[] }`. Status letters: M/A/D (renames mapped to M). 400 if base/compare missing, 500 on git error |

### Notifications

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notifications/stream` | SSE stream — events: `notification`, `refresh` (30s heartbeat) |

### WebSocket

| Protocol | Path | Description |
|----------|------|-------------|
| WS | `/ws/terminal/:name?cols=N&rows=N&project=P` | Terminal PTY attached to tmux; `project` scopes session selection in the UI |

### Voice

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/voice/status` | Voice pipeline availability and config |
| POST | `/api/voice/compose` | Transcribe + format audio recording |

**`GET /api/voice/status`**

Returns pipeline readiness so the UI can gate recording controls.

Enabled (GROQ_API_KEY set):
```json
{ "enabled": true, "sttModel": "whisper-large-v3", "formatterModels": ["qwen/qwen3-32b", "moonshotai/kimi-k2-instruct-0905", "openai/gpt-oss-120b"], "maxUploadBytes": 20000000 }
```

Disabled (key missing):
```json
{ "enabled": false, "reason": "missing_api_key" }
```

**`POST /api/voice/compose`** (`multipart/form-data`)

Request fields:
- `audio` (file, required) — recorded audio blob (webm, mp4, ogg, etc.)
- `surface` (string, required) — `editor` or `terminal`
- `language` (string, optional) — ISO-639-1 hint for Whisper
- `filePath` (string, optional) — active editor file path

Pipeline: Whisper STT (with bilingual `initial_prompt` conditioning) → multi-model LLM formatter (shared speech-to-writing prompt + optional file-type context, tries models in order via `openai` SDK, strips thinking tokens) → response.

Success (`formattingStatus: "formatted"`):
```json
{ "rawText": "git status dash s b", "displayText": "git status -sb", "formattingStatus": "formatted" }
```

Formatter failure (`formattingStatus: "fallback_raw"`):
```json
{ "rawText": "...", "displayText": "...", "formattingStatus": "fallback_raw", "warning": "Formatting failed; showing raw transcript." }
```

Empty transcript (`formattingStatus: "empty"`, 200):
```json
{ "rawText": "", "displayText": "", "formattingStatus": "empty" }
```

**Error responses** — stable JSON `{ error, message }`:

| Condition | HTTP | `error` | `message` |
|-----------|------|---------|-----------|
| Missing GROQ_API_KEY | 503 | `service_unavailable` | Voice input is unavailable. Set GROQ_API_KEY. |
| Invalid/missing upload or surface | 400 | `invalid_request` | Invalid voice recording. |
| Audio > 20 MB | 413 | `payload_too_large` | Recording too large. Keep it short. |
| Upstream rate limit | 429 | `rate_limited` | Rate limit reached. Try again shortly. |
| Upstream timeout/network | 502 | `upstream_error` | Transcription failed. Try again. |

Audio is never persisted to disk. API key is never exposed to the browser.

-> Design doc: `projects/active/voice-formatting/final/design.md`

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks/:project` | Read tasks.json. Response enriched with `worktreeStatus` for each task that has a `worktree` field (resolved via `getWorktreeStatuses`) |
| PATCH | `/api/tasks/:project/:taskId` | Partial task update (runs `update-tasks.py set`) |
| PUT | `/api/tasks/:project/:taskId` | Create task (requires `title`, `description`, `acceptCriteria`) |
| DELETE | `/api/tasks/:project/:taskId` | Delete task |
| GET | `/api/tasks/:project/archive` | List archived tasks (reads `projects/archive/*.json`) |
| POST | `/api/tasks/:project/:taskId/archive` | Archive a task |
| POST | `/api/tasks/:project/bulk` | Bulk update (`{ ids, patch }`) |

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
| POST | `/api/whatsapp/login` | Idempotent init; first call spawns the puppeteer client (`LocalAuth` persists session to `~/.workflow/whatsapp-session/`, so subsequent boots skip QR). 400 when `WHATSAPP_ENABLED!=1`. |
| POST | `/api/whatsapp/logout` | Destroys the client + wipes the saved session dir + resets state. |
