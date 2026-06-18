---
name: update-doc
description: Sync docs with code changes and maintain changelog. Use after architecture/workflow changes, before or after commits.
---

# Update Doc

Keep documentation in sync with code. Maintain a living changelog as project memory.

## Usage

`/update-doc [scope or commit range]`

## Doc Structure (all projects)

```
doc/
  main/                    # SOTA memory: architecture, runtime, system overview
    README.md              # Navigation hub: doc map, reading order, key concepts
    <domain>/              # Subdirectories mirror code architecture
  dev/                     # SOTA memory: dev workflow, build, tooling
  PROGRESS.md              # History trace

.claude/
  skills/
    <skill>/               # Project-local skill: instructions that must match reality
      SKILL.md
      process.*            # Optional process/runbook referenced by the skill
      scripts/             # Optional helper scripts used by the skill

.agents/
  skills/ -> .claude/skills/   # Optional symlink alias
```

- `doc/main/`, `doc/dev/`, `CLAUDE.md` (symlinked as `AGENTS.md`, `GEMINI.md`), and project-local skills in `./.claude/skills/*` (symlinked as `./.agents/skills/*`) are **SOTA memory** — always reflect current best understanding. Update the canonical file, not the symlinks.
- `doc/PROGRESS.md` is **history trace** — what happened and when, so future context windows can catch up.

### doc/main/ Guidelines

- **README.md as nav hub.** Every project should have `doc/main/README.md` with a documentation map, reading order, and key concepts table. This is the entry point for any agent or human exploring the project.
- **Mirror code architecture.** Organize files into subdirectories that reflect the code's domain structure (e.g., `agent/`, `infra/`, `ui/`, `backend/`, `frontend/`). Flat is fine for ≤5 files, but group by domain once it grows beyond that.
- **Split by concerns, not just size.** Give a module its own subdirectory — a short spine `README.md` plus focused leaf docs — once it covers **≥~4 cohesive sub-topics or exceeds ~300 lines**, whichever comes first. A 200-line doc spanning five concerns still splits; a 280-line doc on one concern need not. A monolith is harder to keep current than focused leaves.
- **Cross-reference, don't duplicate.** Use `-> See: path/to/file` pointers. If the same concept is explained in two places, one will go stale.

### doc/dev/ Guidelines

- **Keep it lean.** dev/ is for practical how-to: setup, build, test, lint, run commands, and development workflow. Architecture belongs in main/, not here.
- **Typical files:** `workflow.md` or `guide.md` (dev setup + commands), plus specialized guides as needed (e.g., `adding-sites.md`, `visual_debug_guide.md`).
- **No plans or design docs.** Implementation plans go in the project's design-doc folder, not dev/.

## Doc Quality Bar

SOTA docs aren't just *in sync* with the code — they're its **minimal, well-architected compression**. Hold every `doc/main/` file to these:

- **Top-down, progressive disclosure.** Each doc explains *one* architectural level in the simplest correct language, then points down. The parent says **what** a piece is and the seam to its neighbors; the child says **how**. A reader after the shape must never wade through leaf invariants to find it.
- **MDL — earn every word.** A doc is a *proxy* for the code, which is the ground truth (and can itself be wrong or stale). Its only value is **compression**: a passage that doesn't compress what the code already states cheaply is *worse* than the source — cut it and `-> See:` the code instead. Spend the saved space on the **high-entropy** knowledge the code *cannot* carry — the *why*, the alternatives tried and rejected, the provenance of a tuned constant, a non-obvious invariant or landmine. One line of code can deserve a paragraph (a parameter distilled from heavy analysis; the one path that survived ten tries); ten self-evident lines may deserve none. **Depth tracks information-not-recoverable-from-code, not lines-of-code.**
- **One owner per fact.** Every fact lives in exactly one doc; everyone else points with `-> See:`. Duplication is how docs rot — the same rule written twice will diverge. For any multi-doc area, hold a fact-ownership map (who owns what) so writers state vs. point deliberately.
- **Structured over prose.** Prefer a mermaid diagram, table, ordered phase-list, or state machine to a paragraph whenever it carries the logic more clearly — mermaid is one tool, not the only one; reach for whatever semi-structured form maximizes logical clarity. Lead a doc with its shape (diagram/table), then add prose only for rationale.

### Doc skeleton

Most `doc/main/` files follow this shape — adapt it, don't force it:

