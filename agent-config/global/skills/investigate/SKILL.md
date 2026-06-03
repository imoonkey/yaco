---
name: investigate
description: Systematic debugging with root cause investigation. Use when debugging, investigating bugs, or tracing errors. Use before fixing any non-trivial bug.
---

# Investigate

Disciplined debugging. No guessing, no premature fixes.

## Core Rule

Phases 1-3 are INVESTIGATION ONLY — no code changes allowed.

## Phases

### 1. Reproduce & Gather Evidence

Reproduce the bug. Collect logs, traces, stack traces, repro steps. Define expected vs actual behavior.

### 2. Form Hypotheses

List 1-3 hypotheses ranked by likelihood. Each hypothesis MUST cite specific evidence (log line, stack frame, state value). No evidence = not a hypothesis.

### 3. Test Hypotheses

Add temporary logging, inspect state, trace execution paths. Confirm or eliminate each hypothesis. Still NO fixes.

### 4. Fix Root Cause

Fix the CONFIRMED root cause only. One atomic commit per fix. Remove temporary debug instrumentation. If the fix is complicated, then follow /implement skill steps.

### 5. Validate

Verify fix resolves the original repro. Verify no regressions (run related tests). If fix fails, return to Phase 2.

## Hard Limits

- **Max 3 fix attempts.** If all fail, stop and report: what was tried, what was learned, what remains unknown.
- **Every hypothesis needs evidence.** "Maybe it's X" is not investigation.
- **Done = root cause identified + fix verified.** "Seems to work" is not done.
