---
name: tdd
description: Test-driven development. Write tests FIRST, then implement. Use for core logic, state machines, data transformations.
---

# TDD

Test-driven development for core logic. Use the project's test framework and conventions.

## When to Use

**Best for:**
- State machines, orchestration logic
- Data transformations, parsing
- Protocol implementations
- Pure utility functions

**Skip for:**
- UI/browser automation (e2e better)
- Simple CRUD / glue code
- One-off scripts

## TDD Cycle

```
RED -> GREEN -> REFACTOR

1. Write failing test
2. Implement minimal code to pass
3. Refactor, keep tests green
```

## Workflow

### 1. Define Types

Define the interface and result types before writing any implementation.

### 2. Write Tests (RED)

Some tests matter much more than others, some tests no longer make sense because they mock too much. Your goal is to improve system robustness, stability and scalability, not to just hit a test coverage number. If some parts are not suitable for TDD, then do not forcefully follow this process.

### 3. Run Tests (Should Fail)

Run targeted tests for the file/class under development.

### 4. Implement (GREEN)

Write minimal code to pass.

### 5. Refactor

Keep tests green while improving code.

### 6. Verify Coverage

Run coverage report and check results.

## Test Structure (AAA)

Follow Arrange-Act-Assert pattern:

```
// Arrange
setup test data and dependencies

// Act
call the function under test

// Assert
verify the result
```

## Coverage Target

- 80% minimum for core logic
- Test behavior, not implementation
