---
name: design
description: System design from first principles. Produce a design doc, self-review, iterate. Use before /implement for non-trivial work.
---

# Design

Architect a system or feature before implementation. Output is a design doc.

## Usage

`/design [goal or task description]`

## Process

### 1. Understand the Problem

- What is the real problem? (not just the stated one)
- What are the constraints?
- What does success look like?

### 2. Study the Codebase

- Read existing code in the affected area
- Understand current patterns, abstractions, data flow
- Identify what can be reused vs. what needs to change

### 3. Design from First Principles

Use `/ultra-think` for critical decisions.

- Question assumptions — why does it have to work that way?
- Start from the simplest design that fully solves the problem
- Prefer designs that turn edge cases into canonical cases
- Specify key interactions as state machines where applicable (states, transitions, guards, side effects)
- No broken windows: no dead ends, no ambiguous states, no undefined behavior

### 4. Write Design Doc

Write to the project's doc folder (or wherever the project convention is).

Cover:
- **Goal** — what we're solving and why
- **Approach** — key design decisions and rationale
- **Components** — what changes, what's new, what's removed
- **Interactions** — how components connect, data flow, state transitions
- **Trade-offs** — what alternatives were considered, why this approach wins

Keep it concise. The doc should be readable in 5 minutes.

### 5. Self-Review

Re-read the design against the original goal. Check:
- Does it fully cover the goal? Any gaps?
- Is there unnecessary complexity that can be removed?
- Are edge cases handled through design, not special-casing?

If gaps exist, iterate steps 3-5.

### 6. Ready for Review

Present the design doc for review (human or `/code-review`).
After approval, proceed to `/implement`.
