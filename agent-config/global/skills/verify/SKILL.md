---
name: verify
description: Run verification loop (build, lint, test, security) before commits. Use before any commit or PR, or after significant changes. Detects project stack automatically.
---

# Verify

Pre-commit quality gates: build, lint, unit tests, security. For E2E/integration testing of user flows, use `/qa`.

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
2. **Lint** — static analysis; errors block, warnings are acceptable
3. **Tests** — run test suite
4. **Security Scan** — check for hardcoded keys/secrets
5. **Git Status** — `git diff --stat`

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
