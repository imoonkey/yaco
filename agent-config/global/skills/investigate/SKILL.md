---
name: investigate
description: Systematic debugging with root cause investigation. Use when debugging, investigating bugs, or tracing errors. Use before fixing any non-trivial bug.
---

# Investigate

Phases 1-3 are INVESTIGATION ONLY — no code changes until the root cause is confirmed.

## Phases

1. **Reproduce & gather evidence.** Reproduce it. Define expected vs actual. Collect logs, traces, stack traces, repro steps.
2. **Form hypotheses.** Rank 1-3 by likelihood. Each MUST cite specific evidence (log line, stack frame, state value) — "maybe it's X" with no evidence is not a hypothesis.
3. **Test hypotheses.** Add temporary logging, inspect state, trace execution paths. Confirm or eliminate each. Still no fixes.
4. **Fix the root cause.** Fix only the confirmed cause, one atomic commit. Remove the debug instrumentation. If the fix is non-trivial, run a full plan → build → verify.
5. **Validate.** Confirm the original repro is gone and related tests pass. On failure, return to phase 2.

## Hard limits

- **Max 3 fix attempts.** If all fail, stop and report: what was tried, what was learned, what remains unknown.
- **Done = root cause identified + fix verified.** "Seems to work" is not done.
