---
name: eng-plan-review
description: Review an implementation plan before coding — for work that touches multiple files, changes data flow or state, or adds integrations. Use after `/design` or on any rough plan.
---

# Engineering Plan Review

Review a proposed implementation plan before writing code.

The job is to make the plan tighter, safer, and easier to execute. Do not jump into implementation. First make sure the plan is worth implementing.

## Usage

`/eng-plan-review [design doc, implementation plan, or task description]`

## Output

Always produce these sections:

- **Plan summary** — what is being built and what success means
- **What already exists** — current code or flows that should be reused
- **Findings** — concrete risks, ambiguities, or over-engineered parts
- **Test plan** — the new flows and failures that must be verified
- **Not in scope** — work intentionally deferred
- **Next step** — what should happen before implementation starts

## Process

### 1. Gather Real Context

- Read the plan or design doc first
- Read the relevant code in the affected area
- Read nearby docs and TODOs if they change the review
- Identify the existing abstractions, boundaries, and tests

Review the plan against the real codebase, not against the plan in isolation.

### 2. Run a Scope Sanity Check

Before deeper review, answer:

- What existing code already solves part of this?
- What is the minimum diff that achieves the goal?
- Is the plan introducing too many files, classes, or layers for the value it delivers?
- Can any work move to a follow-up without weakening the core outcome?

If the plan is fundamentally too large or misframed, say so early.

### 3. Review the Core Design

Evaluate:

- Component boundaries
- Data flow
- State transitions
- Trust boundaries
- Failure handling
- Deployment and rollback posture

Prefer simple flows that turn edge cases into canonical cases. Flag plans that create clever abstractions without enough payoff.

### 4. Review Operational Quality

Check whether the plan is explicit about:

- Validation at external boundaries
- Error handling and user-visible failure states
- Logging, metrics, or trace points where new behavior matters
- Concurrency or ordering risks
- Security assumptions

Do not accept "handle errors" as a plan. Name the actual failure modes.

### 5. Review Testability

Make a concrete test plan, not a vague request for "more tests."

For each new or changed flow, identify:

- Happy path
- Edge cases
- Failure paths
- State transitions
- Integration points

Require tests that match the actual risk. For core logic, prefer `/tdd`. For user-facing flows, call out end-to-end verification needs explicitly.

### 6. Call Out Decision Gaps

Separate:

- **Must decide before implementation**
- **Can be decided during implementation**
- **Should be deferred**

Only raise questions that materially change the build. Avoid noisy nits.

### 7. End with a Verdict

State a clear verdict and the reason:

- **Ready** — the plan is sound enough to start building.
- **Send back** — name which earlier stage must redo work (scope, UX, or system design) and why.

Report the verdict; let the caller decide what runs next.

## Review Standard

- Minimal diff over sprawling architecture
- Explicit trade-offs over vague confidence
- Reuse over reinvention
- Concrete failure modes over generic caution
- Testable plans over aspirational plans
