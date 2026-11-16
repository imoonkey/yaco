---
name: qa
description: E2E and integration QA — derive the user flows a change affects and verify them (Playwright, HTTP, CLI) in a fix-verify loop. Use after implementation; unit tests → /tdd, /verify.
---

# QA

Verify a change works from the user's perspective — E2E, integration, browser. Unit level is `/tdd` and `/verify`.

1. **Derive the affected flows** from the diff (`git diff --stat main...HEAD`) — concrete user actions, one assertion each:
   - "User signs in → sees dashboard → data loads"
   - "User runs `tool deploy --env staging` → exits 0, prints the deploy URL"
   - "API receives POST /items → validates → returns 201"
2. **Run each flow through its real surface** — Web UI → Playwright; API → real HTTP calls; CLI → run it, check stdout/stderr/exit code. Read-and-trace only when automation isn't practical.
3. **Fix what fails** — a real bug gets one atomic `fix:` commit and a re-run; flaky is noted, not fixed here; an environment issue is reported and ends the run. Three failed fixes in a row → stop and report the flows still unverified.
4. **After any fix, re-run every flow.**

| Marker file | Stack | Reference |
|-------------|-------|-----------|
| `package.json` + web UI present | Web/Playwright | `references/web-playwright.md` |
| `package.json` + API/server | TypeScript/Node | `references/typescript-node.md` |

## Report

```
QA: [PASS/FAIL]
reviewed_sha: [sha of the tree exercised]

Flows verified:
- [flow description]: PASS/FAIL

Fixes:    [N commits]
Flaky:    [list or none]
Blocked:  [environment issues or none]
```
