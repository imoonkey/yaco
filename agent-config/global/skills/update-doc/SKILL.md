---
name: update-doc
description: Sync docs with code changes and maintain changelog. Use after architecture/workflow changes, before or after commits.
---

# Update Doc

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

### doc/dev/ Guidelines

- **Keep it lean.** dev/ is for practical how-to: setup, build, test, lint, run commands, and development workflow. Architecture belongs in main/, not here.
- **Typical files:** `workflow.md` or `guide.md` (dev setup + commands), plus specialized guides as needed (e.g., `adding-sites.md`, `visual_debug_guide.md`).
- **No plans or design docs.** Implementation plans go in the project's design-doc folder, not dev/.

## Doc Quality Bar

One axiom; the rest are corollaries — hold every `doc/main/` file to the axiom and the others follow.

**Axiom — MDL (minimal description length).** A doc is a *lossy compressor* of the code (the ground truth). It earns its existence only by lowering a reader's **total** cost-to-understand = *reading the doc* + *recovering from code whatever the doc omitted*. Minimize that sum: carry **exactly the residual — information expensive to recover from code and cheap to state**, nothing else. The source moves, so a doc is valid only against current code — re-check on every change (Process step 3).

**What to carry**

- **Earn every word — depth tracks information, not lines.** Include a fact only if a competent reader couldn't cheaply predict it from the code *and know it's right* (high **surprisal**). Restating what the code already shows is *worse* than the code — cut it, `-> See:` the source. One line can deserve a paragraph (a constant distilled from heavy analysis; the path that survived ten tries); ten obvious lines deserve none. The residual you keep has two sources:
  - **structural** — latent in code, recoverable only by a global read → state the conclusion (an invariant, a contract, the shape);
  - **provenance** — not in the code at all (the *why*, the rejected alternatives, a constant's origin, a landmine) → record it.

**Where it goes**

- **Scope picks the artifact.** Co-locate a fact with the smallest thing that owns it, or it detaches and rots: local to one line → a **code comment**; governing a module / subsystem / system → a **doc**. (Structural facts are inherently cross-cutting → always docs.)
- **Compress in layers → progressive disclosure.** A system is too big to compress in one shot: code → module doc → subsystem README → `architecture.md`, each layer keeping only what holds across everything below it. One pyramid, two directions:
  - *read* top-down — start at max compression, descend only as far as you need (a reader after the shape never wades through leaf invariants);
  - *author* bottom-up — each layer abstracts the one beneath it.
- **One owner per fact.** A fact lives at the *highest layer that still governs everything below*, and only there — hoist a subsystem-wide rule out of its leaves, push a leaf-only detail out of the README. Everyone else `-> See:` it (a pointer costs ~0 bits); two copies are two things to keep true, and one will drift. For a multi-doc area, hold a fact-ownership map.
- **Parent says what, child says how; structure over prose.** The higher layer carries the abstraction (a piece + its seam); the lower carries the mechanism. Lead with the shape in its densest faithful form — mermaid, table, phase-list, state machine — and reserve prose for rationale, where words are the densest encoding.

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

**Operational reminders:**
- Local skills live in `./.claude/skills/` (`./.agents/skills/` is a symlink) — edit the real location, not the symlink.
- If behavior or workflow changed and a local skill teaches it, update the skill in the same pass, and keep its `scripts/` in sync with the `SKILL.md`.
- Update the `Last updated` line / commit hash on touched docs.

### 3. Verify SOTA Docs

- **Cross-check claims against code, not the old prose.** A doc update is the moment to re-validate: for each load-bearing claim — orderings, thresholds, function/flag names, counts — confirm it against source and fix the drift. Docs drift silently; this is where you catch it. A delegated writer must *report* drift found, never just reshuffle stale prose.
- **Run the mechanical checks.** `scripts/check-docs.py [doc]` resolves every relative link, balances/validates mermaid fences, and (with `--stale <old-path>…`) greps for paths left behind by a rename. Fix every hit before committing.
- **Catch what the script can't:** grep for renamed symbols/classes mentioned in prose (not just links), and confirm any referenced file / class / script still exists.
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
