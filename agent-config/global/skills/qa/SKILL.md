---
name: qa
description: E2E and integration QA — derive the user flows a change affects and verify them (Playwright, HTTP, CLI) in a fix-verify loop. Use after implementation; unit tests → /tdd, /verify.
---

# QA

Verify a change works from the user's perspective — E2E, integration, browser. Not unit tests.

| Skill | Level | What |
|-------|-------|------|
| `/tdd` | Unit | Write unit tests, RED→GREEN→REFACTOR |
| `/verify` | Gate | Build + lint + unit tests + security |
| **`/qa`** | **E2E / Integration** | **Verify user flows affected by a change** |

Triggers: after implementation, before a PR, or after deploy (smoke-test critical flows).

## Stack Detection

| Marker file | Stack | Reference |
|-------------|-------|-----------|
| `package.json` + web UI present | Web/Playwright | `references/web-playwright.md` |
| `package.json` + API/server | TypeScript/Node | `references/typescript-node.md` |

Read the matching reference for stack-specific commands.

## Process

### 1. Derive affected user flows

```bash
git diff --stat main...HEAD
```

From the diff, list the user flows (concrete actions a user takes) that touch the changed code, one assertion each:
- "User signs in → sees dashboard → data loads"
- "User runs `tool deploy --env staging` → exits 0, prints the deploy URL"
- "API receives POST /items → validates → returns 201"

### 2. Verify each flow

Pick the tool by surface:
- **Web UI** → Playwright: navigate, interact, assert
- **API** → HTTP: hit real endpoints, check responses
- **CLI** → run commands, check stdout/stderr/exit codes
- **Manual** → when automation isn't practical, read code + trace logic

Mark each flow **PASS** or **FAIL** (describe what broke).

### 3. Fix-verify loop

For each failure:
1. Categorize: **real bug** / **flaky** / **environment issue**
2. Fix real bugs only — one atomic commit per fix (`fix: ...`)
3. Re-verify the affected flow
4. Loop. Exit when all flows pass OR 3 consecutive fix failures.

- Flaky → note it, don't fix here.
- Environment issue → report and stop.
- On the 3-failure stop, report the flows still unverified.

### 4. Regression check

Re-verify **all** flows (not just fixed ones) to confirm no new breakage.

## Output Format

```
QA: [PASS/FAIL]

Flows verified:
- [flow description]: PASS/FAIL
- ...

Fixes:    [N commits]
Flaky:    [list or none]
Blocked:  [environment issues or none]
```