```
# Title

> One-sentence essence of what this is.

Last updated: YYYY-MM-DD · Code: `src/<dir>/` · Parent: [<name>](<relpath>)

<a mermaid diagram OR table of this layer's shape — its pieces + the seam above/below>

## <one section per piece>
WHAT it is + the one non-obvious rule. Deeper detail -> See: <path>.

## Invariants     (only the ones THIS doc owns)

## -> See
parent · siblings · children
```

## Process

### 1. Analyze Changes

```bash
git diff --name-only <baseline>..HEAD
```

If no baseline given, use the last docs/local-skill update commit or recent commits.

### 2. Update SOTA Docs

Map code changes to affected docs in `CLAUDE.md`, `doc/main/`, `doc/dev/`, and any project-local skill exposed via the project's local skill directory. Apply the **Doc Quality Bar** above to anything you write.

**Principles:**
- Match the detail level of surrounding content
- Prefer `-> See: path/to/file` pointers over large code blocks
- Link rather than duplicate explanations
- Don't over-document tiny new details, unless they are really important pitfalls or non-obvious logic.
- Local skills live in `./.claude/skills/` (`./.agents/skills/` is a symlink to it). Update the real location (`.claude/skills/`), not the symlink.
- If behavior or workflow changed and a local skill teaches that behavior, update the skill in the same pass.
- When a local skill has `scripts/`, keep those artifacts in sync with the `SKILL.md` instructions.
- Update timestamps/commit hashes on touched docs

### 3. Verify SOTA Docs

- **Cross-check claims against code, not the old prose.** A doc update is the moment to re-validate: for each load-bearing claim — orderings, thresholds, function/flag names, counts — confirm it against source and fix the drift. Docs drift silently; this is where you catch it. A delegated writer must *report* drift found, never just reshuffle stale prose.
- **Run the mechanical checks.** `scripts/check-docs.py [doc]` resolves every relative link, balances/validates mermaid fences, and (with `--stale <old-path>…`) greps for paths left behind by a rename. Fix every hit before committing.
- Search for removed/renamed symbols in docs and local skills
- Verify referenced files/classes/scripts still exist
- For touched local skills, verify the documented process still resolves to real commands and paths
- If you changed a local skill's `scripts/`, run the narrowest meaningful smoke check so the script still works after the doc/process update

### 4. Update Progress Doc

Prepend to `doc/PROGRESS.md` (create if missing). This is the **canonical format** — all entries follow it. PROGRESS is **append-only**: never edit a past entry, even when a restructure renames the files it references — an entry records what was true on its date.

```markdown
## YYYY-MM-DD: [Short title]

**What changed:**
- [Key changes, decisions, new components]

**Why:**
- [Motivation, problem solved, trade-off chosen]

**Key files:** [list main files affected]
**Verification:** [what was verified and how, e.g. `./gradlew build` passed]
**Commit:** [short hash or range]
**Next:** [what to work on next, if applicable]
**Blockers:** [any blockers, or None]
```

Keep entries concise. One entry per logical change, not per commit.

### 5. Commit Docs

Stage only the files touched by this `/update-doc` run — don't sweep in unrelated uncommitted docs.

```bash
git add <files you created or updated in steps 2–4>
git commit -m "docs: <short description of what changed>"
```

## Large Rewrites (multi-agent)

A full `doc/` rewrite or restructure outgrows the single-threaded Process — fan it out:

1. **Confirm the target tree first.** Decide the doc tree (files, subdirs, what splits or merges) and any scope forks *before* generating content — a wrong shape wastes every downstream write. Get sign-off when the user has opinions about structure.
2. **Write the anchor docs yourself.** The top `README.md` + architecture doc set the voice, the skeleton, and the cross-cutting compression decisions. They become the worked example every other writer matches.
3. **Fan out one subagent per subtree.** Give each the same **doc skeleton + Doc Quality Bar + the fact-ownership map** verbatim, plus its files to write and the code to read. Disjoint file sets run in parallel.
4. **Every subagent cross-checks live code** and reports drift found (step 3) — no writer merely reshuffles old prose.
5. **You own the seams.** Before committing, verify cross-references resolve, mermaid renders, renamed/old files are deleted, and the fact-ownership map held (no duplication). Run `scripts/check-docs.py`.

Scope this to genuine rewrites; a 1–2 file sync uses the plain Process.
