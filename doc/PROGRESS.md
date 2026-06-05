# Progress

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
