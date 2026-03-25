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

### Workstreams

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/workstreams` | All workstreams across all projects |
| POST | `/api/workstreams/:project/:name/status` | Update workstream status (`{ status }`) |

### Progress

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/progress` | All progress entries across projects, sorted newest-first |
| POST | `/api/progress/:project/:ws/:id/dismiss` | Dismiss a notification (`_` for project-level entries) |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | All sessions (multmux + shell). Optional `?project=<name>` filter |
| POST | `/api/sessions/start` | Start session (`{ provider, name?, cwd, prompt? }`) |
| POST | `/api/sessions/:handle/pause` | Send `/stop` to session |
| POST | `/api/sessions/:handle/resume` | Resume with optional prompt |
| POST | `/api/sessions/:handle/close` | Close session (shell or multmux) |

### Files

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files/:project` | File tree (cached, max 10 levels deep, `.gitignore`-filtered — gitignored entries included with `gitignored: true` but dirs not recursed) |
| GET | `/api/files/:project/content?path=...` | Read file — returns `{ content, path, revision }` (max 1MB, path-validated) |
| PUT | `/api/files/:project/content?path=...` | Write file (`{ content, baseRevision? }`) — returns `{ ok, revision }` or 409 on conflict |
| POST | `/api/files/:project/create-file` | Create empty file (`{ path }`) — mkdir -p parents |
| POST | `/api/files/:project/create-dir` | Create directory (`{ path }`) |
| POST | `/api/files/:project/rename` | Rename file/folder (`{ oldPath, newPath }`) |
| POST | `/api/files/:project/move` | Move to directory (`{ sourcePath, destDir }`) |
| POST | `/api/files/:project/delete` | Delete file/folder recursively (`{ path }`) |

### Git

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/git/:project/status` | Git status — returns `{ changes: [{ path, status }], stale: boolean }` |
| GET | `/api/git/:project/diff?path=...` | Unified diff for a file (falls back to `--no-index` for untracked) |

### Notifications

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notifications/stream` | SSE stream — events: `notification`, `refresh` (30s heartbeat) |

### WebSocket

| Protocol | Path | Description |
|----------|------|-------------|
| WS | `/ws/terminal/:name?cols=N&rows=N` | Terminal PTY (tmux or direct shell) |

### Voice

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/voice/status` | Voice pipeline availability and config |
| POST | `/api/voice/compose` | Transcribe + format audio recording |

**`GET /api/voice/status`**

Returns pipeline readiness so the UI can gate recording controls.

Enabled (GROQ_API_KEY set):
```json
{ "enabled": true, "sttModel": "whisper-large-v3-turbo", "formatterModel": "llama-3.1-8b-instant", "maxUploadBytes": 20000000 }
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

Pipeline: Whisper STT → formatter LLM (surface-specific system prompt) → response.

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

-> Design doc: `doc/todo/voice/final/voice_input_aligned.md`

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Returns `{ ok: true }` |
