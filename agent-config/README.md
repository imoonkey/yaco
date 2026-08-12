# agent-config

The workflow skills the `yaco` CLI installs — layer 2 of the stack. Twenty-two
of them encode a development loop (`/design`, `/implement`, `/orchestrate`,
`/verify`, …) and drive the `yaco` subcommands built for it: `yaco task`,
`yaco worktree`, `yaco plan`, `yaco gate`. Not a library of prompts to browse.

## How they get installed

```bash
tools/install.sh   # from a clone — packs and installs yaco-cli, then configures
yaco install       # from the npm package — configures only
```

`tools/install.sh` ends by running `yaco install`, so both paths land the same
things. (`setup.sh` here forwards to `tools/install.sh --cli-only`.)

| Destination | What |
|---|---|
| `~/.claude/skills/<name>` | one symlink per shipped skill |
| `~/.agents/skills` | symlink to `~/.claude/skills` — the tool-neutral path |
| `~/.claude/settings.json`, `~/.codex/hooks.json` | yaco's hook entries, merged in |
| `~/.yaco/agent-wrapper.sh` | the session wrapper |

Two tools: **Claude Code** and **Codex** — the providers yaco registers.
Per-project multi-tool shims (`AGENTS.md`, `GEMINI.md`, `.agents/`, `.codex/`)
are a separate step, `yaco init links`, driven by `/init-all`.

The install is **additive**. `~/.claude/skills` is a real directory yaco merges
into: your own skills there are untouched, a same-name entry that is not a yaco
symlink is kept and reported (never clobbered, not even with `--force`), a link
pointing somewhere yaco doesn't own is skipped, and install never writes a
global `~/.claude/CLAUDE.md`.

## The skills

| Skill | What it does |
|---|---|
| **Design & plan** | |
| `/design` | System design from first principles — write the doc, self-review, iterate |
| `/double-design` | Claude and Codex design independently, cross-review, then align |
| `/eng-plan-review` | Review an implementation plan before any code is written |
| `/discuss` | Answer `>`-marked comments in place inside a markdown doc |
| `/align` | Reconcile a design between Codex and Claude |
| **Build** | |
| `/implement` | The full loop: plan, phased build with review, verify |
| `/tdd` | Tests first, then the implementation |
| `/investigate` | Root-cause a bug before fixing it |
| `/orchestrate` | Run ready tasks from the task graph as `yaco agent` workers |
| **Review, verify, record** | |
| `/code-review` | Severity-graded review findings |
| `/verify` | Build, lint, test, security — stack detected automatically |
| `/qa` | E2E and integration QA of the user flows a change touches |
| `/update-doc` | Sync docs and changelog with the code |
| `/impl-summary` | Summarize landed work by outcome and structure, not by commit |
| **YACO CLI companions** | |
| `/yaco-agent` | Agent session lifecycle: start, send, wait, list, link |
| `/yaco-task` | The per-repo task graph: milestones, tasks, progress |
| `/yaco-worktree` | One task, one checkout — create, merge, clean up |
| **Always on** | |
| `/coding-standards` | Conventions and stack idioms, applied while writing code |
| `/simplify-code-arch` | Subtractive KISS — challenge every abstraction before adding it |
| `/ultra-think` | Push past the first solution that merely works |
| `/yaco-paths` | Where docs, task graphs, and archives belong in a YACO project |
| **Onboarding** | |
| `/init-all` | Set a repo up for multi-agent work: `CLAUDE.md`, symlinks, `doc/` |

## Layout

```
global/skills/<name>/SKILL.md              the skill
global/skills/<name>/references/<stack>.md stack-specific material
global/skills/<name>/scripts/              a helper, only when one is unavoidable
```

`references/` is used today by `coding-standards`, `verify` and `qa`; `scripts/`
by `update-doc` alone. `CLAUDE.md` (with `AGENTS.md` symlinked to it) holds the
local rules.

## Editing them

This directory is the source; everything downstream is a copy or a link to one.
`cli/scripts/sync-agent-config.mjs` mirrors `global/` into the CLI package at
build time — npm cannot pack a path outside the package directory — and the
`~/.claude/skills` links point at that packaged copy. So **every change takes a
rebuild and reinstall**, a one-line edit no less than a new skill or a rename:

```bash
cd cli && npm run reinstall
```

Never edit through the link. The file under `~/.claude/skills/<name>/` belongs
to the installed package, and the next install overwrites it.

Ship a skill here only if yaco itself needs it — a CLI companion, or part of
the `/orchestrate` runtime closure. Personal-workflow skills belong in your own
repo, linked into `~/.claude/skills` beside yaco's; project-specific skills stay
in that project's `.claude/skills/`.

## Fork it

This layer is the least settled, on purpose: nobody — us included — knows the
right way to work with coding agents yet. These skills are a starting point to
edit, not doctrine.

- [../doc/main/agent-config/README.md](../doc/main/agent-config/README.md) — architecture and contracts.
- [../doc/dev/agent-config/workflow.md](../doc/dev/agent-config/workflow.md) — how to add and maintain a skill.
