---
name: scope-review
description: Challenge problem framing and feature scope before design or implementation. Use when the user has a feature idea, rough plan, PRD, or asks whether something is the right problem, the right size, or the right MVP. Prefer this skill before `/ux-design`, `/design`, or `/implement` when scope is still fuzzy.
---

# Scope Review

Pressure-test the problem and scope before locking in a solution.

The goal is not to brainstorm endlessly. The goal is to decide what should be built now, what should be deferred, and what should be reframed entirely.

## Usage

`/scope-review [feature idea, rough plan, PRD, or task description]`

## Output

Always produce these sections:

- **Problem** — the real user or business problem, not just the requested feature
- **Current leverage** — existing code, workflows, or product behaviors that already solve part of it
- **Scope options** — expanded, right-sized, and reduced versions
- **Recommendation** — which scope to choose now, and why
- **Not now** — explicitly deferred work
- **Open questions** — only decisions that actually block design

## Process

### 1. Clarify the Real Problem

- What outcome does the user actually want?
- Is the request a direct solution, or just one possible proxy?
- What happens if we do nothing?
- What pain is real today versus hypothetical?

Do not accept the framing blindly if the requested feature is solving the wrong problem.

### 2. Read Existing Context

- Read the relevant code, docs, TODOs, and existing workflows first
- Identify what already exists that partially solves the problem
- Prefer extending an existing path over creating a parallel system

List concrete reuse opportunities, not vague statements.

### 3. Review Through Three Scope Lenses

For every non-trivial request, evaluate all three:

- **Expand** — what would make this meaningfully more valuable without becoming a different project?
- **Hold** — what is the smallest complete version that still feels intentional and robust?
- **Reduce** — what is the absolute minimum slice that proves value or unblocks learning?

Do not treat these as brainstorming buckets. Tie each option to user value, engineering cost, and future maintenance.

### 4. Challenge Complexity Early

Flag scope as suspicious when any of these are true:

- The requested change introduces many new abstractions before validating the core behavior
- The same outcome can be reached by extending an existing flow
- The plan mixes multiple user jobs into one release
- The implementation cost is high relative to the certainty of value

Be explicit about where the bloat is coming from.

### 5. Recommend One Scope

Pick one of these and say it plainly:

- **Expand** — when the request is too literal and misses the real product opportunity
- **Hold** — when the scope is basically right and just needs discipline
- **Reduce** — when the request is overbuilt, entangled, or trying to solve too much at once

Do not hedge. Make a call and justify it.

### 6. Define the Boundary

Write down:

- What ships in this scope
- What does not ship
- What follow-up work becomes easier after this scope lands
- What risks remain even if this scope succeeds

If a follow-up idea is good but not needed now, put it in **Not now** instead of muddying the recommendation.

### 7. Hand Off Cleanly

- If the request is user-facing, hand off to `/ux-design`
- If the problem is mostly system/architecture, hand off to `/design`
- If a design already exists and only needs pressure-testing before coding, hand off to `/eng-plan-review`

## Review Standard

- Prefer simple scope over heroic execution
- Prefer one clear user outcome over a bundle of adjacent ideas
- Prefer reuse over parallel systems
- Prefer explicit trade-offs over hand-wavy optimism
- Treat deferred work as a deliberate choice, not an omission

## Example Prompts

- "We want users to upload a CSV and bulk-create records. Is this the right first version?"
- "Review this feature idea and tell me whether we're overbuilding it."
- "I have a rough PRD for notifications. Help me decide what belongs in v1."
