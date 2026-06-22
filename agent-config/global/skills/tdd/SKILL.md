---
name: tdd
description: Test-driven development. Write tests FIRST, then implement. Use for core logic, state machines, data transformations.
---

# TDD

Write tests before implementation, using the project's test framework. RED (failing test) -> GREEN (minimal code to pass) -> REFACTOR (improve, keep green).

## When to Use

| Use for | Skip for |
|---------|----------|
| State machines, orchestration | UI/browser automation (use e2e) |
| Data transformations, parsing | Simple CRUD / glue code |
| Protocol implementations | One-off scripts |
| Pure utility functions | |

## Cycle

1. Define the interface and result types first.
2. **RED** — write a failing test, run it targeted at the unit under development, confirm it fails.
3. **GREEN** — minimal code to pass.
4. **REFACTOR** — improve, keep green.

## Judgment

Tests are not equal in value — a test that mocks away the logic it claims to cover proves nothing. Aim for robustness, not a coverage number; test observable behavior, not implementation. Where a part doesn't fit TDD, don't force it.

Floor for core logic: ~80% coverage — run a coverage report and check against it.
