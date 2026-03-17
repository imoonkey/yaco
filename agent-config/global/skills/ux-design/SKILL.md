---
name: ux-design
description: Product & UX design from the user's problem. Produce a UX spec with flows as state machines. Use after `/scope-review` and before `/design` for user-facing features.
---

# UX Design

Design product experiences like Steve Jobs. Start from the problem, end with a precise spec.

## Usage

`/ux-design [goal or feature description]`

## Process

### 1. Start from the Problem

- **Who** has this problem?
- **When/where** does it happen?
- **Why** does it matter?
- What changes in user behavior or outcome if we solve it?

Do not jump to solutions. Understand the problem deeply first.

### 2. Design the Experience

- Propose the **simplest flow** that solves the problem end-to-end
- Prioritize user value, clarity, and speed
- Call out key trade-offs (power vs simplicity) and choose intentionally
- If existing requirements/opinions exist, respect them — but challenge when they hurt the user

### 3. Specify as State Machine

For each flow, describe precisely:
- **States**: what the user sees in each state
- **Transitions**: what triggers move between states
- **Guards**: conditions that must be true for a transition
- **Side effects**: what the system does on each transition
- **Edge cases**: loading, empty, error, offline, cancellation, partial failure, permissions

### 4. No Broken Windows

- No dead ends — every state has a clear next action
- No "nothing happens" — every interaction gives feedback
- Every button/component has: purpose, enabled/disabled rules, and feedback
- Consistency: copy, layout, and behavior match the rest of the product

### 5. Write UX Spec

Cover:
- **Problem** — who, what, why
- **Flow** — step-by-step with state machine notation
- **Screen/component descriptions** — what the user sees at each state
- **Edge cases** — how each failure mode is handled
- **Out of scope** — what this design intentionally does not cover

### 6. Self-Review

Re-read against the original goal:
- Does every user path lead to a clear outcome?
- Is there unnecessary complexity in the flow?
- Can any states be merged or eliminated?

If gaps exist, iterate steps 2-6.

After approval, hand off to `/design` (system), then `/eng-plan-review`, then `/implement`.
