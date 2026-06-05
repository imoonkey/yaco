# Progress

## 2026-06-05: Streaming voice dialog

**What changed:**
- Replaced the one-shot `/api/voice/compose` flow with split `/api/voice/transcribe` and `/api/voice/format` endpoints, including upload/type validation, transcript/filePath caps, and `retry-after` forwarding on upstream 429s.
- Added self-hosted lazy VAD assets, a `voiceVad.ts` MicVAD wrapper with ~10s coalescing, a single-active-phase voice reducer, and `useVoice.ts` orchestration for per-chunk transcription, drain-gated final formatting, throttling, and stale-run cleanup.
- Updated the voice tray/control UI to show live transcript + pending count, freeze insertion target per run, and keep Insert/Discard clipboard backup e2e coverage on the split endpoint path.
- Added focused unit/e2e tests and a manual Chrome desktop + phone-over-Tailscale VAD checklist.

**Why:**
- Voice input should feel live without relying on a true streaming Whisper endpoint: VAD creates silence-aligned chunks, the client coalesces them to stay under Groq free-tier RPM limits, and the formatter runs once at Stop over the full transcript.

**Key files:** `app/server/src/routes/voice.ts`, `app/ui/src/hooks/{useVoice,voiceVad,voiceStateMachine}.ts`, `app/ui/src/components/ComposeTray.tsx`, `app/ui/tests/e2e/voice-compose-backup.spec.ts`, `plan/active/voice-streaming/implementation_summary.md`
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

**Key files:** `app/ui/package.json`, `app/ui/vite.config.ts`, `app/server/src/index.ts`; docs: `doc/main/app/backend/server.md`, `doc/dev/app/workflow.md`, `plan/active/voice-streaming/implementation_summary.md`.
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
