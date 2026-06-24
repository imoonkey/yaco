---
name: verify
description: Run verification loop (build, lint, test, security) before commits. Use before any commit or PR, or after significant changes. Detects project stack automatically.
---

# Verify

Pre-commit quality gates: build, lint, unit tests, security. For E2E/integration testing of user flows, use `/qa`.

## Arguments

- `quick` — build + lint + unit tests
- `full` — all checks (default)

## Execution

The single entry is the repo's **`scripts/verify.sh`** — run it and read its result.
It chains this repo's build · lint · test · security in a fixed order, stops at the
first failing step and names it, and is the **source of truth**: `/verify`, `yaco
gate`, and any hook all run the identical checks. Don't re-copy per-stack commands
here — defer to the script.

The Stack Detection and Verification Phases below are a **guide** to what
`scripts/verify.sh` covers. Use them to run the checks by hand only when a repo has
no such script (and consider adding one).

## Stack Detection

| Marker file | Stack | Reference |
|-------------|-------|-----------|
| `build.gradle.kts` or `build.gradle` | Kotlin/Android | `references/kotlin-android.md` |
| `package.json` | TypeScript/Node | `references/typescript-node.md` |

The matching reference describes what each phase covers for that stack.

## Verification Phases

`scripts/verify.sh` runs these in order; if any fails it stops and reports the
failing step. Without a script, run them yourself per the stack reference.

1. **Build** — compile/typecheck
2. **Lint** — static analysis; errors block, warnings are acceptable
3. **Tests** — run test suite
4. **Security Scan** — check for hardcoded keys/secrets
5. **Git Status** — `git diff --stat`

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
