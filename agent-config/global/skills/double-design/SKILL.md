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
multmux send claude-design "Now read doc/todo/<project>/initial/design_codex.md and write your review to doc/todo/<project>/initial/design_review_claude.md. Focus on correctness, gaps, and design trade-offs."
multmux send codex-design "Now read doc/todo/<project>/initial/design_claude.md and write your review to doc/todo/<project>/initial/design_review_codex.md. Focus on correctness, gaps, and design trade-offs."
```

Wait for both in parallel:
```bash
multmux capture claude-design --wait &
multmux capture codex-design --wait &
wait
```

### Step 3: Align

Send both agents into `/align` mode.

```bash
multmux send claude-design "Run /align. Read all files in doc/todo/<project>/initial/ and start alignment. You are CLAUDE. Alignment folder: doc/todo/<project>/. You go first."
multmux send codex-design "Run /align. Read all files in doc/todo/<project>/initial/ and start alignment. You are CODEX. Alignment folder: doc/todo/<project>/. Wait for your turn."
```

**Do NOT use `capture --wait` here** — it can deadlock. Agents self-poll via `/align`, but may go idle prematurely (especially Codex). Run the monitor script to detect idle agents and nudge them:

```bash
./scripts/align_monitor.sh doc/todo/<project>/discussion/status.txt claude-design codex-design
```

## Output

Final aligned design lands in `doc/todo/<project>/final/*.md`.
Hand off to `/implement` when ready.

## Notes

- Both agents must NOT read each other's work during Step 1 — independent thinking is the whole point
- Session reuse (`send` instead of `start`) keeps prior context so agents build on their own reasoning
- Steps 1 & 2: `capture --wait` is safe (bounded tasks, agents will finish)
- Step 3: never `capture --wait` — use `align_monitor.sh` to avoid deadlock
