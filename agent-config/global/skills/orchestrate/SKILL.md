---
name: orchestrate
description: Sequential agent workflow for complex tasks. Chains agents together with structured handoffs.
---

# Orchestrate

Sequential skill workflow for complex tasks. Chains skills together with structured handoffs.

## Usage

`/orchestrate [workflow-type] [task-description]`

## Workflow Types

### feature
Full feature implementation:
```
plan -> tdd -> code-review -> verify
```

### bugfix
Bug investigation and fix:
```
build-fix -> code-review -> verify
```

### refactor
Safe refactoring workflow:
```
plan -> code-review -> tdd -> verify
```

## Execution Pattern

For each step in the workflow:

1. **Invoke skill** with context from previous step
2. **Collect output** as structured handoff document
3. **Pass to next** in chain
4. **Aggregate results** into final report

## Handoff Document Format

Between steps, create handoff document:

```markdown
## HANDOFF: [previous] -> [next]

### Context
[Summary of what was done]

### Findings
[Key discoveries or decisions]

### Files Modified
[List of files touched]

### Open Questions
[Unresolved items for next step]

### Recommendations
[Suggested next steps]
```

## Example: Feature Workflow

```
/orchestrate feature "Add retry logic"
```

Executes:

1. **Plan** (`/plan`)
   - Analyzes requirements
   - Creates implementation plan
   - Identifies affected files
   - Output: `HANDOFF: plan -> tdd`

2. **TDD** (`/tdd`)
   - Writes tests first
   - Implements to pass tests
   - Output: `HANDOFF: tdd -> code-review`

3. **Code Review** (`/code-review`)
   - Reviews implementation
   - Checks for issues
   - Output: `HANDOFF: code-review -> verify`

4. **Verify** (`/verify`)
   - Runs build, lint, tests
   - Security scan
   - Output: Final Report

## Final Report Format

```
ORCHESTRATION REPORT
====================
Workflow: [type]
Task: [description]
Steps: [step1] -> [step2] -> ...

SUMMARY
-------
[One paragraph summary]

STEP OUTPUTS
------------
Plan: [summary]
TDD: [tests written, coverage]
Code Review: [findings by severity]
Verify: [pass/fail status]

FILES CHANGED
-------------
[List all files modified]

TEST RESULTS
------------
[Test pass/fail summary]

RECOMMENDATION
--------------
[SHIP / NEEDS WORK / BLOCKED]
```

## Custom Workflow

```
/orchestrate custom "plan,tdd,verify" "Add new feature"
```

Specify custom sequence of skills to chain together.

## Available Skills for Chaining

| Skill | Purpose |
|-------|---------|
| `plan` | Structured planning |
| `tdd` | Test-driven development |
| `code-review` | Systematic review |
| `verify` | Pre-commit quality gates |
| `build-fix` | Fix build errors |

Project-specific skills can also be chained if available in the project's `.claude/skills/`.

## Tips

1. **Start with plan** for complex features
2. **Always end with verify** before commit
3. **Keep handoffs concise** - focus on what next step needs
4. **Run verify between steps** if needed for confidence
