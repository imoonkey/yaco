---
name: double-design
description: Two agents (Claude + Codex) independently design, cross-review, then align. Use for critical design decisions that benefit from diverse perspectives.
---

# Double Design

This skill is YACO-native: it writes the `projects/active/<project>/{initial,discussion,final}/` bundle layout and coordinates `yaco agent` workers around it.

Two agents independently design, cross-review, then align via multi-round discussion.

## Usage

`/double-design <project> "<goal/task description>"`

## Doc Structure

```
projects/active/<project>/
  initial/
    design_claude.md          # Step 1: independent designs (can be multiple docs for large design rather than one only)
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

All orchestration is done by the invoking agent via `yaco agent`.
Reuse sessions across steps (`yaco agent send`) to preserve context.
Every `yaco` invocation passes `--json` (per skill CLI contract); the
top-level provider shortcut (the one-word `yaco <provider>` form) is
reserved for human typing and is NOT used here.

### Step 1: Independent Design

Start both agents in parallel. Each runs `/design` independently — no reading the other's output.

```bash
yaco agent start claude "Run /design for: <goal>. Write your design to projects/active/<project>/initial/design_claude.md. Do NOT read any other design files in that folder." --name claude-design --json
yaco agent start codex  "Run /design for: <goal>. Write your design to projects/active/<project>/initial/design_codex.md. Do NOT read any other design files in that folder." --name codex-design --json
```

Wait for both in parallel (run captures in background, then read results):
```bash
yaco agent capture claude-design --wait --json &
yaco agent capture codex-design  --wait --json &
wait
```

### Step 2: Cross-Review

Send each agent the other's design for review. Reuse sessions for context continuity.

```bash
yaco agent send claude-design "Now read projects/active/<project>/initial/design_codex.md and write your review to projects/active/<project>/initial/design_review_claude.md. Focus on correctness, gaps, and design trade-offs. End the review by stating which design is the better base for the first aligned draft: CLAUDE or CODEX." --json
yaco agent send codex-design  "Now read projects/active/<project>/initial/design_claude.md and write your review to projects/active/<project>/initial/design_review_codex.md. Focus on correctness, gaps, and design trade-offs. End the review by stating which design is the better base for the first aligned draft: CLAUDE or CODEX." --json
```

Wait for both in parallel:
```bash
yaco agent capture claude-design --wait --json &
yaco agent capture codex-design  --wait --json &
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
yaco agent send claude-design "Run /align. Read all files in projects/active/<project>/initial/. You are CLAUDE. Alignment folder: projects/active/<project>/. Claude is the explicit first mover. If it is your turn, initialize alignment artifacts and write the first draft. That first draft must be conservative: capture consensus, avoid opinionated picks on unresolved questions, and end with an Open Questions section listing every unresolved issue. Whenever any open question gets resolved later, update the self-contained final design first, then remove or revise the corresponding open question. If it is not your turn, wait." --json
yaco agent send codex-design  "Run /align. Read all files in projects/active/<project>/initial/. You are CODEX. Alignment folder: projects/active/<project>/. Claude is the explicit first mover. Do not start drafting unless status.txt says it is your turn. Review the first draft for missing open questions, premature opinionated decisions, and places where the final design should better reflect actual consensus. Whenever any open question gets resolved later, update the self-contained final design first, then remove or revise the corresponding open question." --json
```

If the cross-reviews pick Codex, swap the role assignment in both prompts. The key invariant is that exactly one side is named the first mover in both messages.

**Do NOT use `capture --wait` here** — it can deadlock. Agents self-poll via `/align`, but may go idle prematurely (especially Codex). The invoking agent should manually monitor and nudge the side whose turn it is.

Minimal manual monitoring loop:

```bash
cat projects/active/<project>/discussion/status.txt
yaco agent status claude-design --json
yaco agent status codex-design  --json
```

If `status.txt` says `NEXT=CLAUDE` and `yaco agent status claude-design --json` returns `idle`, send:

```bash
yaco agent send claude-design "It's your turn. Read the latest discussion files and continue /align." --json
```

If `status.txt` says `NEXT=CODEX` and `yaco agent status codex-design --json` returns `idle`, send:

```bash
yaco agent send codex-design "It's your turn. Read the latest discussion files and continue /align." --json
```

Repeat until `status.txt` reaches `NEXT=DONE`.

## Output

Final aligned design lands in `projects/active/<project>/final/*.md`.
Hand off to `/implement` when ready.

## Notes

- Both agents must NOT read each other's work during Step 1 — independent thinking is the whole point
- Session reuse (`send` instead of `start`) keeps prior context so agents build on their own reasoning
- Steps 1 & 2: `capture --wait` is safe (bounded tasks, agents will finish)
- Step 3: never `capture --wait` — manually monitor `status.txt` plus `yaco agent status`, then nudge the side whose turn it is if that session is idle
- Step 3: the first mover owns the first draft, but that draft should mostly record shared ground plus explicit open questions, not force unresolved choices
- Final output must remain self-contained throughout alignment; resolving an open question is not complete until the resolved design is reflected in `final/*.md`
