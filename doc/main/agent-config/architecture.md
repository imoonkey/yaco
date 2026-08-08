# Architecture

Centralized skill source for AI coding agents. One canonical tree, distributed by symlink to every tool that reads it.

## Multi-Tool Compatibility

| | Project config | Project skills | Global skills |
|---|---|---|---|
| **Claude Code** | `CLAUDE.md` | `.claude/skills/` | `~/.claude/skills/` |
| **Codex** | `AGENTS.md` | `.agents/skills/` | `~/.agents/skills/` |
| **Cursor** | `AGENTS.md` | reads `.claude/skills/` natively | reads `~/.claude/skills/` natively |
| **Gemini CLI** | `GEMINI.md` | TBD | TBD |

Each tool also reads a global instruction file from the user's home config. YACO does not supply one and never links one — see the additive rule below.

## Symlink Model

Everything is distributed via symlinks — never copied. `CLAUDE.md` and `.claude/` are canonical; all other tools read via symlinks.

**Global (via `yaco install`):**

| Canonical | Symlink |
|-----------|---------|
| `agent-config/global/skills/` | `~/.claude/skills/`, `~/.agents/skills/` |

The global install is **purely additive**: it plants skill directories and never claims a tool's global instruction file, so whatever global rules a user already wrote stay exactly as they wrote them.

**Per-project (via `/init-all`):**

| Canonical | Symlink |
|-----------|---------|
| `CLAUDE.md` | `AGENTS.md`, `GEMINI.md` |
| `.claude/` | `.agents/`, `.codex/` |

## Project CLAUDE.md

`<project>/CLAUDE.md` is the one instruction file this repo's model owns: stack, build commands, project-specific conventions.

- **No concatenation** — just symlinks. Each tool discovers its own config file name.
- **No global layer** — global rules, if a user keeps any, live in their own home config, outside this repo and outside YACO's install path.

## Skill Tiers

| Tier | Location | Examples |
|------|----------|----------|
| Global | `global/skills/` → `~/.claude/skills/` | implement, design, tdd, code-review, orchestrate, agent, ... |
| Project | Local `.claude/skills/` | Project-specific skills |

Skills that need stack-specific content (coding-standards, verify, qa) use `references/<stack>.md` and auto-detect the stack from marker files.

### implement ↔ orchestrate contract

Leaf execution — the implement / verify / review / fix / qa / doc recipe — is
defined **once**, as the fixed recipe in [`implement`](../../../agent-config/global/skills/implement/SKILL.md).
[`orchestrate`](../../../agent-config/global/skills/orchestrate/SKILL.md) does not
re-describe those steps; it dispatches a worker that runs `/implement <task>` and keeps
only the orchestration layer `/implement` has no concept of: selecting ready leaves (each
isolated in its own worktree), parallelizing, **gatekeeping** their output, **merging each
passed leaf up its worktree/branch DAG, and marking done only after that merge lands**. The
worker runs the full recipe but defers its "done" decision — orchestrate is the external
gatekeeper that, by **reading one `yaco gate` result** (the floor checks the diff owes —
verify/doc/review/qa — plus `dirty`) and the two overlays the diff-only gate can't see
(acceptCriteria, review independence), decides the work is *ready to merge*, never by
redoing it: a not-yet-met criterion (missing *or* failed) bounces back to the worker to keep
finishing its recipe, and only non-convergence (or a human-gate) blocks. This split is why a
change to leaf execution touches one file, not two. (Non-implementation leaves —
docs/design/planning — have no recipe and keep orchestrate's direct dispatch path.) The
git-worktree lifecycle is its own skill, [`yaco-worktree`](../../../agent-config/global/skills/yaco-worktree/SKILL.md),
which `/orchestrate` calls to resolve each leaf's cwd off its merge target, merge it up the
worktree/branch DAG (native git for child→parent, `yaco worktree merge` for →main), and clean up.

### yaco coupling (`metadata.yaco-dependent`)

Orthogonal to location, each global skill declares its relationship to the `yaco` CLI through a `metadata.yaco-dependent` frontmatter field (per the [Agent Skills spec](https://agentskills.io/specification), custom keys live under `metadata`). Absence is the default and means standalone.

| Value | Meaning | Skills |
|-------|---------|--------|
| `"true"` | Core mechanism calls `yaco` — cannot function without it | align, double-design, init-all, orchestrate, yaco-agent, yaco-task, yaco-worktree |
| `"optional"` | Runs in any repo; has an optional "Inside a YACO project" integration | design, office-hours, update-doc |
| *(absent)* | Standalone — pure workflow prompt, runs in any repo | everything else |

The field is inert metadata (no runtime reads it yet). It documents the split and lets future tooling export the yaco-independent set as a standalone bundle.

### Design decision: methodology skills are global

Skills like tdd, code-review, orchestrate teach **process**, not tooling. The agent already knows the project's language from CLAUDE.md. Only coding-standards and verify need per-stack reference files.

## References

- [Claude Code docs](https://code.claude.com/docs/en/memory)
- [Agent Skills spec](https://agentskills.io/specification)
- [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Cursor rules](https://cursor.com/docs/context/rules)
