---
name: double-design
description: Two agents (Claude + Codex) independently design, cross-review, then align. Use for critical design decisions that benefit from diverse perspectives.
---

# Double Design

Two agents independently design, cross-review, then align via multi-round discussion.

## Usage

`/double-design <project> "<goal/task description>"`

## Doc Structure

```
doc/todo/<project>/
  initial/
    design_claude.md          # Step 1: independent designs
    design_codex.md
    design_review_claude.md   # Step 2: cross-reviews
    design_review_codex.md
  discussion/                 # Step 3: /align artifacts
    status.txt
    0001_CODEX.md
    0002_CLAUDE.md
    ...
  final/                      # Aligned output
    *.md
```

## Process

All orchestration is done by the invoking agent via `multmux`.
Reuse sessions across steps (`multmux send`) to preserve context.

When this doc references `./scripts/...`, that path is relative to the installed skill directory, not the repo cwd. If an agent seems likely to misread that, resolve the installed skill directory first or use an absolute installed path as a fallback.

### Step 1: Independent Design

Start both agents in parallel. Each runs `/design` independently — no reading the other's output.

```bash
multmux start claude "Run /design for: <goal>. Write your design to doc/todo/<project>/initial/design_claude.md. Do NOT read any other design files in that folder." --name claude-design
multmux start codex "Run /design for: <goal>. Write your design to doc/todo/<project>/initial/design_codex.md. Do NOT read any other design files in that folder." --name codex-design
```

Wait for both in parallel (run captures in background, then read results):
```bash
multmux capture claude-design --wait &
multmux capture codex-design --wait &
wait
```

### Step 2: Cross-Review

Send each agent the other's design for review. Reuse sessions for context continuity.

```bash
multmux send claude-design "Now read doc/todo/<project>/initial/design_codex.md and write your review to doc/todo/<project>/initial/design_review_claude.md. Focus on correctness, gaps, and design trade-offs. End the review by stating which design is the better base for the first aligned draft: CLAUDE or CODEX."
multmux send codex-design "Now read doc/todo/<project>/initial/design_claude.md and write your review to doc/todo/<project>/initial/design_review_codex.md. Focus on correctness, gaps, and design trade-offs. End the review by stating which design is the better base for the first aligned draft: CLAUDE or CODEX."
```

Wait for both in parallel:
```bash
multmux capture claude-design --wait &
multmux capture codex-design --wait &
wait
```

### Step 3: Align

Before starting `/align`, explicitly choose exactly one first mover. Do not send two "start writing now" prompts. The first mover initializes the alignment artifacts and writes the first draft; the other agent waits for its turn.

Choose the first mover from Step 2 cross-reviews: each review should state which design is the better base for the first aligned draft. If both reviews point to the same side, use that side as the first mover. If they disagree, the invoking agent makes the call, but the selection still must be explicit in both `/align` prompts.

The first draft must be conservative:

- Reflect consensus first, not the first mover's preferred design
- Avoid locking in unresolved choices too early
- Keep unresolved items in a dedicated `Open Questions` section at the bottom of the final design
- When an open question is resolved in later rounds, update the self-contained final design above to incorporate the resolution, then remove or rewrite that open question accordingly

Send both agents into `/align` mode with the first mover explicitly assigned. Example below assumes the cross-reviews selected Claude.

```bash
multmux send claude-design "Run /align. Read all files in doc/todo/<project>/initial/. You are CLAUDE. Alignment folder: doc/todo/<project>/. Claude is the explicit first mover. If it is your turn, initialize alignment artifacts and write the first draft. That first draft must be conservative: capture consensus, avoid opinionated picks on unresolved questions, and end with an Open Questions section listing every unresolved issue. Whenever any open question gets resolved later, update the self-contained final design first, then remove or revise the corresponding open question. If it is not your turn, wait."
multmux send codex-design "Run /align. Read all files in doc/todo/<project>/initial/. You are CODEX. Alignment folder: doc/todo/<project>/. Claude is the explicit first mover. Do not start drafting unless status.txt says it is your turn. Review the first draft for missing open questions, premature opinionated decisions, and places where the final design should better reflect actual consensus. Whenever any open question gets resolved later, update the self-contained final design first, then remove or revise the corresponding open question."
```

If the cross-reviews pick Codex, swap the role assignment in both prompts. The key invariant is that exactly one side is named the first mover in both messages.

**Do NOT use `capture --wait` here** — it can deadlock. Agents self-poll via `/align`, but may go idle prematurely (especially Codex). The invoking agent should manually monitor and nudge the side whose turn it is.

Minimal manual monitoring loop:

```bash
cat doc/todo/<project>/discussion/status.txt
multmux status claude-design
multmux status codex-design
```

If `status.txt` says `NEXT=CLAUDE` and `multmux status claude-design` returns `idle`, send:

```bash
multmux send claude-design "It's your turn. Read the latest discussion files and continue /align."
```

If `status.txt` says `NEXT=CODEX` and `multmux status codex-design` returns `idle`, send:

```bash
multmux send codex-design "It's your turn. Read the latest discussion files and continue /align."
```

Repeat until `status.txt` reaches `NEXT=DONE`.

## Output

Final aligned design lands in `doc/todo/<project>/final/*.md`.
Hand off to `/implement` when ready.

## Notes

- Both agents must NOT read each other's work during Step 1 — independent thinking is the whole point
- Session reuse (`send` instead of `start`) keeps prior context so agents build on their own reasoning
- Steps 1 & 2: `capture --wait` is safe (bounded tasks, agents will finish)
- Step 3: never `capture --wait` — manually monitor `status.txt` plus `multmux status`, then nudge the side whose turn it is if that session is idle
- Step 3: the first mover owns the first draft, but that draft should mostly record shared ground plus explicit open questions, not force unresolved choices
- Final output must remain self-contained throughout alignment; resolving an open question is not complete until the resolved design is reflected in `final/*.md`
