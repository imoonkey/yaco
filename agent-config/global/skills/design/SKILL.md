---
name: design
description: System design from first principles. Produce a design doc, self-review, iterate. Use after `/scope-review` or `/ux-design`, and before `/eng-plan-review` or `/implement`, for non-trivial work.
metadata:
  yaco-dependent: "optional"
---

# Design

Architect a system or feature before implementation. Output is a design doc.

## Usage

`/design [goal or task description]`

## Design Principles

Write and discuss the design like Linus Torvalds would.

- **KISS** — keep it simple, stupid. Avoid over-design and over-engineering. Minimal nesting depth.
- **Minimal redundancy** — if simpler logic achieves the same result, use it. Turn edge cases into canonical cases through smart design rather than special-casing. Simplify state machines the same way, explicit or implict.
- **High readability** — code should be self-evident
- **No backward compatibility** — code reflects the latest, best implementation only. No legacy hacks, no deprecation shims. Product is pre-release.
- **Align with codebase** — read existing code first, make sure your design is aligned. DRY and don't reinvent wheels, but old codebase could have slops, don't refrain from enforcing better patterns.
- Question assumptions — why does it have to work that way?
- Prefer designs that turn edge cases into canonical cases
- Specify key interactions as state machines where applicable (states, transitions, guards, side effects)
- No broken windows: no dead ends, no ambiguous states, no undefined behavior
- Use `/ultra-think` for critical decisions

## Process

### 1. Understand the Problem

- What is the real problem? (not just the stated one)
- What are the constraints?
- What does success look like?

### 2. Study the Codebase

- Read existing code in the affected area
- Understand current patterns, abstractions, data flow
- Identify what can be reused vs. what needs to change

### 3. Design

Apply the principles above. Iterate until the design is simple and complete.

### 4. Write Design Doc

Write to the project's doc folder (or wherever the project convention is).

Cover:
- **Goal** — what we're solving and why
- **Approach** — key design decisions and rationale
- **Components** — what changes, what's new, what's removed
- **Interactions** — how components connect, data flow, state transitions
- **Tasks** — break the design into implementable tasks. Each task: slug, scope (file globs), acceptance criteria, dependencies. This section feeds `/update-tasks` to populate the task graph.
- **Trade-offs** — what alternatives were considered, why this approach wins

Keep it concise. The doc should be readable in 5 minutes.

### 5. Self-Review

Re-read the design against the original goal. Check:
- Does it fully cover the goal? Any gaps?
- Is there unnecessary complexity that can be removed?
- Are edge cases handled through design, not special-casing?

If gaps exist, iterate steps 3-5.

### 6. Ready for Review

Present the design doc for review (human or `/eng-plan-review`).
After approval, use `/update-tasks` to create the task graph from the Tasks section, then proceed to `/implement` or `/orchestrate`.

## YACO compatibility

Inside a YACO project (cwd registered in `~/.yaco/projects.json`, with optional
`yaco.toml` path overrides), write the design doc under
`projects/active/<project>/*_[codex|claude].md` (or
`projects/active/<project>/individual/*_[claude|codex].md` when running under
`/double-design`); surface its Tasks section through `/update-tasks` (which
writes `projects/tasks.json`); hand execution off to `/orchestrate`, which
dispatches `yaco agent` workers with session state under `~/.yaco/sessions/`.
Outside YACO, follow the project's own design-doc convention.
