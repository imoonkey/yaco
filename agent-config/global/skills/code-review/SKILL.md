---
name: code-review
description: Systematic code review with severity-based findings. Use before merging or when reviewing changes.
---

# Code Review

Systematic review process with high standards.

## Guidelines
Analyze the code changes based on the following pillars:

*   **Correctness**: Does the code achieve its stated purpose without bugs or logical errors?
*   **Maintainability**: Is the code clean, well-structured, and easy to understand and modify in the future? Consider factors like code clarity, modularity, and adherence to established design patterns.
*   **Readability**: Is the code well-commented (where necessary) and consistently formatted according to our project's coding style guidelines?
*   **Efficiency**: Are there any obvious performance bottlenecks or resource inefficiencies introduced by the changes?
*   **Security**: Are there any potential security vulnerabilities or insecure coding practices?
*   **Edge Cases and Error Handling**: Does the code appropriately handle edge cases and potential errors?
*   **Testability**: Is the new or modified code adequately covered by tests (even if preflight checks pass)? Suggest additional test cases that would improve coverage or robustness.

## Review Mindset

High standards like kernel code. Find:
- Logic holes
- Design principle violations
- Risks and bugs
- Redundancies

## Process

1. **Get context**
   ```bash
   git diff --stat
   git log -3 --oneline
   ```

2. **Review changes** against checklist

3. **Document findings** by severity

4. **Fix small issues** inline

5. **Create design docs** for big issues

## Severity Levels

### Critical (Must Fix)
- Security: secrets, injection, leaks
- Crashes: unhandled exceptions, null dereferences
- Data loss: state corruption, race conditions

### High (Should Fix)
- Correctness: errors / bugs
- Maintainability: spaghetti code, confusing logic, significant code duplication
- Efficiency: significant efficiency issues
- Resource leaks (memory, handles, connections)
- Missing validation at system boundaries

### Medium (Consider)
- Readability: hard to read logic, moderate code duplication
- Missing tests
- Large files/functions
- Poor naming

### Low (Nice-to-Have)
- Style consistency
- Documentation gaps
- Minor optimizations

## Output Format

```markdown
# Review: [scope]

## Summary
[What changed]

## Critical
1. [Issue]: [why + where + fix]

## High
1. [Issue]: [why + where + fix]

## Medium
...

## Recommendation
[APPROVE / CHANGES_REQUESTED]
```

## Workstream Integration

When working inside a `doc/todo/<name>/` folder that has a `workstream.json`, follow `/workstream update` protocol:

- **After the full review completes** (Steps 3-5 — document findings, fix small issues, create design docs for big issues): append a `human_review` entry to `progress.json` summarizing findings (e.g., "Code review complete — 1 critical, 2 high, 1 medium finding."). Set workstream status to `human_review`.
- **If blocked**: set workstream status to `blocked`, append a `blocked` entry, and stop.

## Reference

- Treat project docs as context (code is source-of-truth)
- Update docs after fixing issues
