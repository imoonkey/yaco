# Progress

## 2026-06-05: app/server summaries + history via CLI surfaces

**What changed:**
- `session-summary.ts` no longer resolves `~/.claude` JSONL or `~/.codex` SQLite/rollout files. `resolveSessionSummaries()` now serves from an in-process cache keyed by `(provider, sessionId, sessionPath)` and, for misses grouped by project path, calls `yaco agent summaries --path <p> --json` once per path. Only positive labels are cached; a `processing` → `idle` transition drops a cached label so a turn that changed it re-resolves. New `invalidateSummaryCache()` is wired into the sessions route's `invalidateSessionsCache()` (rename/close/start/manual refresh). `encodeProjectPath()` is retained as a pure helper for the not-yet-migrated `channels/agent-output.ts`.
- `history.ts` shrank from ~300 lines of Claude/Codex parsing to a thin mapper: `getHistory()` calls `yaco agent history --path <p> --json`, maps the CLI row shape (`sessionId`/`updatedAt`) to the UI shape (`id`/`modified`), and re-tags `liveSessionName` by matching CLI `sessionId` against the live YACO session list. `HistorySession.provider` widened from `'claude' | 'codex'` to `string`. `getClaudeHistory`/`getCodexHistory` and `getCodexDb` are gone.
- `agent.ts` gained the thin CLI transports `fetchHistory()` (`CliHistorySession[]`) and `fetchSessionSummaries()` (`CliSessionSummary[]`), mirroring `fetchProviderCatalog()`.
- Tests rewritten to mock the `../agent` CLI transports instead of planting `~/.claude`/`~/.codex` fixtures.

**Why:**
- `app-summary-history-boundary` task of the `tui-provider-adapters` design (`plan/active/tui-provider-adapters/design_codex.md`): app/server must stop resolving and parsing provider homes so each provider's private file/DB layout lives only under `cli/`. The app-side summary cache keeps the migration from spawning a subprocess on every `GET /api/sessions` poll while the boundary is observable before any persistent-helper optimization.

**Key files:** `app/server/src/lib/{agent.ts,session-summary.ts,history.ts}`, `app/server/src/routes/sessions.ts`, `app/server/src/lib/__tests__/{session-summary,history}.test.ts`; docs `doc/main/app/backend/libs.md`, `doc/main/app/ui/workspace/sessions-and-terminal.md`
**Verification:** `cd app/server && npm test -- session-summary.test.ts history.test.ts` → 20 pass (2 files); `tsc --noEmit` adds zero errors over the pre-existing baseline; consumes CLI summary/history surfaces from commit 4575fd7.
**Commit:** this commit.
**Next:** `app-output-boundary` migrates `channels/agent-output.ts` off provider-home log reads (then `encodeProjectPath` becomes removable).
**Blockers:** None.

## 2026-06-05: CLI provider output cursor + output-follow stream

