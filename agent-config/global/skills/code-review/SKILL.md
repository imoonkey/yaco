---
name: code-review
description: Systematic code review with severity-based findings. Use before merging or when reviewing changes.
---

# Code Review

Hunt for logic holes, design-principle violations, hidden risks, and redundancy — not local readability.

Load `/simplify-code-arch` (**MUST USE**) — its gates and smell table define the design bar: speculative structure, shallow layers, wrong-altitude params are findings, not style nits.

**Severity is what leaving the issue would cost *this* code.** The table is calibrated for code that ships; in a demo or prototype only a wrong result or needless structure rises above Low. Defensive code for cases that cannot occur is a finding, never a fix to ask for.

| Level | Includes |
|-------|----------|
| **Critical** (must fix) | Secrets / injection / leaks; unhandled crashes, null derefs; data loss, state corruption, race conditions |
| **High** (should fix) | Correctness bugs; spaghetti or confusing logic, significant duplication; significant inefficiency; resource leaks (memory, handles, connections); missing validation at system boundaries |
| **Medium** (consider) | Hard-to-read logic, moderate duplication; missing tests (even if preflight passes); oversized files/functions; poor naming |
| **Low** (nice-to-have) | Style consistency; doc gaps; minor optimizations |

Fix small issues inline; flag big ones. Project docs are context; code is source-of-truth.

Report what changed, the findings by severity (each: why · where · fix), and a verdict — `APPROVE` or `CHANGES_REQUESTED`.
