---
name: double-design
description: Two agents (Claude + Codex) independently design, cross-review, then align. Use for critical design decisions that benefit from diverse perspectives.
metadata:
  yaco-dependent: "true"
---

# Double Design

Two agents independently design, cross-review, then align via multi-round
discussion. The skill writes the
`<plan>/all/<project>/{initial,discussion,final}/` bundle layout and
coordinates `yaco agent` workers around it. Keep `<active>/<project>` as a
symlink view to the bundle home `<plan>/all/<project>` while the bundle is active.

**Paths:** resolve `<plan>`/`<active>` once with `yaco paths project --json`
(honors yaco.toml; see `/yaco-paths`) and substitute the resolved values into the
worker prompts below — don't hardcode `plan/`.

## Usage

`/double-design <project> "<goal/task description>"`

## Doc Structure

```
<plan>/all/<project>/
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
  final/                      # Aligned output — single-author quality (see /align Final Doc Quality Bar)
    *.md
    open_questions.md         # Optional: present when ≥3 open questions or any large one (see /align Open Questions)
```

## Process

All orchestration is done by the invoking agent via `yaco agent`.
Reuse sessions across steps (`yaco agent send`) to preserve context.
Every `yaco` invocation passes `--json`, using the canonical
`yaco agent start <provider>` form.

### Step 1: Independent Design

Start both agents in parallel. Each runs `/design` independently — no reading the other's output.

```bash
yaco agent start claude "Run /design for: <goal>. Write your design to <plan>/all/<project>/initial/design_claude.md. Do NOT read any other design files in that folder." --name claude-design --json
yaco agent start codex  "Run /design for: <goal>. Write your design to <plan>/all/<project>/initial/design_codex.md. Do NOT read any other design files in that folder." --name codex-design --json
```

Wait for both in parallel (provider-log waits, run in background, then read results):
```bash
yaco agent wait claude-design --from-start --json &
yaco agent wait codex-design  --from-start --json &
wait
```

### Step 2: Cross-Review

Send each agent the other's design for review. Reuse sessions for context continuity. Each `send --wait` captures the provider cursor before sending, so backgrounding both keeps the reviews running in parallel:

```bash
yaco agent send claude-design "Now read <plan>/all/<project>/initial/design_codex.md and write your review to <plan>/all/<project>/initial/design_review_claude.md. Focus on correctness, gaps, and design trade-offs. End the review by stating which design is the better base for the first aligned draft: CLAUDE or CODEX." --wait --json &
yaco agent send codex-design  "Now read <plan>/all/<project>/initial/design_claude.md and write your review to <plan>/all/<project>/initial/design_review_codex.md. Focus on correctness, gaps, and design trade-offs. End the review by stating which design is the better base for the first aligned draft: CLAUDE or CODEX." --wait --json &
wait
```

### Step 3: Align

Before starting `/align`, explicitly choose exactly one first mover. Do not send two "start writing now" prompts. The first mover initializes the alignment artifacts and writes the first draft; the other agent waits for its turn.

Choose the first mover from Step 2 cross-reviews: each review should state which design is the better base for the first aligned draft. If both reviews point to the same side, use that side as the first mover. If they disagree, the invoking agent makes the call, but the selection still must be explicit in both `/align` prompts.

The first draft must be conservative:

- Reflect consensus first, not the first mover's preferred design
- Avoid locking in unresolved choices too early
- Hold `final/*` to the `/align` Final Doc Quality Bar and record unresolved items as `/align` Open Question packets from the first draft

Send both agents into `/align` mode with the first mover explicitly assigned. Example below assumes the cross-reviews selected Claude.

```bash
yaco agent send claude-design "Run /align. Read all files in <plan>/all/<project>/initial/. You are CLAUDE. Alignment folder: <plan>/all/<project>/. Claude is the explicit first mover. If it is your turn, initialize alignment artifacts and write the first draft. That first draft must be conservative: capture consensus, avoid opinionated picks on unresolved questions, record every unresolved issue as a structured Open Question packet per /align Open Questions, and keep final/ to the /align Final Doc Quality Bar. Whenever an open question is resolved later, fold it into the design and delete the packet. If it is not your turn, wait." --json
yaco agent send codex-design  "Run /align. Read all files in <plan>/all/<project>/initial/. You are CODEX. Alignment folder: <plan>/all/<project>/. Claude is the explicit first mover. Do not start drafting unless 'yaco align wait' says it is your turn. Review the first draft for missing open questions, premature opinionated decisions, and places where the final design should better reflect actual consensus. Hold final/ to the /align Final Doc Quality Bar and Open Questions to the /align packet schema. Whenever an open question gets resolved later, fold it into the design and delete the packet." --json
```

If the cross-reviews pick Codex, swap the role assignment in both prompts. The key invariant is that exactly one side is named the first mover in both messages.

**Do NOT block-wait on alignment turns (`send --wait` or `agent wait`)** — it can deadlock. Agents self-poll via `yaco align wait` inside `/align`, but a session may go idle prematurely (stop polling) or its `wait` may return without resuming work. The invoking agent should manually monitor and nudge the side whose turn it is.

Minimal manual monitoring loop:

```bash
yaco align status <plan>/all/<project>/ --json
yaco agent status claude-design --json
yaco agent status codex-design  --json
```

If `yaco align status` reports `next=CLAUDE` and `yaco agent status claude-design --json` returns `idle`, send:

```bash
yaco agent send claude-design "It's your turn. Read the latest discussion files and continue /align." --json
```

If `yaco align status` reports `next=CODEX` and `yaco agent status codex-design --json` returns `idle`, send:

```bash
yaco agent send codex-design "It's your turn. Read the latest discussion files and continue /align." --json
```

Repeat until `yaco align status` reports `done=true` (`next=DONE`).

## Output

Final aligned design lands in `<plan>/all/<project>/final/*.md`.
Hand off to `/implement` when ready.

## Notes

- Both agents must NOT read each other's work during Step 1 — independent thinking is the whole point
- Session reuse (`send` instead of `start`) keeps prior context so agents build on their own reasoning
- Steps 1 & 2: blocking provider-log waits (`wait --from-start` for fresh starts, `send --wait` for follow-up turns) are safe (bounded tasks, agents will finish)
- Step 3: never block-wait — manually monitor `yaco align status` plus `yaco agent status`, then nudge the side whose turn it is if that session is idle
- Step 3: the first mover owns the first draft, but that draft should mostly record shared ground plus explicit open questions, not force unresolved choices
- Final-doc quality and the Open Question packet format are owned by `/align` (Final Doc Quality Bar, Open Questions); the Step 3 prompts already send both agents there. `final/*` stays self-contained — a resolved open question isn't done until folded into the body and its packet deleted.
