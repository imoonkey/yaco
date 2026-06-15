---
name: qa
description: E2E and integration QA — derive the user flows a change affects and verify them (Playwright, HTTP, CLI) in a fix-verify loop. Use after implementation; unit tests → /tdd, /verify.
---

# QA

Verify changes work from the user's perspective. Integration tests, E2E, browser tests — not unit tests.

## Scope

| Skill | Level | What |
|-------|-------|------|
| `/tdd` | Unit | Write unit tests, RED→GREEN→REFACTOR |
| `/verify` | Gate | Build + lint + unit tests + security |
| **`/qa`** | **E2E / Integration** | **Verify user flows affected by changes** |

## When to Use

- After implementation — validate the feature actually works end-to-end
- Before PR — confirm no user-facing regressions
- After deploy — smoke test critical flows

## Stack Detection

| Marker file | Stack | Reference |
|-------------|-------|-----------|
| `package.json` + web UI present | Web/Playwright | `references/web-playwright.md` |
| `package.json` + API/server | TypeScript/Node | `references/typescript-node.md` |
| `build.gradle.kts` or `build.gradle` | Kotlin/Android | `references/kotlin-android.md` |

Read the matching reference file from this skill's directory for stack-specific commands.

## Process

### 1. Analyze Changes

```bash
git diff --stat main...HEAD
```

Identify: what files changed, what features they touch, what user-facing behavior is affected.

### 2. Derive Affected User Flows

List the user flows (actions a user would take) that touch the changed code. Examples:
- "User signs in → sees dashboard → data loads"
- "User runs `tool deploy --env staging` → exits 0, prints the deploy URL"
- "API receives POST /items → validates → returns 201"

### 3. Verify Each Flow

Use stack-appropriate tools from the reference file:
- **Web UI** → Playwright: navigate, interact, assert
- **API** → HTTP calls: hit real endpoints, check responses
- **CLI** → Run commands, check stdout/stderr/exit codes
- **Manual check** → When automation isn't practical, read code + trace logic

For each flow: **PASS** (works as expected) or **FAIL** (describe what broke).

### 4. Fix-Verify Loop

For each failure:
1. Categorize: **real bug** / **flaky** / **environment issue**
2. Fix real bugs only — one atomic commit per fix (`fix: ...`)
3. Re-verify the affected flow
4. Loop. Exit when: all flows pass OR 3 consecutive fix failures

**Rules:**
- Flaky: note it, don't fix in QA
- Environment issue: report and stop
- Max 3 consecutive failures → stop, report remaining

### 5. Regression Check

Re-verify all flows (not just the fixed ones) to confirm no regressions.

## Output Format

```
QA: [PASS/FAIL]

Flows verified:
- [flow description]: PASS/FAIL
- ...

Fixes:    [N commits]
Flaky:    [list or none]
Blocked:  [environment issues or none]```
