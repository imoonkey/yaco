---
name: implement
description: Full implementation workflow — plan, phased build with review loops, verify. Use for any non-trivial feature or system design.
---

# Implement

Given a goal or task (system design, feature, refactor), drive it from plan to done.

## Usage

`/implement [goal or task reference]`

Accepts either a freeform **goal** or a **task reference** (a task id or design-doc
path). A goal is taskless — write your plan to a file (Step 1) and go; you do not need a
task-graph entry. A task reference already carries scope · acceptCriteria · depends —
read it as your contract.

## Principles

Think like Linus Torvalds. Beyond the global rules (KISS, minimal redundancy, edge→canonical, readability, no backward compat, read existing code first): use `/ultra-think` for critical or complex design decisions.

## The recipe

The steps are a **fixed flow**. *How* you run each one — the prompt, whether you spawn
a subagent, which tools — is self-directed; the shape is not. **Every step that names a
skill MUST invoke it** — including the boring tail (`/qa`, `/update-doc`).

```mermaid
flowchart TB
  D["Design & Plan<br/>(understand goal/task-ref · write plan)"]
  I["Implement<br/>(subagent ok · MUST /tdd · /coding-standards as warranted)"]
  V["Verify<br/>(MUST /verify: build · lint · test · security — fast, run first)"]
  R["Code Review<br/>(independent reviewer runs MUST /code-review → artifact · cross-provider when feasible)"]
  F["Fix<br/>(change code, or next round persuade the reviewer)"]
  C["Commit<br/>(per phase · clean-state)"]
  Q["E2E Verify<br/>(MUST /qa affected flows)"]
  FC["Completeness Check<br/>(re-read vs goal · find missing scope · loop)"]
  U["Update Docs<br/>(MUST /update-doc)"]
  X{"Finish"}
  D --> I --> V
  V -->|fail| F --> I
  V -->|green| R
  R -->|critical/high| F
  R -->|clean| C
  C -->|more phases| I
  C -->|all phases done| Q --> FC --> U --> X
```

Within a phase, **`/verify` and `/code-review` are peer gates** on the commit — both must
pass, and you run `/verify` first because it's deterministic and fast, so it fails before
you spend a reviewer on code that doesn't build. `/qa` is a different gate at a different
cadence: the end-to-end check over **affected user flows**, run **once after all phases
land** — not a per-phase peer. `/verify` (unit-level build · lint · test · security) and
`/qa` (E2E) never substitute for each other.

## Step 1: Design & Plan

Write a plan to a file — phases, affected files, key design decisions.

- Large scope → multiple phases; reasonable scope → a single phase
- Each phase must be independently committable

## Step 2: Phased Execution

Run 2.1 → 2.5 for each phase.

### 2.1 Implement
- Execute the phase, ideally in a fresh subagent for context cleanliness
- Use `/coding-standards` and `/tdd` (**MUST USE the mentioned skills**) when the logic warrants it

### 2.2 Verify
- Run `/verify` (**MUST USE**) — build · lint · test · security. Get it green before review.

### 2.3 Code Review
- Run `/code-review` (**MUST USE**) with an **independent reviewer**.
  - **Minimum:** independent context — a fresh subagent that did not write the code.
  - **Preferred (cross-provider, when feasible):** a *different provider* reviews — a
    Claude worker starts a Codex reviewer, and vice versa, via
    `yaco agent start <opposite-provider> "..." --wait` then `yaco agent kill`
    (start → wait → kill). Nested sub-sessions are supported (spawnedBy/parentSession),
    so a worker may spawn its own reviewer. A reviewer of the same provider but separate
    context is the fallback when cross-provider isn't available.
- Write the review **artifact** to the same folder as the design doc (or project root), with a header that makes it verifiable evidence — not just prose: **reviewer** (handle / provider), the **base SHA and scope** it reviewed, **verdict**, and **unresolved critical/high count**. Anyone (or any gate) can then confirm the review covers the work and trust it by reading, without re-running it.

### 2.4 Fix
- Address `/verify` failures and `/code-review` issues (change the code, or in the next round persuade the reviewer the finding is wrong). Loop 2.1–2.4 until **both** gates are green.

### 2.5 Commit
- Git commit after every phase finishes.
- **Clean-state rule**: every commit must leave the branch buildable.

## Step 3: E2E Verification

Run `/qa` (**MUST USE**) to verify affected user flows end-to-end. `/qa` analyzes changes, derives impacted flows, and verifies with stack-appropriate tools (Playwright, HTTP calls, CLI tests).

## Step 4: Completeness Check

Re-read the whole diff against the original goal/task and hunt for **missing scope** — acceptance criteria or pieces you never built. This is a coverage gate, not a bug hunt: `/code-review`, `/verify`, and `/qa` all check *what's present*; only this step catches what's **absent**.

**If anything is missing, loop back to Step 1, re-plan for the gap, and continue.** The job is the *whole* targeted scope, not the first green phase — "looks done" on the parts you built is precisely the trap this step exists to catch.

## Step 5: Update Docs

Run `/update-doc` (**MUST USE**) to sync `doc/main/`, `doc/dev/`, project-local skills in `./.claude/skills/*`, and `doc/PROGRESS.md` with the changes.

## Finish

`/implement` is done when the targeted scope is fully implemented, verified, and
documented, and you have stopped. Producing that finished state is the whole job;
recording task-graph status is outside its scope.

## Context Management

- Use TodoWrite to track phases and progress
- Use subagents to keep context windows fresh
- Compact context at phase boundaries when needed
