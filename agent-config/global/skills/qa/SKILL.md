---
name: qa
description: QA testing with fix-verify loop. Run tests, fix failures, re-verify until green. Supports stack-specific test commands. Use after implementation, before commit, or when tests are failing.
---

# QA

Fix-verify loop. Run tests, fix failures, re-run until green.

## When to Use

- After implementation, before commit
- When tests are failing
- Before PR creation (after `/verify`)

## Arguments

- *(none)* — run test suite for detected stack
- `web` — browser testing via Playwright

## Stack Detection

| Marker file | Stack | Reference |
|-------------|-------|-----------|
| `package.json` | TypeScript/Node | `references/typescript-node.md` |
| `build.gradle.kts` or `build.gradle` | Kotlin/Android | `references/kotlin-android.md` |
| `/qa web` mode | Web/Playwright | `references/web-playwright.md` |

Read the matching reference file from this skill's directory for stack-specific commands.

## Fix-Verify Loop

1. **Run tests** — full suite using stack reference commands
2. **Analyze failures** — categorize each as:
   - **Real bug** — code defect causing the failure
   - **Flaky test** — intermittent, not deterministic
   - **Environment issue** — missing deps, config, services
3. **Fix real bugs only** — one atomic commit per fix (`fix: ...`)
4. **Re-run affected tests** — confirm the fix works
5. **Loop** — go to step 1. Exit when: all pass OR 3 consecutive fix failures

### Exit Conditions

- All tests pass → proceed to post-loop
- 3 consecutive fix attempts fail → stop, report remaining failures
- Environment issue detected → report and stop, don't fix

### Rules

- Each bug fix = one atomic commit
- Flaky tests: note them, don't fix in QA flow
- Environment issues: report and stop

## Post-Loop

6. **Coverage analysis** — `git diff --stat` to find changed code, identify untested paths
7. **Write missing tests** — for changed code lacking coverage
8. **Final full test run** — confirm everything passes

## Output Format

```
QA: [PASS/FAIL]

Tests:    [X/Y passed]
Fixes:    [N commits]
Flaky:    [list or none]
Coverage: [gaps or OK]

Issues:
1. ...
```
