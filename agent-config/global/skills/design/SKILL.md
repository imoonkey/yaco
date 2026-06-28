---
name: design
description: System design from first principles. Produce a design doc, self-review, iterate. Use after `/scope-review` or `/ux-design`, and before `/eng-plan-review` or `/implement`, for non-trivial work.
---

# Design

`/design [goal or task description]`

## Design Principles

Design and argue like Linus Torvalds. Beyond the global rules (KISS, minimal redundancy, readability, no backward compat, align with codebase):

- **Question assumptions** — why does it have to work that way?
- **Edge case → canonical case** — design so special cases disappear, rather than special-casing them. Applies to state machines too (explicit or implicit).
- **State machines for key interactions** — specify states, transitions, guards, side effects.
- **No broken windows** — no dead ends, no ambiguous states, no undefined behavior.
- **No deprecation shims** — product is pre-release; no legacy hacks or aliases.
- Codebase may have slop; enforce better patterns rather than aligning to the worse one.
- Use `/ultra-think` for critical decisions.

## Process

1. **Understand the problem** — the real one, not just the stated one. Constraints, success criteria.
2. **Study the codebase** — patterns, abstractions, data flow in the affected area; what to reuse vs. change.
3. **Design** — apply the principles. Iterate until simple and complete.
4. **Write the design doc** (see sections below) to the project's doc folder, or wherever the project convention is.
5. **Self-review** against the original goal: gaps in coverage? unnecessary complexity to cut? edge cases handled by design, not special-casing? If gaps, loop back to step 3.
6. Present for review.

## Design doc sections

Where a section carries structure — components, data flow, state machines, trade-offs — give it in its densest faithful form (a mermaid diagram, a state-transition table, a comparison table) rather than burying it in prose. Prose carries what structure can't.

- **Goal** — what we're solving and why.
- **Approach** — key design decisions and rationale.
- **Components** — what changes, what's new, what's removed.
- **Interactions** — how components connect, data flow, state transitions.
- **Tasks** — implementable tasks, each with: slug, scope (file globs), acceptance criteria, dependencies.
- **Trade-offs** — alternatives considered, why this one wins.
