# Progress

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
