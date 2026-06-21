## 2026-06-21: Extract /yaco-worktree; rebuild /orchestrate around an evidence-gate

**What changed:**
- New skill **`/yaco-worktree`** — the operation manual for the `yaco worktree` CLI (cwd/branch resolution, create+provision/reuse, merge modes, cleanup, cross-repo, per-slug completion check). Fills the gap in the `/yaco-<area>` skill pattern (`/yaco-agent`, `/yaco-task`, `/yaco-paths` already existed). `yaco-dependent: true`.
- `/orchestrate` rewritten around a single mermaid **Flow** and shrunk ~30% (182→124 lines): the old `Implementation Workflow` + `Verification` + `Optional gatekeeper review` sections (which overlapped and read muddy) collapsed into one **evidence-gate**. Orchestrate now decides done by *reading evidence* the worker produced — acceptCriteria, the independent-review artifact (no unresolved critical/high), `/verify`, `/qa` — never by re-running the work. The gate has two live outcomes: clean → **done**; not-yet-satisfied (missing *or* failed) → **bounce** the worker to keep finishing its own recipe. Only non-convergence (~3 bounces) or a human-gate **blocks**. Dropped "orchestrate optionally re-reviews" (redundant: the worker's reviewer was already independent/cross-provider). Worktree mechanics now delegate to `/yaco-worktree`; orchestrate keeps only the dispatch decisions (two-level parallelism).
- Cut the explanatory "division of labor" preamble from `/orchestrate` (commentary belongs in `architecture.md`, not the SKILL artifact). `/yaco-task` worktree field now points at `/yaco-worktree`.

**Why:**
- `/orchestrate` was doing three jobs (orchestration + worktree lifecycle + a muddy verification story). Extracting worktree (deletion test: complexity concentrates, doesn't move) and reframing verification as an evidence-gate makes its one job legible — and makes it gate-shaped *before* codify-some-process lands, so Phase B swaps human-read evidence for `yaco gate` with the criteria unchanged.

**Key files:**
- `global/skills/yaco-worktree/SKILL.md` (new), `global/skills/orchestrate/SKILL.md`, `global/skills/yaco-task/SKILL.md`
- `doc/main/agent-config/architecture.md`

**Design docs:** `plan/all/implement-orchestrate-rewrite/design.md` (§3.3, D2① revised)
**Verification:** Cross-provider codex review; mermaid parse + relative-link sweep; `yaco worktree merge` behavior cross-checked against `cli/src/lib/core/worktree/merge.ts`.

## 2026-06-20: Collapse leaf execution into the /implement recipe

**What changed:**
- `/implement` rewritten into the **canonical leaf recipe**: a fixed mermaid flow whose every skill-invoking step is marked MUST-USE in prose (`/coding-standards`, `/tdd`, `/code-review`, `/verify`, `/qa`, `/update-doc`). Within a phase, `/verify` and `/code-review` are peer gates on the commit — `/verify` (build·lint·test·security) runs first to fail fast; `/qa` is the end-stage E2E gate. Step 4 is a **Completeness Check** (re-read vs the goal, hunt for *missing scope*, not bugs). `/implement` carries **no reference to `/orchestrate`** — it's a self-contained module; the relationship and the manual-vs-orchestrate finishing adapters live in `architecture.md` and the gate/caller layer, not in the SKILL prose (locality).
- `/orchestrate` stops re-describing implement/review/fix/doc and instead dispatches `/implement <task>`. It keeps only its unique orchestration layer: dispatch selection, parallelism, worktrees, **independent** acceptCriteria verification, optional gatekeeper review (critical/high → `blocked: review-failed`, no fix-loop), worktree completion, auto-continue, blocked, and the direct-dispatch path for non-implementation (docs/design/planning) leaves.
- Docs: new implement↔orchestrate contract subsection in `doc/main/agent-config/architecture.md`; `workflow.md` orchestrate row updated; back-link added from `codify-some-process` to this rewrite as its prerequisite.

**Why:**
- The two skills each wrote the same implement→review→fix→verify→doc pipeline, so a change meant editing two places and they drifted. Defining leaf execution once (in `/implement`) and having `/orchestrate` delegate gives `codify-some-process`'s gate a single clean mount point.
- Structure-only (Layer A): no gate wired, no enforcement removed. The one deliberate change is the §1 consistency-strengthening (uniform MUST-USE) — additive, still prose. Gate seams are marked for Phase B.

**Key files:**
- `global/skills/implement/SKILL.md`, `global/skills/orchestrate/SKILL.md`
- `doc/main/agent-config/architecture.md`, `doc/dev/agent-config/workflow.md`

**Design docs:** `plan/all/implement-orchestrate-rewrite/design.md`
**Verification:** Cross-provider codex review (clean); mermaid parse + relative-link sweep + MUST-USE coverage check.

## 2026-06-04: Tag skills with `metadata.yaco-dependent`

**What changed:**
- Added a `metadata.yaco-dependent` frontmatter field to global skills, classifying each by its relationship to the `yaco` CLI. Three states: `"true"` (core mechanism calls yaco), `"optional"` (standalone with an optional "Inside a YACO project" integration), and absent (standalone default).
- `"true"` (6): align, double-design, init-all, orchestrate, tmusk, update-tasks. `"optional"` (3): design, office-hours, update-doc. The remaining 12 skills carry no field (standalone).
- Classification derived empirically by grepping each SKILL.md for actual `yaco <area>` invocations / `projects/tasks.json` use — not the one-line descriptions.
- Field lives under `metadata` per the Agent Skills spec (custom keys are not top-level); values are strings.
- Documented in `doc/main/agent-config/architecture.md` (Skill Tiers → yaco coupling) and the "Adding a New Skill" workflow.

**Why:**
- Make the yaco-coupled vs standalone split machine-readable so the standalone set can later be exported as a yaco-independent bundle, and so the grouping is visible in docs rather than implicit.
- A directory split (`skills/core/` vs `skills/optional/`) was rejected: skill discovery is a flat one-level scan (`~/.claude/skills/<name>/SKILL.md`), so nesting would hide skills. Metadata tagging achieves the grouping without breaking discovery.
- Explicit `"false"` was dropped — absence already means standalone, so only the meaningful cases carry the field.

**Key files:** `agent-config/global/skills/{align,double-design,init-all,orchestrate,tmusk,update-tasks,design,office-hours,update-doc}/SKILL.md`, `doc/main/agent-config/architecture.md`, `doc/dev/agent-config/workflow.md`
**Verification:** All 9 frontmatters parse as YAML with `metadata.yaco-dependent` ∈ {true, optional}; tier counts confirmed 6/3.
**Commit:** This commit
**Next:** Optional — add `compatibility: Requires the yaco CLI` to the 6 `"true"` skills; build tooling that reads the field to export the standalone set.
**Blockers:** None

## 2026-06-03: Skills call yaco directly; multmux skill renamed → agent (yc-skill-contracts)

**What changed:**
- `git mv agent-config/global/skills/multmux/ → agent/`. Frontmatter `name: multmux → agent`; description prose recast around `yaco agent ...`.
- Every SKILL.md that previously invoked `$SKILL_DIR/scripts/(worktree-|align_poll|init-symlinks|update-tasks)` rewritten to call the equivalent `yaco <area> <subcommand> --json` form: orchestrate → `yaco worktree {create,merge,cleanup}` + `yaco task set --data ...`; update-tasks → `yaco task {set,rm,archive,validate,list}`; align → `yaco align poll`; init-all → `yaco init links`.
- Incidental legacy mentions cleaned up in `update-doc`, `qa`, `double-design`, `design` SKILL.md.
- Provider-shortcut policy enforced in skill markdown: agent/SKILL.md no longer prints `yaco claude`/`yaco codex` examples; the section names the form generically as the "one-word `yaco <provider>` form" and labels it HUMAN-only. orchestrate + double-design carry matching one-line callouts.
- `--json` now appears on every `yaco` invocation in skill code blocks (CLI contract). align poll text updated to read `data.status` from the envelope rather than the legacy one-word stdout line.
- `agent-config/CLAUDE.md`: ecosystem row reframed around the unified `yaco` dispatcher; "Dependencies" paragraph names the new skill subcommands.
- `agent-config/doc/main/architecture.md` skill list: `multmux` → `agent`.
- `agent-config/doc/dev/workflow.md`: `/orchestrate` row + "Adding a New Skill" section rewritten to instruct new skills to call `yaco <area> --json` (no helper scripts by default); the script-path snippet survives as a rare-case fallback.
- Dead legacy helpers dropped in the same pass (not deferred to yc-cleanup-legacy): `global/skills/update-tasks/scripts/update-tasks.py`, `global/skills/orchestrate/scripts/test-update-tasks-worktree.sh`. `global/skills/{align,init-all,orchestrate}/scripts/` retained for now (yc-cleanup-legacy removes them next).

**Why:**
- After yc-agent-subcommand / yc-task-ts / yc-worktree-ts / yc-align-init landed real `yaco agent|task|worktree|align|init` subcommands, every skill could stop pointing at skill-local shell/python wrappers and call the canonical CLI instead. One CLI, one envelope, one --json contract → skills, app, and humans all read the same shape.
- Renaming the skill from `multmux` to `agent` matches the runtime's new identity (the `multmux` binary was retired in yc-agent-subcommand; behavior lives behind `yaco agent`).
- The HUMAN-only / `--json`-everywhere rules came out of Codex review pass 1 — without them, skills can silently regress to ad-hoc shortcut forms whose output isn't parseable.

**Key files:** `agent-config/global/skills/{agent,align,design,double-design,init-all,orchestrate,qa,update-doc,update-tasks}/SKILL.md`, `agent-config/CLAUDE.md`, `agent-config/doc/main/architecture.md`, `agent-config/doc/dev/workflow.md`. Deletions: `global/skills/update-tasks/scripts/update-tasks.py`, `global/skills/orchestrate/scripts/test-update-tasks-worktree.sh`.
**Verification:** acceptance gates run from the worktree root —
  - `test -d agent-config/global/skills/agent && ! test -d agent-config/global/skills/multmux` → PASS
  - `head -5 agent-config/global/skills/agent/SKILL.md` shows `name: agent`
  - `rg '\$SKILL_DIR/scripts/(worktree-|align_poll|init-symlinks|update-tasks)' agent-config/global/skills/` → empty
  - `rg '\bmultmux\b' agent-config/global/skills/` → empty
  - `rg 'update-tasks\.py' agent-config/global/skills/` → empty (post-deletion)
  - `rg 'yaco claude|yaco codex' agent-config/global/skills/` → empty
  - `rg 'multmux' agent-config/CLAUDE.md` → empty
  - Spot-checked: every `yaco` command line in skill code blocks carries `--json` (the only "missing" hit is the multi-line `--data '{...}'` block in `update-tasks/SKILL.md:132` whose `--json` lands on the closing line).
**Commit:** `5d305c7`, `dc9224d`.
**Next:** yc-cleanup-legacy removes the remaining `global/skills/{align,init-all,orchestrate}/scripts/` shells now that no SKILL.md references them.
**Blockers:** None. Rename history recoverable with `git log --find-renames=40% --follow agent-config/global/skills/agent/SKILL.md` (the combined rename+rewrite drops below Git's default 50% similarity).



**What changed:**
- Deleted `global/lib/{yaco_home,yaco_paths,test_yaco_home,test_yaco_paths}.py` and the now-empty `global/lib/` directory.
- The TypeScript resolver in `@yaco/cli/core/paths` (cli/src/lib/core/paths/) is the single source of truth for YACO paths across the monorepo. No skill script under `global/skills/**` ever imported the Python helpers — they only existed for parity with the previous TS resolvers, which themselves consolidated in the same yc-core-paths pass.

**Why:**
- Two parallel resolver implementations (TS + Python) created a maintenance burden with no real consumers on the Python side; the Python skill scripts that need YACO paths can shell out to `yaco paths runtime --json` (live in this pass) instead of importing a Python module.

**Key files:** deletions only under `agent-config/global/lib/**`.
**Verification:** `rg 'yaco_paths|yaco_home' --type py` returns empty (acceptance gate AC1 from yc-core-paths).
**Commit:** `40549e3`.
**Next:** When a skill script needs YACO paths, shell out: `yaco paths runtime --json | jq -r .data.<key>`.
**Blockers:** None.

## 2026-05-27: YACO_HOME resolver for skill scripts (yc-path-shims)

**What changed:**
- `global/lib/yaco_home.py` (new): `get_yaco_home()` returns `os.environ.get("YACO_HOME") or ~/.yaco`. Helpers: `projects_file`, `ui_state_dir`, `shell_sessions_dir`, `channels_dir`, `channel_scope_dir(scope)`, `sessions_dir`, `project_events_file(id)` — symmetric with `workflow/server/src/lib/yacoHome.ts` and `multmux/src/yacoHome.ts`.
- `global/lib/test_yaco_home.py` (new, 10 cases via stdlib unittest): default + empty-env fallback + env override + each helper. Runs under `python3 -m unittest test_yaco_home`.
- No skill scripts in `global/skills/**` were rewritten; today no skill script under this repo hardcodes `~/.workflow` or `~/.multmux` paths (`global/skills/multmux/SKILL.md` describes the multmux state-file contract in prose only). The Python resolver is the integration point for future YACO-aware skill scripts.

**Why:**
- Workflow's [yaco-core design](../../plan/all/yaco-core/final/design.md) §Canonical Path Layout consolidates runtime state under `${YACO_HOME:-~/.yaco}/`. Adding the Python-side resolver in lockstep with the TS resolvers (workflow + multmux) means any new skill script that needs the runtime root has one place to read from and one set of tests it must match.

**Key files:** `global/lib/yaco_home.py` (new), `global/lib/test_yaco_home.py` (new).
**Verification:** `cd global/lib && python3 -m unittest test_yaco_home -v` → 10 pass / 0 fail. `rg "\.workflow|\.multmux/sessions" global/skills global/lib` only matches the `multmux/SKILL.md` doc paragraphs and this resolver's docstring.
**Commit:** `72bdeb7`.
**Next:** Skill scripts that need to read the YACO runtime root can `from yaco_home import get_yaco_home, …` directly.
**Blockers:** None.

## 2026-05-27: Classify skills as YACO-native or generic+compat

**What changed:**
- Added an explicit "This skill is YACO-native: ..." statement near the top of `update-tasks`, `orchestrate`, `double-design`, and `align` SKILL.md. Each statement names the specific YACO files/protocols that skill owns (tasks.json, bundle layout, status.txt handoff, etc.).
- Collapsed YACO-specific path references in generic methodology skills into a single `## YACO compatibility` section near the end: `design`, `office-hours`, `multmux`, `update-doc`. Generic prose now reads as portable methodology; YACO touchpoints (bundle paths, `/update-tasks` handoff, `~/.yaco/sessions/` storage) live in the compat section.
- `update-doc` specifically: moved the "implementation summary" and "archive bundle" steps out of the numbered Process (which were 5 and 6) into the compat section, and renumbered "Commit Docs" from 7 → 5. The generic Process is now five steps.
- No renames. No `yaco-native:` frontmatter added (optional for v0; classification lives in prose). Generic skills that do not currently mention YACO paths were intentionally left untouched (`scope-review`, `ux-design`, `eng-plan-review`, `implement`, `tdd`, `code-review`, `investigate`, `qa`, `verify`, `coding-standards`, `retro`, `ultra-think`, `init-all`).

**Why:**
- `final/design.md` §Skill Split in the workflow `yaco-core` project requires methodology skills to remain portable outside YACO. Without explicit classification, future skill edits drift toward assuming the YACO layout everywhere, which would break agent-config consumers that don't use YACO conventions. Per-skill prose (not frontmatter) is the canonical source for v0 — frontmatter discovery is deferred until a tool actually needs it.

**Key files:** `global/skills/{update-tasks,orchestrate,double-design,align}/SKILL.md` (YACO-native statements), `global/skills/{design,office-hours,multmux,update-doc}/SKILL.md` (compat sections).
**Verification:** `grep -ln "YACO-native" global/skills/*/SKILL.md` returns the 4 expected files; `grep -ln "YACO compatibility" global/skills/*/SKILL.md` returns the 4 expected files; `grep -rn "yaco-native" global/skills` returns no hits (frontmatter absent as intended); no skill mentions `projects/tasks.json`, `projects/active/`, `~/.workflow`, `~/.multmux`, or `~/.yaco` outside one of those two section types.
**Commit:** (pending)
**Next:** `yc-frontmatter` task (optional `yaco-native: true` frontmatter) lands later if/when tool discovery needs it.
**Blockers:** None.

## 2026-04-22: Standardize $SKILL_DIR for scripts/ refs in SKILL.md

**What changed:**
- Appended a uniform "Script paths" snippet at the end of every SKILL.md that invokes its own `scripts/` (`align`, `init-all`, `orchestrate`, `update-tasks`). Snippet defines `SKILL_DIR="$(dirname "$(readlink -f ~/.claude/skills/<skill>/SKILL.md)")"` and gives `$HOME/.claude/skills/<skill>/scripts/<script>` as fallback.
- Rewrote inline command examples in those skills to use `"$SKILL_DIR/scripts/<script>"`. Removed redundant ad-hoc disambiguation blocks (align "Helper Path Rule", orchestrate's inline SKILL_DIR= line, init-all's `<init-all-skill-path>` placeholder).
- `doc/dev/workflow.md`: updated "Adding a New Skill" to mandate the snippet for any skill with `scripts/`.
- `.gitignore`: ignore `global/skills/humanizer/` (third-party download).
- `global/skills/multmux/SKILL.md`: refreshed CLI surface (`--resume`, `--all`, `--lines`, `sessionPath`, global `~/.multmux/sessions/` registry, simplified handle = tmux session name).

**Why:**
- Agents in downstream projects (e.g. openweb) were resolving bare `scripts/update-tasks.py` against the **project cwd**, not the skill directory. Result: "script not found" → agent fell back to writing JSON directly, bypassing the validation/lock logic in `update-tasks.py`. The 4 affected skills had inconsistent disambiguation styles; standardizing one snippet eliminates the failure mode and keeps future skills consistent.

**Key files:** `global/skills/{align,init-all,orchestrate,update-tasks,multmux}/SKILL.md`, `doc/dev/workflow.md`, `.gitignore`.
**Verification:** `grep -rn "scripts/" global/skills/*/SKILL.md` confirms all script invocations now use `$SKILL_DIR` or full `~/.claude/skills/...` paths. No bare `scripts/<file>` invocation patterns remain.
**Commit:** `f95fdfd`
**Next:** None — convention is now documented in `doc/dev/workflow.md` so future skills follow it.
**Blockers:** None.

## 2026-04-22: Doc/projects separation — Phase 1b (agent-config cutover)

**What changed:**
- `doc/todo/` → `projects/active/`, `doc/archive/` → `projects/archive/` (git mv, history preserved).
- State files promoted: `tasks.json`, `progress.json`, `progress.json.lock` now live at `projects/` root (not under `active/`). `doc/PROGRESS.md` and `doc/{main,dev}/` unchanged.
- `update-tasks.py` constants: `FILE = Path("projects/tasks.json")`, `ARCHIVE_DIR = Path("projects/archive")`. `LOCK_FILE` derives from `FILE.parent`, so it auto-resolves to `projects/.tasks.json.lock`.
- Skill prompts swept: `update-tasks`, `orchestrate`, `design`, `double-design`, `update-doc`, `office-hours` SKILL.md plus `orchestrate/scripts/test-update-tasks-worktree.sh` and `doc/dev/workflow.md`. `implement/SKILL.md` had no stale refs.
- Historical project notes in `projects/active/` and `projects/archive/` swept for `doc/todo|doc/archive` strings (mirrors workflow Phase 1a sweep). `.gitignore` paths updated.

**Why:**
- Workflow repo Phase 1a (commits `37d8b34`, `2ecb70f`, `14035a9`) renamed its own layout. The global skills delivered via `~/.claude/skills → agent-config/global/skills` were still writing to `doc/todo/...` in every project — every other repo broke until the agent-config skills were updated to match. This had to land back-to-back inside the same freeze window.

**Key files:** `global/skills/{update-tasks,orchestrate,design,double-design,update-doc,office-hours}/SKILL.md`, `global/skills/update-tasks/scripts/update-tasks.py`, `global/skills/orchestrate/scripts/test-update-tasks-worktree.sh`, `doc/dev/workflow.md`, `.gitignore`, `projects/tasks.json`.
**Verification:** runtime check confirmed `FILE=projects/tasks.json`, `ARCHIVE_DIR=projects/archive`, `LOCK_FILE=projects/.tasks.json.lock`, all paths exist. `grep -rE 'doc/(todo|archive)' global/skills` empty. Acceptance criteria from workflow design.md all green.
**Commit:** `75a9f15`
**Next:** Phase 2 — sweep the other workspace repos (multmux, cproxy, lawyer_search, symphony, autoresearch-optimizer, vvg, androidagent) for `doc/todo|doc/archive` references and migrate any local task/archive state. Then Phase 4 cross-repo verification + lift the freeze on `/update-tasks`, `/orchestrate`, `/design`, `/double-design`, `/implement`, `/update-doc`, `/office-hours`.
**Blockers:** None.

## 2026-04-11: Sync skill docs with Tasks v2 data model

**What changed:**
- `/update-tasks` SKILL.md: added 7 new fields to schema table (priority, agent, tags, estimate, blockReason, created, updated), added State Transitions section documenting relaxed transition rules
- `/orchestrate` SKILL.md: added Ordering subsection (priority as tiebreak), dispatch sets agent field, verification uses blockReason, human review flow expanded (approve/request changes/abandon)

**Why:**
- `update-tasks.py` already supported V2 fields and relaxed state transitions, but the skill docs still described V1 behavior — agents reading the skills would not know about new fields or that blocked→done is valid

**Key files:** `global/skills/update-tasks/SKILL.md`, `global/skills/orchestrate/SKILL.md`
**Verification:** Docs match current update-tasks.py validation logic
**Commit:** (this commit)
**Next:** None
**Blockers:** None

## 2026-03-30: Add /office-hours skill (gstack-adopt Phase 3)

**What changed:**
- New `/office-hours` skill (440 lines) — YC-style problem definition with two modes: Startup (rigorous diagnostic with 6 forcing questions, anti-sycophancy rules, pushback patterns) and Builder (enthusiastic design partner)
- Produces a design doc, not code — hard gate on implementation actions
- Includes spec review loop with adversarial subagent review before presenting to user
- Added to `doc/dev/workflow.md` skill table

**Why:**
- Gap between "I have a vague problem" and "I have a scoped feature to design" — `/scope-review` starts from a defined idea, `/office-hours` starts from a problem
- Core content preserved verbatim from gstack's carefully-written forcing questions and anti-sycophancy framework, stripped of gstack infrastructure dependencies

**Key files:** `global/skills/office-hours/SKILL.md`, `doc/dev/workflow.md`
**Verification:** Skill registered in Claude Code skill system, handoff references (`/design`, `/implement`) verified correct
**Commit:** (this commit)
**Next:** None (gstack-adopt Phase 3 complete; backlog: /security-audit, /guard, /ship)
**Blockers:** None

## 2026-03-24: Integrate /qa into skill pipeline

**What changed:**
- `/implement` Step 3: replaced vague "manually verify" with mandatory `/qa` call
- `/orchestrate` Verification: added `/qa` as verification method for user-facing implementation tasks
- `/verify`: added boundary note — unit gates only, E2E → `/qa`

**Why:**
- `/qa` was standalone with no integration points — other skills didn't know to call it
- Establishes clear pipeline: `/implement` → `/qa` (E2E) → `/verify` (gate) → commit

**Key files:** `global/skills/implement/SKILL.md`, `global/skills/orchestrate/SKILL.md`, `global/skills/verify/SKILL.md`
**Verification:** All three skills reference `/qa` at correct integration points
**Commit:** (this commit)
**Next:** None
**Blockers:** None

## 2026-03-24: Rewrite /qa skill — E2E/integration focus

**What changed:**
- Rewrote `/qa` from unit-test runner to E2E/integration QA skill
- New process: analyze changes → derive affected user flows → verify with stack tools → fix-verify loop → regression check
- Clear skill boundaries: `/tdd` + `/verify` own unit tests, `/qa` owns user-flow verification
- Rewrote `references/typescript-node.md` from unit test commands to integration/E2E (supertest, HTTP calls, CLI E2E, DB integration)
- `references/web-playwright.md` kept as-is (already E2E-focused)
- Updated `doc/dev/workflow.md` skill table description

**Why:**
- Old `/qa` duplicated `/verify`'s test-running role — both just ran unit test suites
- Real QA gap was user-level verification: does the feature actually work end-to-end?
- Aligns with skill pipeline: `/implement` → `/qa` (verify flows) → `/verify` (gate check) → commit

**Key files:** `global/skills/qa/SKILL.md`, `global/skills/qa/references/typescript-node.md`, `doc/dev/workflow.md`
**Verification:** SKILL.md 89 lines, all references present, skill registered in Claude Code
**Commit:** (this commit)
**Next:** None
**Blockers:** None

## 2026-03-24: Add investigate, retro, qa skills (gstack/claude-code adopt Phase 1-2)

**What changed:**
- Added `/investigate` skill (41 lines) — systematic debugging discipline: investigate before fixing, max 3 attempts
- Added `/retro` skill (65 lines) — engineering retrospective with cross-project mode (`/retro global`)
- Added `/qa` skill (72 lines) — fix-verify loop with stack-detect, references for web-playwright and typescript-node
- Created design docs analyzing gstack and Claude Code plugins for adoption: `projects/active/gstack-adopt/`
- Created task graph in `projects/tasks.json` for the gstack-adopt project

**Why:**
- agent-config had strong Plan→Build→Review coverage but weak Test/Debug/Reflect skills
- gstack's `/investigate` iron law ("no fixes without investigation") and fix-verify loop pattern were the highest-value adoptions
- `/retro` fills the reflection gap — no way to answer "what did I ship this week?"

**Key files:** `global/skills/investigate/SKILL.md`, `global/skills/retro/SKILL.md`, `global/skills/qa/SKILL.md`, `global/skills/qa/references/web-playwright.md`, `projects/active/gstack-adopt/`
**Verification:** All 3 skills registered in Claude Code skill system, line counts within targets
**Commit:** (this commit)
**Next:** office-hours (Phase 3), code-review confidence scoring, implement exploration phase
**Blockers:** None

## 2026-03-23: Add ecosystem section to CLAUDE.md across three repos

**What changed:**
- Added `## Ecosystem` section to CLAUDE.md in agent-config, multmux, and workflow
- Each repo lists the three-repo dependency graph with tailored notes on what breaks what

**Why:**
- Agents working in one repo had no awareness of the other two — changes to multmux CLI or agent-config skill contracts could silently break downstream consumers

**Key files:** `CLAUDE.md` (all three repos)
**Verification:** All three pushed successfully
**Commit:** fdabac7 (agent-config), e4da681 (multmux), 90d04e7 (workflow)
**Next:** None
**Blockers:** None

## 2026-03-23: Align repo docs with /update-doc and /init-all guidelines

**What changed:**
- Merged `doc/design_claude.md` (250 lines) into `doc/main/architecture.md` (60 lines, concise)
- Added `doc/main/README.md` as navigation hub
- Slimmed `README.md` to intro + pointers (120 → 21 lines)
- Slimmed `CLAUDE.md` to pointer-style per /init-all template
- `/update-doc`: added CLAUDE.md to SOTA surface, promoted archiving to step 6, added doc/main and doc/dev guidelines, removed redundant "When to Use"

**Why:**
- Repo docs violated its own guidelines: no doc/main/README.md nav hub, design doc outside doc/main/, README and CLAUDE.md duplicating content instead of pointing to SOTA

**Key files:** `CLAUDE.md`, `README.md`, `doc/main/architecture.md`, `doc/main/README.md`, `global/skills/update-doc/SKILL.md`
**Verification:** `rg design_claude` confirmed no stale references to deleted file in SOTA docs
**Commit:** 34ed242..7090694
**Next:** None
**Blockers:** None

## 2026-03-23: Add /init-all skill, slim setup.sh to global-only

**What changed:**
- New `/init-all` skill: calls `/init` to generate CLAUDE.md, creates multi-tool symlinks (AGENTS.md, GEMINI.md, .agents/, .codex/), bootstraps doc/ SOTA structure
- `setup.sh` slimmed to global-only (removed project-level steps 6-7, no longer takes project path arg)
- Project-level init now handled entirely by `/init-all`

**Why:**
- setup.sh and init-symlinks.sh had duplicate project-level symlink logic — clean split: setup.sh = global, /init-all = per-project
- `/init-all` integrates with Claude's built-in `/init` instead of reimplementing CLAUDE.md generation

**Key files:** `global/skills/init-all/SKILL.md`, `global/skills/init-all/scripts/init-symlinks.sh`, `setup.sh`, `README.md`, `doc/dev/workflow.md`, `doc/main/architecture.md`
**Verification:** Manual review of diff
**Commit:** (this commit)
**Next:** None
**Blockers:** None

## 2026-03-23: Add description field to task schema + multmux docs update

**What changed:**
- `description` field added to task schema — required on new tasks, included in orchestrate worker prompt
- `update-tasks.py` enforces `description` on task creation alongside `title`
- `/multmux` SKILL.md updated: `--json` flag on start/status, `rename` command, `sessionId` docs

**Why:**
- Worker prompt had title + acceptCriteria but no explanation of *what to do* — insufficient context for implementation
- multmux docs lagged behind actual CLI capabilities

**Key files:** `global/skills/update-tasks/SKILL.md`, `global/skills/update-tasks/scripts/update-tasks.py`, `global/skills/orchestrate/SKILL.md`, `global/skills/multmux/SKILL.md`
**Verification:** Manual review of diff
**Commit:** (this commit)
**Next:** First real tasks.json + end-to-end /orchestrate run
**Blockers:** None

## 2026-03-22: Add /update-tasks and /orchestrate skills (L2.1 v2)

**What changed:**
- New `/update-tasks` skill: manages `projects/tasks.json` task graph with `scripts/update-tasks.py` CLI (set/rm commands)
- New `/orchestrate` skill: dispatches ready tasks to multmux workers with review loops
- Script validates refs, cycles (parent chain + depends DFS), state transitions, type safety
- Parent rollup: all children terminal -> parent done; reopen child -> parent running (only from done, not cancelled)
- Milestone tasks (with children) reject direct state writes — state derived from children only
- Codex review round applied: base commit capture, /update-tasks abstraction, type validation, rollup guards

**Why:**
- L2.1 v2 design: two skills, one file (`tasks.json`), zero coordinator agent. Human cranks the handle via "continue".

**Key files:** `global/skills/update-tasks/SKILL.md`, `global/skills/update-tasks/scripts/update-tasks.py`, `global/skills/orchestrate/SKILL.md`
**Verification:** Full test suite — create, merge-update, rollup both directions, all validation errors, rm with rollup, type rejection, milestone guard
**Commit:** 518a491..e4f2819
**Next:** First real task graph in a project repo, end-to-end /orchestrate run
**Blockers:** None

## 2026-03-21: Remove worktree mode from /implement

**What changed:**
- Removed `--worktree` flag, Worktree Mode section, Step 6, and all worktree references from `/implement`
- Removed `/implement --worktree` row from `doc/dev/workflow.md` skill table (kept `/worktree-task` as standalone)

**Why:**
- Simplifying — worktree mode in /implement adds complexity not currently needed. /worktree-task remains available independently.

**Key files:** `global/skills/implement/SKILL.md`, `doc/dev/workflow.md`
**Verification:** `rg` confirmed no stale `/implement --worktree` references in SOTA docs
**Commit:** 1f4efd0
**Next:** None
**Blockers:** None

## 2026-03-21: Merge stack skills into global with references/ pattern

**What changed:**
- Moved `coding-standards` and `verify` from `stacks/` to `global/skills/` with `references/<stack>.md` for stack-specific content
- Skills auto-detect project stack from marker files (`build.gradle` → kotlin-android, `package.json` → typescript-node)
- Simplified `setup.sh` to be project-agnostic — no stack parameter needed
- Deleted `stacks/` directory entirely
- Updated README, CLAUDE.md, architecture doc, workflow doc

**Why:**
- Eliminates the stack tier — all skills are global, stack-specific content is just reference files
- `setup.sh` becomes truly project-agnostic, no need to know the stack at setup time
- Adding a new stack is just adding reference files, not creating directory trees

**Key files:** `global/skills/coding-standards/SKILL.md`, `global/skills/verify/SKILL.md`, `setup.sh`, `README.md`, `CLAUDE.md`
**Verification:** `rg stacks/` returns no matches in SOTA docs; skills load correctly
**Commit:** 598b03e
**Next:** Remove stale per-project symlinks to old stacks/ paths
**Blockers:** None

## 2026-03-21: Remove L2.1 workflow and workstream skills

**What changed:**
- Reverted L2.1 skills: `/decompose`, `/dispatch`, `/status`, `/checkpoint`, `flow/schemas.md` all deleted
- Removed `/workstream` skill and all "Workstream Integration" sections from `/implement`, `/code-review`, `/tdd`, `/double-design`
- Updated `/multmux` notes (status tracking, handle resolution, test commands)
- Updated `/double-design` (multi-doc support note for large designs)

**Why:**
- L2.1 workflow skills need rework before re-adding
- Workstream protocol removed to reduce complexity; will revisit when needed

**Key files:** `global/skills/` (deleted: workstream, checkpoint, decompose, dispatch, status, flow), `global/skills/implement/SKILL.md`, `global/skills/code-review/SKILL.md`, `global/skills/tdd/SKILL.md`, `global/skills/double-design/SKILL.md`, `global/skills/multmux/SKILL.md`
**Verification:** `rg` confirmed no stale references to removed skills in SOTA docs
**Commit:** ad8f839..74b3d29
**Next:** None
**Blockers:** None

## 2026-03-21: Skill cleanup — rename, English-only, principles extraction

**What changed:**
- Renamed `/write-doc` → `/update-doc` across all skills and docs
- Removed `priority.md` from doc structure and deleted template asset
- Removed all `.ai-dev` references — `.claude/skills/` is the real dir, `.agents/skills/` is the symlink
- `/design`: extracted Design Principles into its own section (Linus Torvalds style, KISS, no backward compat, etc.)
- `/align`: rewrote entirely to English, split into Principles (alignment + design) and Process sections, inlined design principles
- `/update-doc`: added step 5 (workstream implementation summary) and step 6 (commit docs)
- Reverted L2.1 workflow skills (decompose, dispatch, status, checkpoint) — needs rework

**Why:**
- Simplify skill directory convention to match reality (no .ai-dev)
- Consistent English-only skills for broader agent compatibility
- Separating principles from process improves reusability and clarity

**Key files:** `global/skills/update-doc/SKILL.md`, `global/skills/design/SKILL.md`, `global/skills/align/SKILL.md`, `global/skills/implement/SKILL.md`, `doc/dev/workflow.md`, `README.md`
**Verification:** `rg` confirmed no stale `write-doc` or `.ai-dev` references in SOTA docs/skills
**Commit:** 56ec80b
**Next:** None
**Blockers:** None

## 2026-03-11: Expand /update-doc to include project-local skills

**What changed:**
- Updated `/update-doc` so it treats project-local skills in `./.claude/skills/*` (symlinked to `./.agents/skills/*`) as part of the SOTA documentation surface
- Simplified local-skill discovery: `./.claude/skills/` is the real location, `./.agents/skills/` is a symlink
- Added explicit verification requirements for local skill `process.*` files and `scripts/` helpers after changes
- Updated `/implement` and the dev workflow doc to reflect the broader `/update-doc` scope

**Why:**
- Workflow and process knowledge often lives in project-local skills, not only in `doc/main/` or `doc/dev/`
- Local skill folders are commonly symlinked aliases, so the workflow should update one canonical location instead of drifting across copies
- When skill instructions change without verifying their helper scripts, the prompt layer drifts away from what actually works

**Key files:** `global/skills/update-doc/SKILL.md`, `global/skills/implement/SKILL.md`, `doc/dev/workflow.md`
**Verification:** Verified affected references and path conventions with `rg`; confirmed current skill helper script directories still exist; ran `bash -n` on `global/skills/*/scripts/*.sh`
**Commit:** uncommitted
**Next:** Discuss whether `doc/dev` should eventually merge into project-local skills instead of staying separate
**Blockers:** None

## 2026-03-10: Add /worktree-task skill and /implement --worktree integration

**What changed:**
- New skill: `/worktree-task` — worktree-based task isolation with cross-session continuity (create, resume, merge, cleanup, status)
- Helper scripts: `worktree-create.sh`, `worktree-merge.sh`, `worktree-cleanup.sh`, `worktree-status.sh` (in `global/skills/worktree-task/scripts/`)
- Updated `/implement` with `--worktree` flag — Step 0 auto-detects create vs resume
- Task artifacts: `manifest.json`, `checklist.json`, `PROGRESS.md` in `.state/<slug>/`

**Why:**
- Enable isolated parallel development via git worktrees
- Structured session handoff for long-running tasks (checklist + progress log)
- Safe merge-back with branch verification and checklist completion checks

**Key files:**
- `global/skills/worktree-task/SKILL.md`
- `global/skills/worktree-task/scripts/worktree-*.sh`
- `global/skills/implement/SKILL.md`

**Design docs:** `projects/active/worktree/final/plan.md`, `projects/active/worktree/long-running/final/plan.md`
