---
name: verify
description: Run verification loop (build, lint, test, security) before commits. Use before any commit or PR. Detects project stack automatically.
---

# Verify

Pre-commit quality gates. Detects the project stack and runs the appropriate commands.

## When to Use

- Before commits
- After significant changes
- Before PR creation

## Arguments

- `quick` — build + lint + unit tests
- `full` — all checks (default)

## Stack Detection

| Marker file | Stack | Reference |
|-------------|-------|-----------|
| `build.gradle.kts` or `build.gradle` | Kotlin/Android | `references/kotlin-android.md` |
| `package.json` | TypeScript/Node | `references/typescript-node.md` |

Read the matching reference file from this skill's directory for stack-specific commands.

## Verification Phases

Run these phases in order. If any phase fails, STOP and report errors.

1. **Build** — compile/typecheck
2. **Lint** — static analysis
3. **Tests** — run test suite
4. **Security Scan** — check for hardcoded keys/secrets
5. **Code Quality** — check for files >400 lines
6. **Git Status** — `git diff --stat`

The reference file provides the exact commands for each phase.

## Output Format

```
VERIFICATION: [PASS/FAIL]

Build:    [OK/FAIL]
Lint:     [OK/X warnings]
Tests:    [X/Y passed]
Security: [OK/X issues]

Ready for commit: [YES/NO]

Issues:
1. ...
```

## Quality Thresholds

- Build: Must pass
- Lint: No errors (warnings acceptable)
- Tests: All must pass
- Security: No hardcoded secrets