**What changed:**
- Added the `output` capability to the provider contract and registered it for Claude and Codex. `ProviderOutput` (`cli/src/lib/core/agent/providers/types.ts`) now exposes `resolveCursor(session)` and `classifyLine(line)`; `classifyLine` returns **`AgentOutputEvent | null`** (at most one event per complete log line — the contract changed from an array to enforce safe `nextOffset` resume).
- New `cli/src/lib/core/agent/providers/output.ts`: `claudeOutput()`/`codexOutput()` adapters (cursor resolution + line classification, ported from the app's parsing), an **opaque cursor token** codec (`oc1_<base64url>` of `{provider,sessionId,path}`), and the provider-agnostic `followOutput()` tailer (`stat` + byte-range reads + byte-space partial-line buffering + offset advancement; terminates on `final`, a defensive max-lifetime cap, caller abort, or read error).
- New CLI surfaces wired in `cli/src/commands/agent/index.ts` via `cli/src/commands/agent/output.ts`: `yaco agent output-cursor <name>` → `{token,offset,sourceMtimeMs}`, and `yaco agent output-follow <name> [--cursor <token>] [--offset <bytes>]` → a persistent NDJSON **stdout stream** of `event`/`end` frames (not the single envelope; the process self-exits). One provider turn = one subprocess that polls internally.
- Strict, security-hardened input handling: a dedicated allowlist parser (`parseOutputFollowArgs`) accepts only the handle + `--cursor`/`--cursor=`, `--offset`/`--offset=`, `--json`. `--offset` (split/equal) is validated to a non-negative integer; `--cursor` values must be present/non-empty/non-flag-like → all reject as `USAGE` before any frame. A well-formed token bound to a different session/provider, or a raw path, is rejected as `INVALID` (the follower always re-resolves the read path from the session's provider and never trusts caller input). `--help`/`-h` is honored only as a standalone request.

**Why:**
- `provider-output-follow-cli` task of the `tui-provider-adapters` design (`plan/active/tui-provider-adapters/design_codex.md`): channel reply streaming must move behind a CLI surface so provider-home log reads stay under `cli/`, while avoiding a per-poll subprocess spawn storm. The opaque cursor + provider re-resolution keeps app/server from parsing provider paths and closes a path-injection vector; the one-event-per-line contract keeps `nextOffset` resume lossless. The app still owns stream timeout and the AskUserQuestion Escape side effect — the CLI never emits a `timeout` provider event.

**Key files:** `cli/src/lib/core/agent/providers/{output.ts,types.ts,claude.ts,codex.ts}`, `cli/src/commands/agent/{output.ts,index.ts}`, `cli/test/unit/agent-output.test.ts`; docs `doc/main/cli/providers.md`, `doc/main/cli/architecture.md`
**Verification:** `cd cli && bun test test/unit/agent-output.test.ts` → 54 pass; `cd cli && bun run test:unit` → 602 pass / 0 fail (44 files); `tsc --noEmit` clean for all touched files; temp-built `yaco` binary confirmed help envelopes, NDJSON streaming with `nextOffset`, and split/equal-form `--offset`/`--cursor`/unknown-flag/standalone-help validation.
**Commit:** this commit.
**Next:** `app-output-boundary` — app/server consumes `output-cursor` + persistent `output-follow` and drops its own provider log parsing (`channels/agent-output.ts`), keeping app-side timeout + AskUserQuestion side effect.
**Blockers:** None.

## 2026-06-05: app/server provider type boundary — validate against CLI catalog

**What changed:**
- `AgentSession.provider` / `AgentSessionState.provider` widen from `'claude' | 'codex'` to `string`; the YACO-owned `provider` field is trusted verbatim and a state file with no provider string is skipped. Removed `inferAgentProvider` (the handle-name heuristic) entirely.
- Added `fetchProviderCatalog()` (`yaco agent providers --json` → `ProviderCatalogEntry[]`) and a private `assertKnownAgentProvider()`; `startAgentSession(provider: string, …)` validates the provider against the catalog before spawning and throws `unknown agent provider: <id> (known: …)` on a miss. `POST /api/sessions/start` widened its body `provider` to `string`; `shell` still routes to the shell-session path before any catalog check.
- Made the remaining claude/codex-only call sites safe for arbitrary provider strings instead of treating every non-codex provider as Claude/Codex: channel `/new <provider>` drops its hard-coded union and delegates validation to `startAgentSession`; `channels/agent-output.ts` `resolveSessionLog`/`startTurn` return `null` for non-claude/codex providers (terminal-capture fallback); `session-summary.ts` resolves only `claude`/`codex` and skips other providers (no Claude-storage probe).

**Why:**
- `tui-app-provider-type-boundary` task of the `tui-provider-adapters` design (`plan/active/tui-provider-adapters/design_codex.md`): the CLI provider registry is the authoritative boundary, so app/server should trust YACO state provider strings and validate starts against the catalog rather than carrying a closed union and name heuristics. Provider-native summary/history/output reads stay behind the later `app-summary-history-boundary` / `app-output-boundary` tasks — this change only removes the unsafe Claude/Codex fallbacks in the meantime.

**Key files:** `app/server/src/lib/agent.ts`, `app/server/src/routes/sessions.ts`, `app/server/src/lib/channels/{router,agent-output}.ts`, `app/server/src/lib/session-summary.ts` (+ scoped tests); docs `doc/main/app/backend/{libs,routes}.md`, `doc/main/app/data-model/types.md`
**Verification:** `cd app/server && npm test` → full vitest 425/425 (one pre-existing real-tmux flake in `wechat-pty-tap` passes in isolation). Targeted: `agent`/`agent-output`/`wechat-router`/`sessions-worktree`/`session-summary` → 63 pass. `tsc --noEmit` clean for all touched production files.
**Commit:** this commit.
**Next:** `app-summary-history-boundary` and `app-output-boundary` move provider-native reads behind CLI surfaces; `ui-provider-config` carries the provider-keyed UI map.
**Blockers:** None.

## 2026-06-05: install/doctor iterate the provider registry

**What changed:**
- `yaco install` hook merge now iterates `listProviders()` and calls each adapter's `hooks.install()` (Claude → `ensureClaudeHooks`, Codex → `ensureCodexHooks`), keying the action list / `--dry-run` plan off `hooks.configPath()` instead of two hard-coded `ensureClaudeHooks()` / `ensureCodexHooks()` calls. The wrapper is still written once up front, so `install` is called directly (NOT `ensureHooks`).
- `yaco doctor` keeps its twelve fixed check names and `{checks,summary}` JSON shape, but the `providers` and `agent-hook-config` details are now registry-driven: `providers` probes each adapter's `executable` via `which`; `agent-hook-config` probes each hook-bearing adapter's `hasInstalledHook()`. Removed the inline `fileContainsYacoHook` walker. Fail strings changed to provider-neutral text (`no provider executable on $PATH (<ids>)`, `no yaco-agent-hook entries in provider configs`); pass-path detail format is byte-identical for the claude+codex pair.
- `yaco agent hooks install` iterates registered providers with hooks and reports `installed` from the registry instead of the literal `["claude","codex"]`.

**Why:**
- The `tui-provider-adapters` design (`plan/active/tui-provider-adapters/design_codex.md`, `provider-install-doctor` task) wants adding a TUI provider to be one adapter, not edits across install + doctor. No per-provider doctor check names are introduced — adding a provider widens the detail string, not the check list, preserving the stable doctor contract.

**Key files:** `cli/src/commands/{install,doctor}.ts`, `cli/src/commands/agent/hooks/install.ts`, `doc/main/cli/{install,doctor}.md`
**Verification:** `cd cli && bun test test/hooks-install.test.ts test/unit/main.test.ts` → 24 pass / 0 fail (acceptance). `bun test test/unit/commands/{doctor,install}.test.ts` → 40 pass / 0 fail. `bun run test:unit` → 552 pass / 0 fail; `test/integration/install.test.ts` → 3 pass. `tsc --noEmit` clean for the scoped files.
**Commit:** this commit.
**Next:** sibling adapter tasks (`provider-output-follow-cli`, `provider-project-move`, app-side boundary tasks) and the `docs-provider-boundary` pass that retires flat `providers.ts` references.
**Blockers:** None.

## 2026-06-05: CLI summary/history/providers JSON surfaces

**What changed:**
- Added three `yaco agent` JSON subcommands so app/server can read provider-reconstructed data without opening `~/.claude` or `~/.codex` itself: `history --path <project> [--json]` (project-scoped, list-valued; live rows tagged by YACO `sessionId`), `summaries --path <project> [--json]` (one `{handle, sessionId, provider, label}` record per live session under the path), and `providers [--json]` (registry catalog `{id, label, executable}` for provider-start validation).
- Moved Claude/Codex history + summary reconstruction into the provider adapters: new `cli/src/lib/core/agent/providers/history.ts` co-locates Claude JSONL parsing (head/tail reads, slash-command-to-args normalization, custom-title/timestamp extraction, `sessions-index.json` enrichment) and Codex `threads` SQLite + rollout-file fallback, exposed as `claudeHistory()` / `codexHistory()` factories wired onto each adapter's optional `history` capability. `finalizeHistory()` owns the generic sort -> cap(200) -> live-tag merge.
- Claude project-dir resolution now reuses the canonical `encodeClaudeCwd` (non-alphanumerics -> `-`), fixing `.worktrees`-style paths that a `/`-only encoder mis-keyed.
- Widened the registry `HistorySession` DTO to carry the fields the History tab renders (`provider`/`summary`/`created`/`gitBranch`/`liveSessionName`).

**Why:**
- The `tui-provider-adapters` design centralizes provider-native storage under `cli/` so app/server consumes `yaco agent ... --json` instead of parsing provider homes. This slice lands the summary/history/catalog read surfaces; the matching app-side boundary removal (`app-summary-history-boundary`, `app-provider-type-boundary`) and the SOTA provider-boundary doc pass (`docs-provider-boundary`) are separate downstream tasks.

**Key files:** `cli/src/lib/core/agent/providers/{history,types,claude,codex}.ts`, `cli/src/commands/agent/{history,summaries,providers,index}.ts`, `cli/test/{history,summary,agent-json-surfaces}.test.ts`, `cli/package.json`
**Verification:** `cd cli && bun run test:unit` -> 552 pass / 0 fail (+9: `.worktrees` encoding, spawned help/catalog envelopes, hermetic data envelopes). `tsc --noEmit` clean for all touched files (only pre-existing out-of-scope errors remain). Source-entry and PATH-prefixed compiled-binary acceptance both return `{ok:true,...}` for the three surfaces.
**Commit:** this commit.
**Next:** `app-summary-history-boundary` (app consumes these surfaces, drops provider-home reads), `app-provider-type-boundary` (validate starts against `agent providers --json`), `docs-provider-boundary` (retire flat `providers.ts` refs, document the app/CLI boundary).
**Blockers:** None.

## 2026-06-05: Agent start/lifecycle consumes the provider registry

**What changed:**
- Moved the start/status/rename/whoami/lifecycle/tmux provider branches onto the committed provider registry adapters. `start.ts` now drives resume canonicalization (`command.normalizeResumeArgs`), name handling (`command.normalizeStartArgs` / `postStartInputs`), startup interstitials (`command.startupInterstitials`, generalized into one `handleStartupInterstitial` loop), the launch command (`command.build`), session-id strategy (`sessionId.startResolution` / `resolve` / `pendingValue`), and PID resolution (`prov.executable`). `status.ts` backfills via `provider.sessionId.resolve` (guarded by `hasProvider`), keys `preferredCommand` off `provider.executable`, and iterates `listProviders()` for the health check. `rename.ts` uses `command.renameInputs`; `whoami.ts` derives session-id env keys from `listProviders().flatMap(p => p.sessionId.envKeys)`; `lifecycle.ts#ensureHooks` delegates config mutation to `getProvider(provider).hooks?.install()`; `tmux.ts` derives the known-agent executable set from the registry.
- Behavior change: the detached Codex OSC 10/11 color responder is started again, now **gated by the adapter `terminal.respondToColorQuery` flag** (no hard-coded provider check, no 1.5s launch delay). Codex start-time sessionId stays state-file-only; status backfill resolves provider storage.
- Strengthened `cli/test/lifecycle-guards.test.ts`: the Codex start test proves the adapter resolver is *not* consulted at start even when provider storage could resolve, plus a new test that status backfill *does* resolve a pending Codex sessionId from provider storage.

**Why:**
- The lifecycle paths had hard-coded `provider === "claude" | "codex"` branches; the TUI provider-adapter design centralizes per-provider behavior so adding a provider is one adapter, not edits across startup/status/rename/whoami/hooks/tmux. The OSC responder is the canonical adapter-driven terminal-runtime quirk, so it returns gated by the adapter flag while preserving the perf win (the 1.5s launch delay and 10s sessionId wait stay removed; the responder is a non-blocking `pipe-pane`).

**Key files:** `cli/src/commands/agent/{start,status,rename}.ts`, `cli/src/lib/core/agent/{whoami,lifecycle,tmux}.ts`, `cli/test/lifecycle-guards.test.ts`, `doc/main/cli/{providers,lifecycle,architecture}.md`
**Verification:** `cd cli && bun test test/start.test.ts test/rename.test.ts test/whoami.test.ts test/hooks-install.test.ts test/tmux.test.ts test/lifecycle-guards.test.ts` → 79 pass / 0 fail. `cd cli && bun run test:unit` → 546 pass / 0 fail. `tsc --noEmit` clean for all touched files (only pre-existing out-of-scope errors remain).
**Commit:** this commit.
**Next:** Sibling adapter tasks (summary/history CLI, output-follow, project-move, install/doctor, app boundary) and the `docs-provider-boundary` doc pass that retires the flat `providers.ts` references.
**Blockers:** None.

## 2026-06-05: Installer drops migrated legacy hook-v2.sh entries

**What changed:**
- Added `dropLegacyMultmuxHooks()` in `cli/src/lib/core/agent/lifecycle.ts` and wired it into `ensureClaudeHooks` + `ensureCodexHooks`. The hook merge now removes legacy `bash ".../hook-v2.sh"` shell-hook groups (under `~/.multmux` or the migrated `~/.yaco`), pruning only groups it empties and leaving every other entry — including unrelated empty groups — untouched.
- Tests in `cli/test/hooks-install.test.ts` for the pure helper plus both provider merges.

**Why:**
- The prior install only *added* the managed `yaco agent hook-event` group beside the old shell hook — `cleanupDeprecatedHooks` matched only `on-stop.sh`, and the legacy-drop never recognized the migrated `~/.yaco/hook-v2.sh` path. Result: every hook event fired twice and `hook-v2.sh` stayed referenced, blocking its removal. `yaco install` now self-heals on any machine (incl. the laptop).

**Key files:** `cli/src/lib/core/agent/lifecycle.ts`, `cli/test/hooks-install.test.ts`, `doc/main/cli/install.md`
**Verification:** `cd cli && bun run test` → 509 pass / 0 fail. `tools/install.sh` → doctor 12/12; this machine's `~/.claude/settings.json` + `~/.codex/hooks.json` now hold 0 `hook-v2.sh` refs (idempotent on re-run).
**Commit:** this commit.
**Next:** `wrapper-v2.sh` / `hook-v2.sh` stay on disk until the ~20 pre-cutover tmux panes drain, then deletable.
**Blockers:** None.

## 2026-06-05: Shed remaining multmux naming (server symbols + gitignores)

**What changed:**
- Renamed `app/server` agent-session symbols off the old multmux name: `MultmuxSession`→`AgentSession`, `MultmuxStateFile`→`AgentSessionState`, `MULTMUX_SESSIONS_DIR`→`AGENT_SESSIONS_DIR`, plus the `start`/`close`/`rename`/`to`/`watch` + `infer`/`query` helpers → `Agent*`. Internal-only; HTTP/route contracts and the on-disk state-file schema are unchanged.
- Cleaned stale `.gitignore` entries: dropped `.multmux/` (root, agent-config, cli); in `cli/.gitignore` replaced the no-longer-built `/multmux`, `/tmusk`, `/tmusk-sidebar` with the current `/yaco` binary.
- Synced `doc/main/app/backend/libs.md` to the new names and removed the now-false "type names intentionally retained" note. Test fixture project name `'multmux'`→`'demo'`.

**Why:**
- The runtime moved to `~/.yaco` / `yaco agent` long ago; the lingering `Multmux*` symbol names and dead gitignore lines were the last in-tree naming drift. `AgentSession(State)` mirrors the existing `ShellSession`/`HistorySession` convention and the CLI's `SessionState`; no `Yaco*` prefix since the brand is implicit inside the repo. The `tmusk` skill name and the `~/.multmux`→`~/.yaco` migration script keep the old name intentionally.

**Key files:** `app/server/src/lib/{agent,constants,history,project-watcher,session-reconciler,session-summary}.ts`, `app/server/src/lib/channels/{agent-output,router}.ts`, `app/server/src/routes/sessions.ts`, `.gitignore`, `agent-config/.gitignore`, `cli/.gitignore`, `doc/main/app/backend/libs.md`
**Verification:** `cd app/server && npx vitest run` → 31 files / 420 tests pass. `tsc --noEmit` shows only pre-existing unrelated errors (none in renamed files).
**Commit:** 43dc42a (code) + this docs commit.
**Next:** Optional — rename the `tmusk` skill to `agent` (skill registry + docs); deferred by request.
**Blockers:** None.

## 2026-06-05: Fast Codex startup path

**What changed:**
- Removed Codex's default 1.5s wrapper launch delay and stopped starting the detached OSC 10/11 color responder on startup.
- Kept startup `/rename <handle>` as best-effort provider-title sync, but changed it to submit-only: `yaco agent start codex` no longer waits for the slash command to finish.
- Removed the 10s Codex non-resume sessionId wait. Startup now uses a hook-written sessionId when already present, otherwise writes `pending:awaiting-first-prompt`; later hooks or status reconciliation backfill the real thread id.
- Updated lifecycle/provider docs and integration test wording so YACO handle remains the authoritative runtime identity while Codex internal title sync is best-effort.

**Why:**
- Workflow only needs the YACO handle/tmux/state path to attach, send, capture, and kill. Codex title color fidelity and immediate thread-id discovery were on the startup critical path but are not required for session availability.

**Key files:** `cli/src/commands/agent/start.ts`, `cli/test/lifecycle-guards.test.ts`, `cli/test/integration/agent-lifecycle.integration.ts`, `doc/main/cli/{lifecycle,providers}.md`
**Verification:** `cd cli && bun test test/lifecycle-guards.test.ts test/start.test.ts test/providers.test.ts test/tmux.test.ts` passed (79 tests); `cd cli && bun run build` passed; `git diff --check` passed.
**Commit:** This commit.
**Next:** Optional live Codex smoke through Workflow to confirm perceived start latency and acceptable input-box color behavior.
**Blockers:** None.

## 2026-06-05: Add `yaco agent whoami`

**What changed:**
- Added `yaco agent whoami`, returning the current YACO session handle in text mode and full runtime state plus identity source in `--json` mode.
- Implemented identity resolution in priority order: `TMUX_PANE` tmux session lookup, provider session-id env (`CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`), then nearest ancestor PID match.
- Updated tmusk skill docs and CLI architecture/provider docs for the new command and assumptions.

**Why:**
- Agents need a reliable way to self-identify their YACO handle without relying on prompt-injected names. The fallback order keeps local tmux identity canonical while still working inside provider tool subprocesses when `TMUX_PANE` is unavailable.

**Key files:** `cli/src/lib/core/agent/whoami.ts`, `cli/src/commands/agent/whoami.ts`, `cli/src/commands/agent/index.ts`, `cli/test/whoami.test.ts`, `doc/main/cli/{architecture,providers}.md`, `agent-config/global/skills/tmusk/SKILL.md`
**Verification:** Live QA with `qa-claude-whoami` and `qa-codex-whoami` passed for normal `TMUX_PANE` resolution and `env -u TMUX_PANE ... whoami` session-id fallback; `cd cli && bun test test/whoami.test.ts test/agent-dispatch.test.ts` passed (17 tests); `cd cli && bun run test:unit` passed (505 tests); `cd cli && bun run build` passed; `git diff --check` passed.
**Commit:** This commit.
**Next:** None.
**Blockers:** None.

## 2026-06-05: Streaming voice dialog

**What changed:**
- Replaced the one-shot `/api/voice/compose` flow with split `/api/voice/transcribe` and `/api/voice/format` endpoints, including upload/type validation, transcript/filePath caps, and `retry-after` forwarding on upstream 429s.
- Added self-hosted lazy VAD assets, a `voiceVad.ts` MicVAD wrapper with ~10s coalescing, a single-active-phase voice reducer, and `useVoice.ts` orchestration for per-chunk transcription, drain-gated final formatting, throttling, and stale-run cleanup.
- Updated the voice tray/control UI to show live transcript + pending count, freeze insertion target per run, and keep Insert/Discard clipboard backup e2e coverage on the split endpoint path.
- Added focused unit/e2e tests and a manual Chrome desktop + phone-over-Tailscale VAD checklist.

**Why:**
- Voice input should feel live without relying on a true streaming Whisper endpoint: VAD creates silence-aligned chunks, the client coalesces them to stay under Groq free-tier RPM limits, and the formatter runs once at Stop over the full transcript.

**Key files:** `app/server/src/routes/voice.ts`, `app/ui/src/hooks/{useVoice,voiceVad,voiceStateMachine}.ts`, `app/ui/src/components/ComposeTray.tsx`, `app/ui/tests/e2e/voice-compose-backup.spec.ts`, `plan/archive/20260605_voice-streaming/implementation_summary.md`
**Verification:** `cd app/ui && npx vitest run useVoice voiceStateMachine src/hooks/__tests__/voiceVad.test.ts` passed; `cd app/ui && npx playwright test voice` passed; `cd app/ui && npm run build` passed; `cd app/server && npm test` passed.
**Commit:** `b3026e6`
**Next:** Optional manual VAD smoke test on Chrome desktop and phone over Tailscale.
**Blockers:** None.

## 2026-06-04: Self-hosted, lazy-loaded VAD assets (`vs-vad-assets`)

**What changed:**
- `app/ui` now self-hosts the in-browser VAD runtime instead of pulling it from a CDN. Pinned `@ricky0123/vad-web@0.0.30` + `onnxruntime-web@1.20.1` (exact); added `vite-plugin-static-copy` (dev).
- `vite.config.ts`: `viteStaticCopy` copies exactly four files into `dist/assets/vad/1.20.1/` (flat, `rename: { stripBase: true }`, `Target[]`-typed): vad-web worklet, `silero_vad_v5.onnx`, and the single-threaded SIMD **non-jsep** `ort-wasm-simd-threaded.{mjs,wasm}`. One `VAD_ASSET_VERSION` drives both the copy dest and the `__VAD_ASSET_BASE__` `define` (consumer's single source of truth for the URL).
- `app/server/src/index.ts`: added `.wasm` → `application/wasm` (mandatory for `WebAssembly.instantiateStreaming`) and `.onnx` → `application/octet-stream` to the MIME map; the existing `/assets/*` `immutable` rule covers the version-pinned dir.

**Why:**
- The app runs over Tailscale / offline, so VAD must not depend on a CDN and must be reproducible. Self-hosting + content-pinned `immutable` cache makes first-voice-use a one-time ~13MB download per device with zero page-open cost. vad-web imports `onnxruntime-web/wasm` (non-jsep), so the single-threaded SIMD build suffices — avoiding the `SharedArrayBuffer`/COOP+COEP headers the threaded build would need.

**Key files:** `app/ui/package.json`, `app/ui/vite.config.ts`, `app/server/src/index.ts`; docs: `doc/main/app/backend/server.md`, `doc/dev/app/workflow.md`, `plan/archive/20260605_voice-streaming/implementation_summary.md`.
**Verification:** `tsc -b tsconfig.node.json` clean; `vite build` ok (`Copied 4 items`, flat); prod (Hono) + dev (vite middleware) serve all four `200` with correct MIME + `immutable`, binaries byte-identical to source, non-copied `…jsep.wasm` `404`s; VAD/ORT JS absent from every app chunk.
**Commit:** docs only; task code pending orchestrator review (`vs-vad-assets`).
**Next:** `vs-vad-module` (`voiceVad.ts`) consumes `__VAD_ASSET_BASE__` and **must** pass `model: 'v5'` (only the v5 model is copied).
**Blockers:** Full `app/ui` `npm run build` is red on sibling voice tasks mid-migration (`voiceStateMachine.ts` ahead of its consumers) — not from this task.

## 2026-06-04: Rename in-repo `projects/` → `plan/` across all registered repos

**What changed:**
- Renamed the in-repo task-graph + design-doc directory `projects/` → `plan/` and made it the global default (`DEFAULT_PROJECT_PATHS` in `cli/src/lib/core/paths/yaco-paths.ts`). Rebuilt + reinstalled the compiled `yaco` binary.
- Ontology is now **project ⊃ plan ⊃ task**: "project" stays the repo-level concept (registry `~/.yaco/projects.json`, `yaco project`, app `Project` type, and the unrelated `~/.claude/projects` session store all unchanged); `plan/` is the in-repo dir.
- yaco repo: `git mv projects plan` (~700 files, history preserved) + forward refs updated (6 skills, app/ui hardcoded `TASKS_FILE_PATH`, doctor/task/install path fixtures, SOTA docs, CLAUDE.md/README). Historical content (archived design docs, `doc/progress/*`) moved with the dir but text left unchanged.
- All 13 registered repos migrated, each preserving its tracking intent: tracked `projects/` → `git mv`; gitignored `projects/` (lawyer_search, closepaw) → renamed dir + ignore pattern, `plan/` stays ignored; non-git (localbiz, jobspace) → plain `mv`; tracked symlinks (openweb, closepaw→closepaw-projects) → retargeted.

**Why:**
- The in-repo `projects/` dir collided with the registry-level "a project = a registered repo", and the directory name echoed the concept at a different granularity. `plan/` removes the collision and reads naturally with `tasks.json` (the plan) + design-doc bundles.

**Key files:** `cli/src/lib/core/paths/yaco-paths.ts`, `app/ui/src/hooks/useTaskGraph.ts`, 6 `agent-config/global/skills/*/SKILL.md`, `doc/main/**`, `CLAUDE.md`, `README.md`; `git mv` of `projects/` → `plan/`.
**Verification:** cli unit 509 pass, task integration 19 pass, app/server 389 pass; `yaco doctor` task-graph resolves `plan/tasks.json`; `yaco task list` reads the graph. `find ~/ld-workspace` confirms no `projects/` in any registered repo.
**Commit:** `968901c` (yaco repo); other repos have their own local rename commits.
**Next:** Decide structure for the non-standard openweb-projects (root-level content vs nesting under `plan/`); deferred separate-private-repo design for `plan/`.
**Blockers:** None

## 2026-06-04: Resolve Documentation Consolidation Review Follow-Ups

**What changed:**
- Repointed remaining active project references from old `agent-config/doc/...` paths to root `doc/main/agent-config/...` and `doc/dev/agent-config/...`.
- Fixed moved progress-history markdown links/examples that tripped link sweeps after the root doc consolidation.

**Why:**
- Claude review found no blockers, but identified low-risk stale references that could confuse future agents.

**Key files:** `projects/active/mattpocock-skills-review/**`, `projects/active/potential-publish/initial/design_codex.md`, `projects/active/yaco-core/initial/design_claude.md`, `doc/progress/{app,cli,agent-config}.md`
**Verification:** Markdown link/path sweep, stale active-project path grep.
**Commit:** This follow-up commit
**Next:** Leave ignored `app/doc/todo/progress.json` alone unless runtime-state cleanup is explicitly requested.
**Blockers:** None

## 2026-06-04: Consolidate Monorepo Documentation

**What changed:**
- Moved component SOTA docs from `app/doc`, `cli/doc`, and `agent-config/doc` into root `doc/main/{app,cli,agent-config}` and `doc/dev/{app,cli,agent-config}`.
- Moved imported component histories into `doc/progress/`.
- Added root documentation maps and slimmed component `CLAUDE.md` files to local quickstarts.

**Why:**
- The monorepo is now merged, so docs need one canonical root hierarchy while preserving scoped ownership.

**Key files:** `doc/main/README.md`, `doc/main/architecture.md`, `doc/dev/README.md`, `doc/progress/README.md`, `CLAUDE.md`, `app/CLAUDE.md`, `cli/CLAUDE.md`, `agent-config/CLAUDE.md`
**Verification:** Markdown link/path sweep.
**Commit:** Pending
**Next:** Keep future component docs under root `doc/`.
**Blockers:** None
